import {
  Aifp1SettlementUnsupportedError,
  Aifp1FinalizedFailureError,
  assertPreparedV14Recovery,
  parseGatewayUrl,
  type Aifp1CachedReceipt,
  type V14SettlementCall,
  type Aifp1PaymentRecovery,
} from "@aifinpay/agent";
import type { ToolContext } from "../server.js";
import { validatePaymentConfig } from "../config.js";
import { PaymentStateError, type PaymentState } from "../payment-state.js";
import { independentNativeUsd } from "../native-price.js";
import { payChain, type PayChain } from "../pay-chains.js";

// "prefix" is left out on purpose: it needs a resource to anchor to, and the
// owner's two real requests are "this endpoint" and "this site".
const SCOPES = ["exact", "merchant"] as const;
type PayableScope = (typeof SCOPES)[number];

export function payableFetchTool() {
  return {
    name: "payable_fetch",
    description:
      'Fetch a GET resource from an owner-approved AiFinPay merchant. Buys a prepaid batch through verified v1.4 on the chain the owner set in AIFINPAY_PAY_CHAIN (Polygon by default; other supported networks require explicit owner selection) — in its native currency (POL, SOL, ETH, AVAX, BNB or XRP), or in the stablecoin the owner set in AIFINPAY_PAY_ASSET (e.g. USDC; gas is still native) — within owner limits, then reuses its receipt. With scope "merchant" one batch covers every path on the site. Pending payments are recovered without sending another transaction. Other payment protocols are unsupported.',
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTPS resource on an owner-configured exact gateway origin." },
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
  try {
    let feeCap: bigint;
    try {
      feeCap = validatePaymentConfig(ctx.config);
      chain = payChain(ctx.config.payChain);
    } catch (error) {
      return errorResult((error as Error).message);
    }
    const store = ctx.paymentState;
    if (!store || store.address !== ctx.agent.evmAddress.toLowerCase())
      return errorResult("A persistent matching wallet is required for payments.");
    if (Object.keys(args).some((k) => !["url", "max_amount_usd", "scope"].includes(k)))
      return errorResult("Only url, max_amount_usd and scope are supported; no facilitator fallback.");
    if (typeof args.url !== "string") return errorResult("url must be an HTTPS resource URL.");
    if (args.scope !== undefined && !SCOPES.includes(args.scope as PayableScope))
      return errorResult('scope must be "exact" or "merchant".');
    const scope: PayableScope = (args.scope as PayableScope | undefined) ?? "exact";
    const url = new URL(args.url);
    if (url.protocol !== "https:" || url.username || url.password || url.hash)
      return errorResult("The URL must use an owner-approved exact HTTPS origin without credentials or fragment.");
    // The agent cannot approve a site itself: a page asking to be paid is not
    // the owner asking to pay it. Name the origin so the owner can decide.
    if (!ctx.config.gatewayOrigins!.includes(url.origin))
      return errorResult(
        `${url.origin} is not an owner-approved site. Nothing was paid. The owner can add it to AIFINPAY_GATEWAY_ORIGINS and reconnect this server; the agent cannot approve a site itself.`
      );
    if (
      args.max_amount_usd !== undefined &&
      (typeof args.max_amount_usd !== "number" || !Number.isFinite(args.max_amount_usd) || args.max_amount_usd <= 0)
    )
      return errorResult("max_amount_usd must be a positive finite amount.");
    const maximum = Math.min(
      ctx.config.maxAmountUsd!,
      typeof args.max_amount_usd === "number" ? args.max_amount_usd : Infinity
    );
    const parsed = parseGatewayUrl(url.href, ctx.config.gatewayOrigins, ctx.config.gatewayPathMode);
    const pay = chain;
    const payAsset = ctx.config.payAsset ?? pay.native;
    const rpc = ctx.config.rpcUrl ?? pay.defaultRpc;
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
        const solana = pay.name === "solana";
        const payerMatches = solana
          ? pending.recovery.quote.payer === ctx.agent.solanaAddress
          : pending.recovery.quote.payer?.toLowerCase() === ctx.agent.evmAddress.toLowerCase();
        if (
          pending.recovery.apiBaseUrl.replace(/\/+$/, "") !== configuredApi ||
          (pending.recovery.paymentIssuer ?? configuredApi).replace(/\/+$/, "") !== configuredApi ||
          !payerMatches ||
          (pending.recovery.chain !== undefined && pending.recovery.chain !== pay.name) ||
          call?.chain !== pay.name ||
          call.splitter_version !== "1.4" ||
          ((call as { asset?: string }).asset ?? "POL") !== pending.recovery.asset ||
          ![pay.native, payAsset].includes(pending.recovery.asset) ||
          (solana ? pending.recovery.family !== "solana" : pending.recovery.family === "solana")
        )
          throw new Error(`Pending payment does not match the configured wallet/API/${pay.name} v1.4 route and asset`);
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
          if (pay.name === "solana") throw new Error("EVM payment cannot recover on Solana");
          if (pending.recovery.chain === undefined) {
            await assertPreparedV14Recovery(
              call as V14SettlementCall,
              { hash: pending.recovery.txRef, serializedTransaction: pending.serializedTransaction! },
              pay.name,
              ctx.agent.evmAddress,
              pending.recovery.quote.quote_id
            );
          }
          recovery = { ...pending.recovery, chain: pending.recovery.chain ?? pay.name };
        }
        const paid = await ctx.agent
          .recoverPaidPayment(recovery, {
            paymentIssuer: configuredApi,
            ...(pay.name === "solana"
              ? {
                  solanaNetwork: ctx.config.solanaNetwork!,
                  solanaEnvironment: ctx.config.devMode ? ("dev" as const) : ("prod" as const),
                }
              : {}),
          })
          .catch((error: unknown) => {
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
      }
      const spent = store.spent24h(state);
      const priorReceiptIds = new Set(state.receipts.map((entry) => entry.receiptId));
      let price: { usd: number; observedAtMs: number } | undefined;
      const persistPrepared = (prepared: Aifp1PaymentRecovery, usd: number, serializedTransaction?: `0x${string}`) => {
        if (state!.pending) throw new Error("A payment is already pending");
        if (
          !Number.isFinite(usd) ||
          usd <= 0 ||
          usd > maximum ||
          store.spent24h(state!) + usd > ctx.config.dailyAmountUsd!
        )
          throw new Error("Owner spending limit reached");
        const site =
          ctx.config.gatewayPathMode === "direct"
            ? `direct:${JSON.stringify([url.origin, prepared.quote.merchant_id])}`
            : parsed.site;
        state!.pending = {
          recovery: prepared,
          ...(serializedTransaction ? { serializedTransaction } : {}),
          site,
          amountUsd: usd,
        };
        state!.spend.push({ at: Date.now(), usd, tx: prepared.txRef });
        // Durable atomic fsync completes before the SDK may broadcast.
        store.save(state!);
      };
      try {
        const response = await ctx.agent.fetchPaid(
          url.href,
          { method: "GET", redirect: "manual" },
          {
            apiBaseUrl: ctx.config.baseUrl,
            paymentIssuer: ctx.config.baseUrl ?? "https://api.aifinpay.io",
            gatewayOrigins: ctx.config.gatewayOrigins,
            resourcePathMode: ctx.config.gatewayPathMode,
            scope,
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
                      if (
                        prepared.family !== "solana" ||
                        prepared.chain !== "solana" ||
                        prepared.solana.network !== ctx.config.solanaNetwork ||
                        prepared.quote.payer !== ctx.agent.solanaAddress ||
                        prepared.asset !== payAsset
                      )
                        throw new Error("Prepared Solana payment disagrees with the owner configuration");
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
                    },
                  },
                }
              : {
                  v14: {
                    chain: pay.name,
                    ...(payAsset !== pay.native ? { asset: payAsset } : {}),
                    maxGasWei: feeCap,
                    onPrepared: async (prepared) => {
                      let usd: number;
                      if (payAsset !== pay.native) {
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
                    },
                  },
                }),
          }
        );
        if (response === null) return errorResult("Payment skipped: owner budget reached.");
        const redact = (value: string): string => {
          for (const entry of ctx.agent.aifp1Receipts.list()) {
            if (entry.jwt) value = value.replaceAll(entry.jwt, "[redacted receipt]");
          }
          return value.replace(/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, "[redacted token]");
        };
        const headers: Record<string, string> = {};
        for (const name of ["content-type", "aifp-quota-remaining", "aifp-quota-total"]) {
          const value = response.headers.get(name);
          if (value !== null) headers[name] = redact(value);
        }
        const bounded = await boundedBody(response);
        const body = redact(bounded.body);
        const truncated = bounded.truncated;
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                status: response.status,
                ok: response.ok,
                headers,
                body,
                truncated,
                receipts: ctx.agent.getReceiptCacheSummary(),
              }),
            },
          ],
        };
      } catch (error) {
        if (reconcileFinalizedFailure(error)) return finalizedFailureResult();
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
          delete state.pending;
        }
        store.save(state);
      }
    });
  } catch (error) {
    if (error instanceof PaymentStateError) return errorResult(error.message);
    // Set before any payment step runs; the fallback only covers a throw from
    // inside validation itself, which returns above.
    const on = chain ?? payChain(undefined);
    const label = on.label;
    if (!state?.pending && error instanceof Aifp1SettlementUnsupportedError) {
      return errorResult(
        `The merchant must offer a signed native ${label} v1.4 quote (the chain set in AIFINPAY_PAY_CHAIN). Its current settlement route is unsupported; no legacy, other-chain or alternate-protocol payment was attempted.`
      );
    }
    if (!state?.pending && error instanceof Error && error.name === "V14SettlementError") {
      const code = (error as Error & { code?: string }).code;
      const messages: Record<string, string> = {
        V14_INSUFFICIENT_BALANCE: `The wallet needs enough ${on.native} on ${label} for the quoted purchase plus the owner-capped gas fee.`,
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
