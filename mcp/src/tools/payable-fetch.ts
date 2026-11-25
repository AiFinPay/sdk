import {
  Aifp1SettlementUnsupportedError,
  Aifp1FinalizedFailureError,
  Aifp1GatewayRetiredError,
  Aifp1MerchantChangedError,
  assertPreparedV14Recovery,
  parseGatewayUrl,
  type Aifp1CachedReceipt,
  type Aifp1FlowEvent,
  type V14SettlementCall,
  type Aifp1PaymentRecovery,
} from "@aifinpay/agent";
import type { ToolContext } from "../server.js";
import { optionGasCap, payOptions, validatePaymentConfig, type PayOption } from "../config.js";
import { PaymentStateError, type PaymentState } from "../payment-state.js";
import { independentNativeUsd } from "../native-price.js";
import { PAY_CHAINS, payChain, type PayChain } from "../pay-chains.js";
import { SMALLEST_BATCH_USD, paymentSetupStatus } from "./payment-setup-status.js";
import { assertVerifiedMerchantSite, readMerchant, UnverifiedMerchantSiteError } from "../merchant-site.js";
import { chooseOption, forgetBalances, formatUnits, readOptions, rpcFor, type OptionState } from "../pay-options.js";
import { errorClass, MCP_TOKEN, MCP_USER_AGENT, track, usdBucket } from "../telemetry.js";

// "prefix" is left out on purpose: it needs a resource to anchor to, and the
// owner's two real requests are "this endpoint" and "this site".
const SCOPES = ["exact", "merchant"] as const;
type PayableScope = (typeof SCOPES)[number];
// Real ids are "mrch_" plus hex. A 402's merchant id is unauthenticated, so
// only an id this plain is ever repeated to the model.
const MERCHANT_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
// The hosted gateway addresses merchants by slug; every other origin is a site
// running its own paywall, whose AIFP-1 resource is the full request path.
const HOSTED_GATEWAY_ORIGIN = "https://gateway.aifinpay.io";
const API_ORIGIN = "https://api.aifinpay.io";
// AIFP-License as the gates send it with content a receipt unlocked.
const LICENSE_HEADER =
  /^id=(clic_[A-Za-z0-9_-]{1,64}); rev=([1-9][0-9]{0,8}); sha256=([0-9a-f]{64}); url="([^"\s]{1,500})"$/;
const LICENSE_PATH = /^\/v1\/merchants\/([A-Za-z0-9_.:-]{1,64})\/license\/([1-9][0-9]{0,8})$/;
const LICENSE_NOTICE =
  "This content was sold under this licence. Use it only as its terms allow; the licence text at text_url governs.";
const licenseBlocks = new Map<string, Record<string, unknown>>();

export function payableFetchTool() {
  return {
    name: "payable_fetch",
    description:
      'Fetch a GET resource from an AiFinPay merchant, paying its AIFP-1 402 when needed. Always listed: until a persistent wallet exists (npx @aifinpay/mcp init, then agent_reload) it signs nothing and returns the payment_setup_status checklist with the one next step. Payments are on by default within a built-in ceiling of $5 per payment and $20 per 24 hours (the owner can only lower it in env; the working limits are the dashboard Controls after agent_claim_self) and only ever reach a merchant registered with AiFinPay, through a quote signed by the AiFinPay backend; a 402 never chooses who is paid. Without AIFINPAY_GATEWAY_ORIGINS it pays only a merchant whose site AiFinPay reports as DNS-verified, on that very site (or through the AiFinPay hosted gateway); with it, only the origins the owner listed; AIFINPAY_PAYMENTS_ENABLED=0 turns payments off.  Buys a prepaid batch through verified v1.4 on the chain the owner set in AIFINPAY_PAY_CHAIN (Polygon by default; other supported networks require explicit owner selection) — with what the wallet holds: the pinned stablecoins of that chain first, then its native coin (POL, ETH, AVAX, BNB or XRP), or only the options the owner listed in AIFINPAY_PAY_OPTIONS, in that order, or only AIFINPAY_PAY_ASSET (Solana: SOL or AIFINPAY_PAY_ASSET); gas is native, on Arc USDC. The answer names paid_with. Within owner limits, then reuses its receipt. With scope "merchant" one batch covers every path on the site. When the merchant sells under a content licence, the paid result carries `license` (id, terms, text_url): use the content only as it allows. Pending payments are recovered without sending another transaction. Other payment protocols are unsupported. The price is the AIFP-1 402 of this exact URL, not the merchant\'s website plans; if the endpoint is not known, ask the user for it instead of browsing the site.',
    inputSchema: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description:
            "HTTPS resource to fetch. Without AIFINPAY_GATEWAY_ORIGINS, payment goes only to a merchant that verified this site with AiFinPay; with it, only to the origins the owner listed.",
        },
        max_amount_usd: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Optional tighter per-payment USD limit; cannot increase the owner's cap.",
        },
        scope: {
          type: "string",
          enum: [...SCOPES],
          description:
            'What a new batch covers. "exact" (default): this one resource. "merchant": every path on this site — use it when the owner asked for access to the site; each request still costs its own listed price. Does not change the price or the owner limits.',
        },
        expected_merchant_id: {
          type: "string",
          pattern: MERCHANT_ID.source,
          description:
            "Optional merchant id (e.g. mrch_…) this call may pay; a site answering as any other merchant is refused before quoting. Paying re-pins the site to it. Set it only to a merchant the owner confirmed, e.g. after this tool reported that a site changed merchant.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
  };
}

/** Never expose bearer receipts, raw signed transactions, or exception response bodies. */
export async function runPayableFetch(ctx: ToolContext, args: Record<string, unknown>) {
  let state: PaymentState | undefined;
  let chain: PayChain | undefined;
  let paying: { chain: PayChain; asset: string } | undefined;
  // Where a paid fetch stopped, for telemetry only; unset outside a purchase.
  let stage: string | undefined;
  // Status of a quote or pay refusal the SDK reported, for telemetry only.
  let refusedStatus: number | undefined;
  try {
    const store = ctx.paymentState;
    // Not set up: say exactly what is missing instead of refusing in one line.
    // Nothing below runs, so nothing is quoted, signed or sent. The journal
    // exists only for the persistent wallet the server started with.
    if (!ctx.config.paymentsEnabled || !store || store.address !== ctx.agent.evmAddress.toLowerCase()) {
      track("aifp1_pay_failed", { stage: "setup" });
      const status = await paymentSetupStatus(ctx, { readBalance: false });
      return errorResult(
        JSON.stringify({ error: "payable_fetch is not set up yet; nothing was signed or paid.", ...status }, null, 2)
      );
    }
    let feeCap: bigint;
    let options: PayOption[];
    try {
      feeCap = validatePaymentConfig(ctx.config);
      chain = payChain(ctx.config.payChain);
      options = payOptions(ctx.config);
    } catch (error) {
      track("aifp1_pay_failed", { stage: "setup", error_class: errorClass(error) });
      return errorResult((error as Error).message);
    }
    if (Object.keys(args).some((k) => !["url", "max_amount_usd", "scope", "expected_merchant_id"].includes(k)))
      return errorResult(
        "Only url, max_amount_usd, scope and expected_merchant_id are supported; no facilitator fallback."
      );
    if (typeof args.url !== "string") return errorResult("url must be an HTTPS resource URL.");
    if (args.scope !== undefined && !SCOPES.includes(args.scope as PayableScope))
      return errorResult('scope must be "exact" or "merchant".');
    const scope: PayableScope = (args.scope as PayableScope | undefined) ?? "exact";
    const expectedMerchantId = args.expected_merchant_id;
    if (
      expectedMerchantId !== undefined &&
      (typeof expectedMerchantId !== "string" || !MERCHANT_ID.test(expectedMerchantId))
    )
      return errorResult("expected_merchant_id must be a merchant id such as mrch_0123abcd.");
    const url = new URL(args.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      return errorResult("The URL must be an https resource without credentials or fragment.");
    // Unset, the allowlist is the origin of this very URL: whoever answers its
    // 402 is still only paid if the AiFinPay backend quotes them as a
    // registered merchant. Set, it is the owner's word on which sites may be
    // paid at all, and the agent cannot add to it: a page asking to be paid is
    // not the owner asking to pay it. Name the origin so the owner can decide.
    const origins = ctx.config.gatewayOrigins ?? [url.origin];
    if (!origins.includes(url.origin)) {
      track("budget_cap_exceeded", { stage: "site" });
      return errorResult(
        `${url.origin} is not an owner-approved site. Nothing was paid. The owner can add it to AIFINPAY_GATEWAY_ORIGINS and reconnect this server; the agent cannot approve a site itself.`
      );
    }
    const pathMode = ctx.config.gatewayPathMode ?? (url.origin === HOSTED_GATEWAY_ORIGIN ? "gateway" : "direct");
    if (
      args.max_amount_usd !== undefined &&
      (typeof args.max_amount_usd !== "number" || !Number.isFinite(args.max_amount_usd) || args.max_amount_usd <= 0)
    )
      return errorResult("max_amount_usd must be a positive finite amount.");
    const maximum = Math.min(
      ctx.config.maxAmountUsd!,
      typeof args.max_amount_usd === "number" ? args.max_amount_usd : Infinity
    );
    const parsed = parseGatewayUrl(url.href, origins, pathMode);
    const selected = chain;
    const solana = selected.name === "solana";
    return await store.exclusive(async () => {
      state = store.read();
      for (const entry of ctx.agent.aifp1Receipts.list()) ctx.agent.aifp1Receipts.evict(entry);
      for (const entry of state.receipts) ctx.agent.aifp1Receipts.put(entry);
      const reconcileFinalizedFailure = (error: unknown): boolean => {
        if (!(error instanceof Aifp1FinalizedFailureError)) return false;
        const pending = state!.pending;
        const recovery = error.recovery;
        if (
          !pending ||
          pending.recovery.family !== "solana" ||
          recovery?.family !== "solana" ||
          JSON.stringify(recovery) !== JSON.stringify(pending.recovery) ||
          pending.amountUsd !== recovery.reservedAmountUsd ||
          !Number.isFinite(error.feeAmountUsd) ||
          error.feeAmountUsd < 0 ||
          error.feeAmountUsd > pending.amountUsd ||
          typeof error.actualFeeLamports !== "bigint" ||
          error.actualFeeLamports < 0n
        )
          throw new Error("Finalized failure does not match the pending payment");
        const entries = state!.spend.filter((entry) => entry.tx === recovery.txRef);
        if (entries.length !== 1 || entries[0].failure || entries[0].usd !== pending.amountUsd)
          throw new Error("Finalized failure does not match the original debit");
        // Only the SDK's exact canonical proof and durable ledger reconciliation
        // can produce this terminal outcome. Persist our fee debit and removal
        // of the pending guard together; never retry the purchase in this call.
        entries[0].usd = error.feeAmountUsd;
        entries[0].failure = true;
        delete state!.pending;
        store.save(state!);
        return true;
      };
      const finalizedFailureResult = () =>
        errorResult(
          "The original Solana transaction finalized with failure. Its verified network fee remains in the spending ledger. No receipt was issued and no replacement payment was submitted."
        );
      if (state.pending) {
        const pending = state.pending;
        // Always recover the existing operation first, even if the caller asks
        // for another resource. This method cannot broadcast a transaction.
        const configuredApi = (ctx.config.baseUrl ?? "https://api.aifinpay.io").replace(/\/+$/, "");
        const call = pending.recovery.quote.settlement_call;
        // Any chain the owner allows may hold a pending payment, in its native coin or an allowed asset.
        const rail = String(call?.chain);
        const railAssets = solana
          ? [selected.native, ctx.config.payAsset ?? selected.native]
          : [
              ...options.filter((o) => o.chain === rail).map((o) => o.asset),
              ...(Object.hasOwn(PAY_CHAINS, rail) ? [PAY_CHAINS[rail as PayOption["chain"]].native] : []),
            ];
        const payerMatches = solana
          ? pending.recovery.quote.payer === ctx.agent.solanaAddress
          : pending.recovery.quote.payer?.toLowerCase() === ctx.agent.evmAddress.toLowerCase();
        if (
          pending.recovery.apiBaseUrl.replace(/\/+$/, "") !== configuredApi ||
          (pending.recovery.paymentIssuer ?? configuredApi).replace(/\/+$/, "") !== configuredApi ||
          !payerMatches ||
          (pending.recovery.chain !== undefined && pending.recovery.chain !== rail) ||
          !(solana ? rail === "solana" : options.some((o) => o.chain === rail)) ||
          !call ||
          call.splitter_version !== "1.4" ||
          ((call as { asset?: string }).asset ?? "POL") !== pending.recovery.asset ||
          !railAssets.includes(pending.recovery.asset) ||
          (solana ? pending.recovery.family !== "solana" : pending.recovery.family === "solana")
        )
          throw new Error(
            `Pending payment does not match the configured wallet/API/${selected.name} v1.4 route and asset`
          );
        let recovery: Aifp1PaymentRecovery;
        if (pending.recovery.family === "solana") {
          if (
            pending.recovery.solana.network !== ctx.config.solanaNetwork ||
            (call as { network?: string }).network !== ctx.config.solanaNetwork
          )
            throw new Error("Pending Solana payment does not match the owner-selected network");
          // The SDK verifies exact signed bytes, local Ed25519 identity and
          // the original bound reservation. Recovery cannot submit a new tx.
          recovery = pending.recovery;
        } else {
          if (solana) throw new Error("EVM payment cannot recover on Solana");
          if (pending.recovery.chain === undefined) {
            await assertPreparedV14Recovery(
              call as V14SettlementCall,
              { hash: pending.recovery.txRef, serializedTransaction: pending.serializedTransaction! },
              rail as PayOption["chain"],
              ctx.agent.evmAddress,
              pending.recovery.quote.quote_id
            );
          }
          recovery = { ...pending.recovery, chain: pending.recovery.chain ?? rail } as Aifp1PaymentRecovery;
        }
        track("aifp1_recovery_attempted");
        const paid = await ctx.agent
          .recoverPaidPayment(recovery, {
            paymentIssuer: configuredApi,
            ...(ctx.framework ? { framework: ctx.framework } : {}),
            ...(solana
              ? {
                  solanaNetwork: ctx.config.solanaNetwork!,
                  solanaEnvironment: ctx.config.devMode ? ("dev" as const) : ("prod" as const),
                }
              : {}),
          })
          .catch((error: unknown) => {
            track("aifp1_recovery_failed", { error_class: errorClass(error) });
            if (reconcileFinalizedFailure(error)) return null;
            throw error;
          });
        if (!paid) return finalizedFailureResult();
        const receipt: Aifp1CachedReceipt = {
          site: pending.site,
          merchantId: paid.merchant_id,
          receiptId: paid.receipt_id,
          jwt: paid.receipt,
          scope: paid.scope,
          resource: paid.resource,
          unitQuota: paid.unit_quota,
          remaining: paid.unit_quota,
          expiresAt: Date.parse(paid.expires_at),
          amountUsd: pending.amountUsd,
        };
        if (!Number.isFinite(receipt.expiresAt)) throw new Error("Invalid recovered receipt expiry");
        ctx.agent.aifp1Receipts.put(receipt);
        state.receipts = ctx.agent.aifp1Receipts.list();
        delete state.pending;
        store.save(state);
        track("aifp1_recovery_succeeded");
      }
      const spent = store.spent24h(state);
      const priorReceiptIds = new Set(state.receipts.map((entry) => entry.receiptId));
      let price: { usd: number; observedAtMs: number } | undefined;
      // No owner allowlist: pay only the verified owner of the site being used
      // (see ../merchant-site.ts). With one, the owner already chose the sites.
      const confirmPayee = async (merchantId: string) => {
        stage = "verify_site";
        if (ctx.config.gatewayOrigins === undefined)
          await assertVerifiedMerchantSite({
            fetchImpl: (input, init) => ctx.agent.inner.fetchImpl(input, init),
            apiBase: (ctx.config.baseUrl ?? "https://api.aifinpay.io").replace(/\/+$/, ""),
            merchantId,
            url,
            pathMode,
          });
        stage = "settle";
      };
      const persistPrepared = (prepared: Aifp1PaymentRecovery, usd: number, serializedTransaction?: `0x${string}`) => {
        if (state!.pending) throw new Error("A payment is already pending");
        if (
          !Number.isFinite(usd) ||
          usd <= 0 ||
          usd > maximum ||
          store.spent24h(state!) + usd > ctx.config.dailyAmountUsd!
        ) {
          if (Number.isFinite(usd) && usd > 0) {
            track("budget_cap_exceeded", { stage: usd > maximum ? "per_payment" : "daily" });
            stage = undefined;
          }
          throw new Error("Owner spending limit reached");
        }
        const site =
          pathMode === "direct" ? `direct:${JSON.stringify([url.origin, prepared.quote.merchant_id])}` : parsed.site;
        state!.pending = {
          recovery: prepared,
          ...(serializedTransaction ? { serializedTransaction } : {}),
          site,
          amountUsd: usd,
        };
        state!.spend.push({ at: Date.now(), usd, tx: prepared.txRef });
        // Durable atomic fsync completes before the SDK may broadcast.
        store.save(state!);
        stage = "pay";
      };
      let paidWith: { chain: string; asset: string } | undefined;
      stage = "quote";
      const started = Date.now();
      const quoted = (asset: string, amount: unknown) =>
        track("aifp1_quote_obtained", {
          network: paying?.chain.name,
          asset,
          usd_bucket: usdBucket(Number(amount)),
          ms: Date.now() - started,
        });
      try {
        // One option pays as before; with more, this URL's 402 is read first so the choice comes before any quote.
        let option: PayOption | undefined = options[0];
        let offered: OptionState[] | undefined;
        let answered: Response | undefined;
        if (options.length > 1) {
          const remembered = options.find(
            (o) => o.chain === state!.paidWith?.chain && o.asset === state!.paidWith?.asset
          );
          option = remembered ?? option;
          const first = await firstAnswer(ctx, url, parsed, pathMode);
          if (first && "response" in first) answered = first.response;
          else if (first) {
            const { challenge } = first;
            const expected =
              expectedMerchantId ??
              (pathMode === "gateway" ? await ctx.agent.aifp1Receipts.merchantPins?.get(parsed.site) : undefined);
            // A site answering as another merchant is refused by the SDK before any quote; let it say so.
            if (expected === undefined || expected === challenge.merchant_id) {
              const priceUsd = challengeUsd(challenge);
              const merchant = MERCHANT_ID.test(challenge.merchant_id)
                ? await readMerchant(
                    (input, init) => ctx.agent.inner.fetchImpl(input, init),
                    (ctx.config.baseUrl ?? API_ORIGIN).replace(/\/+$/, ""),
                    challenge.merchant_id
                  )
                : null;
              const merchantChains = Array.isArray(merchant?.settlement_chains)
                ? merchant.settlement_chains
                    .filter((c): c is string => typeof c === "string")
                    .map((c) => c.toLowerCase())
                : undefined;
              offered = await readOptions(ctx, options, { priceUsd, merchantChains });
              const chosen = chooseOption(offered, remembered);
              if (!chosen) {
                track("aifp1_pay_failed", { stage: "funds" });
                stage = undefined;
                return errorResult(nothingPays(ctx, offered, priceUsd, merchantChains));
              }
              option = chosen;
            }
          }
        }
        const pay = option ? PAY_CHAINS[option.chain] : selected;
        const payAsset = option?.asset ?? ctx.config.payAsset ?? pay.native;
        paying = { chain: pay, asset: payAsset };
        // On Arc the native symbol names the USDC token: always the token path.
        const stablePay = payAsset !== pay.native || pay.stablecoinOnly === true;
        const rpc = rpcFor(ctx.config, pay);
        const gasCap = option ? optionGasCap(ctx.config, option.chain) : feeCap;
        const remember = () => {
          paidWith = { chain: pay.name, asset: payAsset };
          if (!offered) return;
          state!.paidWith = {
            chain: pay.name,
            asset: payAsset,
            at: Date.now(),
            balances: offered.flatMap((o) =>
              o.balance
                ? [
                    {
                      chain: o.chain,
                      asset: o.asset,
                      units: o.balance.units.toString(),
                      decimals: o.balance.decimals,
                      at: o.balance.at,
                    },
                  ]
                : []
            ),
          };
          forgetBalances();
        };
        const response =
          answered ??
          (await ctx.agent.fetchPaid(
            url.href,
            { method: "GET", redirect: "manual", headers: { "User-Agent": MCP_TOKEN } },
            {
              onFlowEvent: (event: Aifp1FlowEvent) => {
                if (event.type === "challenge_received")
                  track("aifp1_challenge_received", { outcome: event.direct ? "direct" : "gateway", http_status: 402 });
                else if (event.type === "receipt_cache")
                  track(event.hit ? "aifp1_receipt_cached_hit" : "aifp1_receipt_cached_miss");
                else refusedStatus = event.status;
              },
              apiBaseUrl: ctx.config.baseUrl,
              paymentIssuer: ctx.config.baseUrl ?? "https://api.aifinpay.io",
              gatewayOrigins: origins,
              resourcePathMode: pathMode,
              scope,
              ...(expectedMerchantId !== undefined ? { expectedMerchantId } : {}),
              ...(ctx.framework ? { framework: ctx.framework } : {}),
              // A pending Solana quote pins this owner limit across restarts and
              // rollover. Fresh daily allowance is checked again in persistPrepared
              // under the operation lock, before any broadcast.
              maxAmountUsd:
                pay.name === "solana" ? maximum : Math.min(maximum, Math.max(0, ctx.config.dailyAmountUsd! - spent)),
              nativeUsdPrice: async () => {
                // Independent public price, never the quote API's rate: Chainlink
                // over the agent's own RPC for the pay chain first (no extra
                // host), then Coinbase, then CoinGecko. See ../native-price.ts.
                const found = await independentNativeUsd({
                  fetchImpl: (input, init) => ctx.agent.inner.fetchImpl(input, init),
                  chain: pay,
                  rpc,
                });
                price = { usd: found.usd, observedAtMs: found.observedAtMs };
                return price;
              },
              ...(pay.name === "solana"
                ? {
                    solanaV14: {
                      environment: ctx.config.devMode ? ("dev" as const) : ("prod" as const),
                      network: ctx.config.solanaNetwork!,
                      asset: payAsset,
                      maxFeeLamports: feeCap,
                      onPrepared: async (prepared) => {
                        quoted(prepared.asset, prepared.quote.amount);
                        if (
                          prepared.family !== "solana" ||
                          prepared.chain !== "solana" ||
                          prepared.solana.network !== ctx.config.solanaNetwork ||
                          prepared.quote.payer !== ctx.agent.solanaAddress ||
                          prepared.asset !== payAsset
                        )
                          throw new Error("Prepared Solana payment disagrees with the owner configuration");
                        await confirmPayee(prepared.quote.merchant_id);
                        if (!price || Date.now() - price.observedAtMs > 60_000 || price.observedAtMs > Date.now())
                          throw new Error("Independent SOL price expired before preparation");
                        const native = prepared.quote.native_settlement as { total_lamports?: string } | undefined;
                        const floor =
                          payAsset === "SOL"
                            ? Math.max(
                                Number(prepared.quote.amount),
                                (Number(BigInt(native!.total_lamports!)) / 1e9) * price.usd
                              )
                            : Number(prepared.quote.amount);
                        if (
                          !Number.isFinite(floor) ||
                          floor <= 0 ||
                          !Number.isFinite(prepared.reservedAmountUsd) ||
                          prepared.reservedAmountUsd < floor
                        )
                          throw new Error("Prepared Solana admission amount is inconsistent");
                        persistPrepared(prepared, prepared.reservedAmountUsd);
                        remember();
                      },
                    },
                  }
                : {
                    v14: {
                      chain: pay.name,
                      ...(stablePay ? { asset: payAsset } : {}),
                      maxGasWei: gasCap,
                      onPrepared: async (prepared) => {
                        quoted(prepared.asset, prepared.quote.amount);
                        await confirmPayee(prepared.quote.merchant_id);
                        let usd: number;
                        if (stablePay) {
                          if (prepared.asset !== payAsset)
                            throw new Error("Prepared payment is not in the configured asset");
                          usd = Number(prepared.quote.amount);
                        } else {
                          if (!price || Date.now() - price.observedAtMs > 60_000)
                            throw new Error("Independent price expired before preparation");
                          const native = prepared.quote.native_settlement as { total_wei: string };
                          usd = Math.max(
                            Number(prepared.quote.amount),
                            (Number(BigInt(native.total_wei)) / 1e18) * price.usd
                          );
                        }
                        // Copy the full recovery, including the new wallet binding
                        // marker and any signed approval; retain legacy byte field.
                        persistPrepared(prepared, usd, prepared.serializedTransaction);
                        remember();
                      },
                    },
                  }),
            }
          ));
        if (response === null) {
          track("budget_cap_exceeded", { stage: "per_payment" });
          return errorResult("Payment skipped: owner budget reached.");
        }
        const redact = (value: string): string => {
          for (const entry of ctx.agent.aifp1Receipts.list()) {
            if (entry.jwt) value = value.replaceAll(entry.jwt, "[redacted receipt]");
          }
          return value.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]");
        };
        const headers: Record<string, string> = {};
        for (const name of ["content-type", "aifp-quota-remaining", "aifp-quota-total", "aifp-license"]) {
          const value = response.headers.get(name);
          if (value !== null) headers[name] = redact(value);
        }
        const bounded = await boundedBody(response);
        const body = redact(bounded.body);
        const truncated = bounded.truncated;
        const license = response.ok ? await paidLicense(ctx, response.headers.get("aifp-license")) : undefined;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: response.status,
                ok: response.ok,
                ...(paidWith ? { paid_with: paidWith } : {}),
                headers,
                ...(license ? { license } : {}),
                body,
                truncated,
                receipts: ctx.agent.getReceiptCacheSummary(),
              }),
            },
          ],
        };
      } catch (error) {
        if (reconcileFinalizedFailure(error)) {
          track("aifp1_pay_failed", { stage: "pay", error_class: errorClass(error) });
          return finalizedFailureResult();
        }
        throw error;
      } finally {
        // Receipt caching precedes content retry in the SDK. Retain it even
        // when that content request fails; never discard already bought access.
        state.receipts = ctx.agent.aifp1Receipts.list();
        if (
          state.pending &&
          state.receipts.some(
            (entry) =>
              !priorReceiptIds.has(entry.receiptId) &&
              entry.site === state!.pending!.site &&
              entry.merchantId === state!.pending!.recovery.quote.merchant_id
          )
        ) {
          const sent = state.pending as NonNullable<PaymentState["pending"]>;
          track("aifp1_pay_succeeded", {
            network: paying?.chain.name,
            asset: sent.recovery.asset,
            usd_bucket: usdBucket(sent.amountUsd),
            ms: Date.now() - started,
          });
          stage = "retry";
          delete state.pending;
        }
        store.save(state);
      }
    });
  } catch (error) {
    const settlement = error instanceof Error && error.name === "V14SettlementError";
    if (settlement && (error as Error & { code?: string }).code === "V14_GAS_BUDGET_EXCEEDED")
      track("budget_cap_exceeded", { stage: "gas" });
    else if (stage || error instanceof PaymentStateError)
      track("aifp1_pay_failed", {
        stage: error instanceof PaymentStateError ? "setup" : settlement ? "settle" : stage,
        error_class: errorClass(error),
        http_status:
          error instanceof Aifp1GatewayRetiredError
            ? 410
            : ((error as { status?: unknown } | undefined)?.status ?? refusedStatus),
      });
    if (error instanceof PaymentStateError) return errorResult(error.message);
    // Set before any payment step runs; the fallback only covers a throw from
    // inside validation itself, which returns above.
    const on = paying?.chain ?? chain ?? payChain(undefined);
    const label = on.label;
    if (!state?.pending && error instanceof Aifp1MerchantChangedError) {
      const shown = (id: string) => (MERCHANT_ID.test(id) ? id : "an unrecognized merchant id");
      const now = shown(error.merchantId);
      return errorResult(
        args.expected_merchant_id !== undefined
          ? `${error.site} answers as merchant ${now}, not the expected merchant ${shown(error.expectedMerchantId)}. Nothing was quoted or paid. Check the merchant id with the owner.`
          : `${error.site} now answers as merchant ${now}, but this wallet first paid it as ${shown(error.expectedMerchantId)}. Nothing was quoted or paid. The site may have changed hands; the agent cannot approve a new merchant itself. Ask the owner to confirm it` +
              (MERCHANT_ID.test(error.merchantId)
                ? `, and only then retry with expected_merchant_id "${error.merchantId}".`
                : ". This merchant id cannot be confirmed through this tool.")
      );
    }
    if (!state?.pending && error instanceof UnverifiedMerchantSiteError) {
      // Name the ways forward, so neither the agent nor the owner improvises a
      // third one: another tool, a direct transfer or a retry loop.
      const noOtherWay = "Do not try another way to pay this site: no other tool, SDK call or direct transfer.";
      const allowlist = `add ${error.origin} to AIFINPAY_GATEWAY_ORIGINS in this MCP server's env (comma-separated https origins; once it is set, only the listed sites are paid) and restart the MCP client`;
      return errorResult(
        error.kind === "unconfirmed"
          ? `${error.message} The AiFinPay lookup of this merchant failed. Try once more in a minute; if it fails again, stop and tell the owner. ${noOtherWay}`
          : error.kind === "other_site"
            ? `${error.message} The site being paid for is not the one this merchant verified, so this 402 may be steering the payment to someone else. Do not retry. ${noOtherWay} Tell the owner; only if they know ${error.origin} belongs to this merchant should they ${allowlist}.`
            : `${error.message} Do not retry. ${noOtherWay} Tell the owner there are two fixes: the merchant verifies this site's domain with AiFinPay (dash.aifinpay.io → Sites → DNS TXT record), or, if the owner knows and trusts ${error.origin}, they ${allowlist}. Then retry once.`
      );
    }
    if (!state?.pending && error instanceof Aifp1GatewayRetiredError) {
      return errorResult(
        `${error.site} is retired: the gateway no longer serves this site (410 gateway_retired). Nothing was quoted or paid. Do not retry this request or pay for it again; tell the owner.`
      );
    }
    if (!state?.pending && error instanceof Aifp1SettlementUnsupportedError) {
      return errorResult(
        `The merchant must offer a signed native ${label} v1.4 quote (the chain set in AIFINPAY_PAY_CHAIN). Its current settlement route is unsupported; no legacy, other-chain or alternate-protocol payment was attempted.`
      );
    }
    if (!state?.pending && error instanceof Error && error.name === "V14SettlementError") {
      const code = (error as Error & { code?: string }).code;
      const asset = paying?.asset ?? ctx.config.payAsset ?? on.native;
      const shortOf = /^token balance/.test(error.message)
        ? `The wallet holds too little ${asset} on ${label} for this purchase. Add ${asset} to ${ctx.agent.evmAddress}; its ${on.native} pays only the gas.`
        : /^native balance/.test(error.message)
          ? `The wallet holds too little ${on.native} on ${label} for the gas. Add ${on.native} to ${ctx.agent.evmAddress}.`
          : `The wallet needs enough ${on.native} on ${label} for the quoted purchase plus the owner-capped gas fee.`;
      const messages: Record<string, string> = {
        V14_INSUFFICIENT_BALANCE: shortOf,
        V14_GAS_BUDGET_EXCEEDED: `Estimated gas exceeds the owner's gas cap (AIFINPAY_MAX_GAS, in ${on.native}). The owner can review the limit; the agent cannot raise it.`,
        V14_PAUSED: "The approved payment deployment is paused. No payment was sent.",
        V14_EXPIRED: "The signed quote expired before submission. Request a fresh quote.",
        V14_EXPIRING: "The signed quote expires too soon to submit safely. Request a fresh quote.",
        V14_STALE_NONCE: "The signed quote uses a stale wallet nonce. Request a fresh quote.",
      };
      return errorResult(
        messages[code ?? ""] ??
          `Payment verification refused this deployment, signer or quote. The merchant must offer a verified native ${label} v1.4 route; no fallback was attempted.`
      );
    }
    return errorResult(
      state?.pending
        ? `Payment pending (${state.pending.recovery.txRef}). Its private recovery journal is retained. Retry to recover the receipt; no replacement payment will be submitted. If submission never occurred or reverted, the owner must reconcile the journal.`
        : "Payment request failed before completion. Check owner configuration, wallet, supported route, network and spending limits. No fallback payment was attempted."
    );
  }
}

type Challenge = {
  merchant_id: string;
  base_unit_price_usd?: unknown;
  min_units?: unknown;
  min_requests?: unknown;
  unit_weight?: unknown;
};

/** The SDK's first request, made here: its answer when nothing is to pay, the 402 when it is, null when a held receipt covers. */
async function firstAnswer(
  ctx: ToolContext,
  url: URL,
  parsed: { site: string; restPath: string },
  pathMode: "gateway" | "direct"
): Promise<{ response: Response } | { challenge: Challenge } | null> {
  const payer = ctx.agent.evmAddress;
  if (pathMode === "gateway" && ctx.agent.aifp1Receipts.find(parsed.site, parsed.restPath, undefined, payer))
    return null;
  const response = await ctx.agent.inner.fetchImpl(url.href, {
    method: "GET",
    redirect: "manual",
    headers: {
      "User-Agent": MCP_USER_AGENT,
      "AIFP-Agent-Id": payer,
      ...(ctx.framework ? { "AIFP-Agent-Framework": ctx.framework } : {}),
    },
  });
  const body =
    response.status === 402 || response.status === 410
      ? ((await response
          .clone()
          .json()
          .catch(() => null)) as Record<string, unknown> | null)
      : null;
  if (response.status === 410 && body?.error === "gateway_retired") throw new Aifp1GatewayRetiredError(parsed.site);
  if (
    response.status !== 402 ||
    body?.protocol !== "AIFP-1" ||
    typeof body.merchant_id !== "string" ||
    typeof body.resource !== "string"
  )
    return { response };
  const site = `direct:${JSON.stringify([url.origin, body.merchant_id])}`;
  if (pathMode === "direct" && ctx.agent.aifp1Receipts.find(site, parsed.restPath, undefined, payer)) return null;
  return { challenge: body as Challenge };
}

/** The batch the SDK quotes by default (defaultUnitsFor in @aifinpay/agent), in USD. */
function challengeUsd(c: Challenge): number {
  const base = Number(c.base_unit_price_usd);
  if (!Number.isFinite(base) || base <= 0) return SMALLEST_BATCH_USD;
  const int = (v: unknown) => (typeof v === "number" && Number.isSafeInteger(v) && v > 0 ? v : undefined);
  const requests = int(c.min_requests);
  const units =
    int(c.min_units) ??
    (requests !== undefined ? requests * (int(c.unit_weight) ?? 1) : Math.max(1, Math.ceil(SMALLEST_BATCH_USD / base)));
  return units * base;
}

const andList = (items: string[], word = "and") =>
  items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} ${word} ${items.at(-1)}`;

/** Each allowed option with its balance, what the merchant accepts, and what to add. */
function nothingPays(ctx: ToolContext, states: OptionState[], priceUsd: number, merchantChains?: string[]): string {
  const shown = states.filter((s) => s.accepted);
  const lines = [...new Set(shown.map((s) => s.chain))].map((name) => {
    const chain = PAY_CHAINS[name];
    const own = shown.filter((s) => s.chain === name);
    const items = own.map((s) => (s.balance ? `${formatUnits(s.balance)} ${s.asset}` : `${s.asset} unreadable`));
    const native = own.find((s) => s.native)?.native;
    if (!own.some((s) => s.asset === chain.native) && native) items.push(`${formatUnits(native)} ${chain.native}`);
    return `${chain.label}: ${items.join(", ")} (gas needs up to ${formatUnits({ units: own[0].gasCap, decimals: 18 })} ${chain.native}).`;
  });
  const accepts = merchantChains
    ?.filter((name) => Object.hasOwn(PAY_CHAINS, name))
    .map(
      (name) =>
        `${PAY_CHAINS[name as PayOption["chain"]].label} ${andList(payOptions({ payChain: name }).map((o) => o.asset))}`
    );
  const add = [...new Set(shown.map((s) => s.asset))];
  return [
    `Nothing was paid or quoted: no allowed way to pay covers this purchase (about $${Number(priceUsd.toFixed(6))}) plus the gas cap.`,
    ...lines,
    ...(accepts?.length ? [`The merchant accepts ${andList(accepts)}.`] : []),
    add.length
      ? `Add ${andList(add, "or")} to ${ctx.agent.evmAddress}.`
      : "None of the owner's options is accepted by this merchant; the owner can list one it accepts in AIFINPAY_PAY_OPTIONS.",
  ].join(" ");
}

/** The licence the paid content came with, and its terms from the AiFinPay API; nothing if the header is not one. */
async function paidLicense(ctx: ToolContext, header: string | null): Promise<Record<string, unknown> | undefined> {
  const match = header === null ? null : LICENSE_HEADER.exec(header.trim());
  if (!match) return undefined;
  const [, id, rev, sha256, raw] = match;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  const origins = [API_ORIGIN, new URL(ctx.config.baseUrl ?? API_ORIGIN).origin];
  const path = LICENSE_PATH.exec(url.pathname);
  if (!origins.includes(url.origin) || url.search || url.hash || !path || path[2] !== rev) return undefined;
  // Only the licence of a merchant this wallet holds a receipt for.
  if (!ctx.agent.aifp1Receipts.list().some((entry) => entry.merchantId === path[1])) return undefined;
  const license = {
    id,
    revision: Number(rev),
    sha256,
    url: url.href,
    text_url: `${url.href}/text`,
    notice: LICENSE_NOTICE,
  };
  let block = licenseBlocks.get(url.href);
  if (!block) {
    try {
      const response = await ctx.agent.inner.fetchImpl(url.href, { method: "GET", redirect: "error" });
      const json = response.ok ? ((await response.json()) as Record<string, unknown>) : null;
      const document = (json?.document ?? {}) as Record<string, unknown>;
      if (
        json &&
        json.license_id === id &&
        Number(json.revision) === Number(rev) &&
        json.terms &&
        typeof json.terms === "object"
      ) {
        const picked = {
          status: json.status,
          title: typeof document.title === "string" ? document.title : undefined,
          version: typeof document.version === "string" ? document.version : undefined,
          terms: json.terms,
        };
        if (JSON.stringify(picked).length <= 8_000) {
          block = picked;
          licenseBlocks.set(url.href, block);
        }
      }
    } catch {
      block = undefined;
    }
  }
  return block ? { ...license, ...block } : { ...license, terms_unavailable: true };
}

async function boundedBody(response: Response, limit = 64 * 1024): Promise<{ body: string; truncated: boolean }> {
  if (!response.body) return { body: "", truncated: false };
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return { body: Buffer.concat(chunks).toString("utf8"), truncated: false };
      const room = limit - size;
      chunks.push(value.subarray(0, room));
      size += Math.min(room, value.length);
      if (value.length > room || size === limit) {
        await reader.cancel();
        return { body: Buffer.concat(chunks).toString("utf8"), truncated: true };
      }
    }
  } finally {
    reader.releaseLock();
  }
}
function errorResult(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] };
}
