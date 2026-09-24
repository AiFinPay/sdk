import { Aifp1SettlementUnsupportedError, parseGatewayUrl, type Aifp1CachedReceipt } from "@aifinpay/agent";
import type { ToolContext } from "../server.js";
import { validatePaymentConfig } from "../config.js";
import { PaymentStateError, type PaymentState } from "../payment-state.js";
import { independentPolUsd } from "../native-price.js";

export function payableFetchTool() {
  return {
    name: "payable_fetch",
    description:
      "Fetch a GET resource from an owner-approved AiFinPay merchant. Buys a prepaid batch through verified Polygon v1.4 — in native POL, or in the stablecoin the owner set in AIFINPAY_PAY_ASSET (e.g. USDC; gas is still POL) — within owner limits, then reuses its receipt. Pending payments are recovered without sending another transaction. Other payment protocols are unsupported.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "HTTPS resource on an owner-configured exact gateway origin." },
        max_amount_usd: {
          type: "number",
          exclusiveMinimum: 0,
          description: "Optional tighter per-payment USD limit; cannot increase the owner's cap.",
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
  try {
    let maxGasWei: bigint;
    try {
      maxGasWei = validatePaymentConfig(ctx.config);
    } catch (error) {
      return errorResult((error as Error).message);
    }
    const store = ctx.paymentState;
    if (!store || store.address !== ctx.agent.evmAddress.toLowerCase())
      return errorResult("A persistent matching wallet is required for payments.");
    if (Object.keys(args).some((k) => !["url", "max_amount_usd"].includes(k)))
      return errorResult("Only url and max_amount_usd are supported; no facilitator fallback.");
    if (typeof args.url !== "string") return errorResult("url must be an HTTPS resource URL.");
    const url = new URL(args.url);
    if (
      url.protocol !== "https:" ||
      url.username ||
      url.password ||
      url.hash ||
      !ctx.config.gatewayOrigins!.includes(url.origin)
    )
      return errorResult("The URL must use an owner-approved exact HTTPS origin without credentials or fragment.");
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
    const payAsset = ctx.config.payAsset ?? "POL";
    return await store.exclusive(async () => {
      state = store.read();
      for (const entry of ctx.agent.aifp1Receipts.list()) ctx.agent.aifp1Receipts.evict(entry);
      for (const entry of state.receipts) ctx.agent.aifp1Receipts.put(entry);
      if (state.pending) {
        const pending = state.pending;
        // Always recover the existing operation first, even if the caller asks
        // for another resource. This method cannot broadcast a transaction.
        const configuredApi = (ctx.config.baseUrl ?? "https://api.aifinpay.io").replace(/\/+$/, "");
        const call = pending.recovery.quote.settlement_call;
        if (
          pending.recovery.apiBaseUrl.replace(/\/+$/, "") !== configuredApi ||
          (pending.recovery.paymentIssuer ?? configuredApi).replace(/\/+$/, "") !== configuredApi ||
          pending.recovery.quote.payer?.toLowerCase() !== ctx.agent.evmAddress.toLowerCase() ||
          call?.chain !== "polygon" ||
          call.splitter_version !== "1.4" ||
          // Native calls from earlier versions may lack the field; they were POL.
          ((call as { asset?: string }).asset ?? "POL") !== pending.recovery.asset ||
          !["POL", payAsset].includes(pending.recovery.asset)
        ) {
          throw new Error("Pending payment does not match configured wallet/API/Polygon v1.4 route and asset");
        }
        const paid = await ctx.agent.recoverPaidPayment(pending.recovery, { paymentIssuer: configuredApi });
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
      try {
        const response = await ctx.agent.fetchPaid(
          url.href,
          { method: "GET", redirect: "manual" },
          {
            apiBaseUrl: ctx.config.baseUrl,
            paymentIssuer: ctx.config.baseUrl ?? "https://api.aifinpay.io",
            gatewayOrigins: ctx.config.gatewayOrigins,
            resourcePathMode: ctx.config.gatewayPathMode,
            scope: "exact",
            maxAmountUsd: Math.min(maximum, Math.max(0, ctx.config.dailyAmountUsd! - spent)),
            nativeUsdPrice: async () => {
              // Independent public price, never the quote API's rate: Chainlink
              // over the agent's own Polygon RPC first (no extra host), then
              // Coinbase, then CoinGecko. See ../native-price.ts.
              const found = await independentPolUsd({
                fetchImpl: (input, init) => ctx.agent.inner.fetchImpl(input, init),
                polygonRpc: (ctx.agent as { polygonRpc?: string }).polygonRpc,
              });
              price = { usd: found.usd, observedAtMs: found.observedAtMs };
              return price;
            },
            v14: {
              ...(payAsset !== "POL" ? { asset: payAsset } : {}),
              maxGasWei,
              onPrepared: async (prepared) => {
                if (state!.pending) throw new Error("A payment is already pending");
                // A stablecoin batch is dollars already: the SDK bound the signed
                // gross to the quoted USD amount exactly. Only a native batch
                // needs the independent POL price.
                let usd: number;
                if (payAsset !== "POL") {
                  if (prepared.asset !== payAsset) throw new Error("Prepared payment is not in the configured asset");
                  usd = Number(prepared.quote.amount);
                } else {
                  if (!price || Date.now() - price.observedAtMs > 60_000)
                    throw new Error("Independent price expired before preparation");
                  const native = prepared.quote.native_settlement;
                  usd = Math.max(Number(prepared.quote.amount), (Number(BigInt(native!.total_wei)) / 1e18) * price.usd);
                }
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
                  recovery: {
                    apiBaseUrl: prepared.apiBaseUrl,
                    quote: prepared.quote,
                    txRef: prepared.txRef,
                    asset: prepared.asset,
                    paymentIssuer: prepared.paymentIssuer,
                  },
                  serializedTransaction: prepared.serializedTransaction,
                  site,
                  amountUsd: usd,
                };
                state!.spend.push({ at: Date.now(), usd, tx: prepared.txRef });
                // Atomic fsync completes BEFORE the SDK is allowed to broadcast.
                store.save(state!);
              },
            },
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
    if (!state?.pending && error instanceof Aifp1SettlementUnsupportedError) {
      return errorResult(
        "The merchant must offer a signed native Polygon v1.4 quote. Its current settlement route is unsupported; no legacy or alternate-protocol payment was attempted."
      );
    }
    if (!state?.pending && error instanceof Error && error.name === "V14SettlementError") {
      const code = (error as Error & { code?: string }).code;
      const messages: Record<string, string> = {
        V14_INSUFFICIENT_BALANCE: "The wallet needs enough POL for the quoted purchase plus the owner-capped gas fee.",
        V14_GAS_BUDGET_EXCEEDED:
          "Estimated gas exceeds AIFINPAY_MAX_GAS_POL. The owner can review the limit; the agent cannot raise it.",
        V14_PAUSED: "The approved payment deployment is paused. No payment was sent.",
        V14_EXPIRED: "The signed quote expired before submission. Request a fresh quote.",
        V14_EXPIRING: "The signed quote expires too soon to submit safely. Request a fresh quote.",
        V14_STALE_NONCE: "The signed quote uses a stale wallet nonce. Request a fresh quote.",
      };
      return errorResult(
        messages[code ?? ""] ??
          "Payment verification refused this deployment, signer or quote. The merchant must offer a verified native Polygon v1.4 route; no fallback was attempted."
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
