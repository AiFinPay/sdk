// ──────────────────────────────────────────────────────────────────────────
// AIFP-1 client — paying a merchant paywall at gateway.aifinpay.io.
//
// The SDK could already pay a *bridge* (the x402 / pay_matic 402 handled inside
// AiFinPayAgent.call()), but not a *merchant paywall*. Those are different
// protocols with different money shapes, and only the second one is what a
// merchant switches on when they put their site behind AiFinPay:
//
//   GET https://gateway.aifinpay.io/{slug}/some/path
//     → 402 {error:"AIFP-402", protocol:"AIFP-1", merchant_id, resource,
//            unit_weight, how_to_pay[], scopes{}}          (routes/gateway.js)
//     → POST /v1/quote  → a binding quote                  (routes/aifp.js)
//     → settle the quote on-chain yourself, order_id = quote_id
//     → POST /v1/pay    → an Ed25519 JWT receipt
//     → retry with `AIFP-Receipt: <jwt>`
//
// THE PART THAT MATTERS: a receipt is a prepaid BATCH, not a ticket.
//
// It carries `unit_quota` billing units and each call spends the weight of the
// route it hits (routes/gateway.js meters `aifp:used:<receipt_id>` by the
// weight from the merchant's own registry). The minimum batch is $0.10
// (aifp/pricing.js MIN_BATCH_UNITS) and settling costs gas on top, so a client
// that quotes-settles-pays per request turns a $0.0001 page view into eleven
// cents and a chain transaction. Reuse is not an optimisation here; it is the
// difference between a payable site and an unpayable one.
//
// So this module keeps receipts and spends them down: it matches on merchant +
// scope, tracks the quota the gateway reports back in `AIFP-Quota-Remaining`,
// and only re-quotes when the batch is genuinely spent or expired.
//
// Deliberately a free function over a `deps` bag rather than a method: the
// money-moving step (settleSplitterNative) and the budget ledger live on
// AiFinPayAgent, but nothing else here does, and a test should be able to drive
// the whole protocol without an RPC endpoint.
// ──────────────────────────────────────────────────────────────────────────
import { createHash, createPublicKey, randomBytes, verify as verifySignature } from "node:crypto";
import bs58 from "bs58";
import { keccak256, parseUnits, stringToHex } from "viem";
import { paymentChain, paymentStableAsset, type PaymentChain } from "./paymentChains.js";
import { AiFinPayError } from "./errors.js";
import { validateV14SettlementCall, V14SettlementError, type V14SettlementCall } from "./settlementV14.js";
import { SettlementConfirmationPendingError } from "./settlement.js";
import { settlementHttp, SettlementHttpError } from "./settlementHttp.js";
import type { SpendLedgerBinding, QuoteAdmission } from "./spendLedger.js";
import {
  authorizedSolanaV14Inventory,
  solanaV14Inventory,
  validateSolanaV14Call,
  solanaStableMint,
  assertPreparedSolanaV14Recovery,
  readSolanaV14FinalizedFailure,
  solanaLamportCostUsd,
  SolanaV14Error,
  type SolanaV14Rpc,
  type SolanaV14SettlementCall,
  type SolanaV14Prepared,
  type SolanaV14Plan,
} from "./settlementSolanaV14.js";
import type { SolanaNetwork } from "./generated/solanaV14Deployments.generated.js";
import type { SdkEnvironment } from "./deploymentResolver.js";
import { reportingHeaders } from "./agent.js";
import type { SolanaV14Deployment } from "./generated/solanaV14Deployments.generated.js";

// ── Errors ────────────────────────────────────────────────────────────────
//
// Specific classes rather than one message, because the recoveries differ: a
// quote refusal is worth retrying with different arguments, a settlement the
// gateway then refuses is not something an agent should paper over, and an
// agent that silently pays the wrong merchant is worse than one that throws.

export class Aifp1Error extends AiFinPayError {}

/** /v1/quote refused, or answered something that is not a quote. */
export class Aifp1QuoteError extends Aifp1Error {}

/** The quote cannot be settled by this SDK (no asset we can send). */
export class Aifp1SettlementUnsupportedError extends Aifp1Error {}

/**
 * Money moved on-chain but /v1/pay did not issue a receipt.
 *
 * Carries the tx hash because that is the only thing standing between the
 * caller and a lost payment: the quote is still settleable through
 * `POST /v1/pay` by hand with the same Idempotency-Key, and without the hash
 * in the error there is nothing to retry with. `recovery` additionally preserves
 * the quote nonce and issuer domain needed to sign a fresh receipt claim.
 */
export class Aifp1PayError extends Aifp1Error {
  constructor(
    msg: string,
    public readonly txRef?: string,
    public readonly quoteId?: string,
    public readonly recovery?: Aifp1PaymentRecovery
  ) {
    super(msg);
  }
}
/** Canonical failed original transaction reconciled to one fee-only debit. */
export class Aifp1FinalizedFailureError extends Aifp1PayError {
  readonly code = "AIFP1_FINALIZED_FAILURE";
  constructor(
    recovery: Aifp1SolanaPaymentRecovery,
    public readonly feeAmountUsd: number,
    public readonly actualFeeLamports: bigint
  ) {
    super(
      "Original Solana transaction finalized with failure; fee-only debit reconciled without resending",
      recovery.txRef,
      recovery.quote.quote_id,
      recovery
    );
  }
}

/** Public settlement context; contains no private key or authorization signature. */
export interface Aifp1EvmPaymentRecovery {
  family?: "evm";
  apiBaseUrl: string;
  quote: Aifp1Quote;
  txRef: `0x${string}`;
  asset: string;
  /** Trusted payment chain saved before broadcast; omitted legacy journals mean Polygon. */
  chain?: Aifp1V14Chain;
  paymentIssuer?: string;
  /** Local budget identity; never an amount, cap or server-selected ledger path. */
  budgetReservationId?: string;
  /** Version2 binds the independent cross-family wallet identity. */
  budgetBindingVersion?: 2;
  serializedTransaction?: `0x${string}`;
}

export interface Aifp1SolanaPaymentRecovery extends Omit<
  Aifp1EvmPaymentRecovery,
  "family" | "chain" | "txRef" | "serializedTransaction"
> {
  family: "solana";
  chain: "solana";
  txRef: string;
  solana: SolanaV14Prepared;
  /** Locally validated gross plus fresh fee/rent cost; never recovery authority. */
  reservedAmountUsd: number;
  admissionSolUsdPrice: string;
  maxFeeLamports: string;
  transactionFeeLamports: string;
}
export type Aifp1PaymentRecovery = Aifp1EvmPaymentRecovery | Aifp1SolanaPaymentRecovery;
export type Aifp1SettlementChain = Aifp1V14Chain | "solana";
export interface Aifp1PaymentSigner {
  /** Independent local identity shared by all rails; never copied from a journal. */
  walletIdentity?: string;
  payerAddress: string;
  signPaymentAuthorization(message: string): Promise<string>;
  fetchImpl?: typeof fetch;
  assertReservation?(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void>;
  completeReservation?(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void>;
  finalizeFailedReservation?(id: string, txRef: string, binding: SpendLedgerBinding, feeUsd: number): Promise<void>;
  solanaRpc?: SolanaV14Rpc;
}
export type Aifp1RecoveryOptions = Pick<Aifp1FetchOptions, "settlementConfirmMs" | "apiTimeoutMs" | "paymentIssuer"> & {
  solanaNetwork?: SolanaNetwork;
  solanaEnvironment?: SdkEnvironment;
};

/** Exact owner/quote binding for a locally selected capped v1.4 payment. */
export function paymentBudgetBinding(
  payment: Pick<Aifp1PaymentRecovery, "apiBaseUrl" | "paymentIssuer" | "quote" | "chain" | "asset"> & {
    admissionSolUsdPrice?: string;
    maxFeeLamports?: string;
    transactionFeeLamports?: string;
  },
  payer: string,
  walletIdentity?: string
): SpendLedgerBinding {
  const call = payment.quote.settlement_call as V14SettlementCall | SolanaV14SettlementCall;
  if (call?.splitter_version !== "1.4") throw new Aifp1QuoteError("Bound budgets require the original v1.4 call");
  return {
    apiBaseUrl: payment.apiBaseUrl.replace(/\/+$/, ""),
    paymentIssuer: payment.paymentIssuer ?? "https://api.aifinpay.io",
    payer: payment.chain === "solana" ? payer : payer.toLowerCase(),
    ...(walletIdentity ? { walletIdentity } : {}),
    ...(payment.chain === "solana" && payment.admissionSolUsdPrice !== undefined
      ? {
          solanaAdmissionRateUsd: payment.admissionSolUsdPrice,
          solanaMaxFeeLamports: payment.maxFeeLamports,
          solanaTransactionFeeLamports: payment.transactionFeeLamports,
        }
      : {}),
    merchantId: payment.quote.merchant_id,
    scope: payment.quote.scope,
    resource: payment.quote.resource,
    networkMode: payment.quote.network_mode ?? "live",
    chain:
      payment.chain === "solana"
        ? `solana:${(call as SolanaV14SettlementCall).network}:${call.contract}:${(call as SolanaV14SettlementCall).idl_sha256}`
        : authorizedV14Chain(payment.chain),
    asset: payment.asset,
    token: payment.chain === "solana" ? call.args.quote.token : call.args.quote.token.toLowerCase(),
    grossAmount: call.args.quote.grossAmount,
    quoteId: payment.quote.quote_id,
  };
}

/** Recover an already settled payment. Never sends an on-chain transaction. */
export function recoverAifp1Payment(
  recovery: Aifp1PaymentRecovery,
  signer: Aifp1PaymentSigner,
  options: Aifp1RecoveryOptions = {}
): Promise<Aifp1PayResult> {
  if (recovery.family === "solana") {
    const call = recovery.quote.settlement_call as SolanaV14SettlementCall;
    if (!options.solanaNetwork || !options.solanaEnvironment)
      throw new Aifp1QuoteError("Solana recovery requires independent owner environment/network");
    const d = solanaV14Inventory(options.solanaEnvironment, options.solanaNetwork);
    assertPreparedSolanaV14Recovery(call, recovery.solana, d, signer.payerAddress, recovery.quote.quote_id);
    if (
      recovery.chain !== "solana" ||
      recovery.txRef !== recovery.solana.hash ||
      call.asset !== recovery.asset ||
      recovery.quote.payer !== signer.payerAddress ||
      recovery.quote.accepted_chains.join() !== "solana" ||
      recovery.quote.accepted_assets.join() !== recovery.asset
    )
      throw new Aifp1QuoteError("Solana recovery purchase mismatch");
    return (async () => {
      const binding = paymentBudgetBinding(
        recovery,
        signer.payerAddress,
        recovery.budgetBindingVersion === 2 ? signer.walletIdentity : undefined
      );
      if (recovery.budgetReservationId !== undefined) {
        if (!signer.assertReservation || !signer.completeReservation)
          throw new Aifp1QuoteError("Original bound ledger hooks required");
        await signer.assertReservation(recovery.budgetReservationId, recovery.txRef, binding);
      }
      if (signer.solanaRpc && signer.finalizeFailedReservation && recovery.budgetReservationId !== undefined) {
        let fee: bigint | null;
        try {
          solanaLamportCostUsd(0n, recovery.admissionSolUsdPrice);
          if (
            !/^(?:0|[1-9][0-9]*)$/.test(recovery.transactionFeeLamports) ||
            !/^[1-9][0-9]*$/.test(recovery.maxFeeLamports)
          )
            throw new Aifp1QuoteError("Original fee cap metadata is required");
          fee = await readSolanaV14FinalizedFailure(call, recovery.solana, {
            rpc: signer.solanaRpc,
            deployment: d,
            payer: signer.payerAddress,
            orderId: recovery.quote.quote_id,
            transactionFeeLamports: BigInt(recovery.transactionFeeLamports),
            maxFeeLamports: BigInt(recovery.maxFeeLamports),
          });
        } catch (error) {
          throw new Aifp1PayError(
            error instanceof Error ? error.message : "Failure proof is incomplete; retain original reservation",
            recovery.txRef,
            recovery.quote.quote_id,
            recovery
          );
        }
        if (fee !== null) {
          const feeUsd = solanaLamportCostUsd(fee, recovery.admissionSolUsdPrice);
          try {
            await signer.finalizeFailedReservation(recovery.budgetReservationId, recovery.txRef, binding, feeUsd);
          } catch (error) {
            throw new Aifp1PayError(
              error instanceof Error ? error.message : "Canonical failure fee journal requires reconciliation",
              recovery.txRef,
              recovery.quote.quote_id,
              recovery
            );
          }
          throw new Aifp1FinalizedFailureError(recovery, feeUsd, fee);
        }
      }
      const paid = await submitPayment(
        { ...signer, agentId: signer.payerAddress, fetchImpl: signer.fetchImpl ?? fetch },
        recovery.apiBaseUrl,
        recovery.quote,
        recovery.txRef,
        recovery.asset,
        "solana",
        { paymentIssuer: recovery.paymentIssuer, ...options }
      );
      if (recovery.budgetReservationId !== undefined)
        await signer.completeReservation!(recovery.budgetReservationId, recovery.txRef, binding);
      return paid;
    })();
  }
  const chain = authorizedV14Chain(recovery.chain);
  const call = recovery.quote.settlement_call;
  if (chain !== "polygon" && call?.splitter_version !== "1.4") {
    throw new Aifp1QuoteError(`Recovery on ${chain} requires the original v1.4 settlement call`);
  }
  if (
    call?.splitter_version === "1.4" &&
    (call.chain !== chain ||
      call.asset !== recovery.asset ||
      recovery.quote.accepted_chains.length !== 1 ||
      recovery.quote.accepted_chains[0] !== chain ||
      !recovery.quote.accepted_assets.includes(recovery.asset))
  ) {
    throw new Aifp1QuoteError("recovery chain or asset disagrees with the saved purchase");
  }
  if (recovery.budgetReservationId !== undefined) {
    if (
      typeof recovery.budgetReservationId !== "string" ||
      !recovery.budgetReservationId ||
      !/^0x(?:[0-9a-fA-F]{2})+$/.test(recovery.serializedTransaction ?? "") ||
      keccak256(recovery.serializedTransaction!) !== recovery.txRef ||
      !signer.assertReservation ||
      !signer.completeReservation
    ) {
      throw new Aifp1QuoteError("Bound budget recovery requires the original signed bytes and ledger hooks");
    }
    const binding = paymentBudgetBinding(
      recovery,
      signer.payerAddress,
      recovery.budgetBindingVersion === 2 ? signer.walletIdentity : undefined
    );
    return (async () => {
      await signer.assertReservation!(recovery.budgetReservationId!, recovery.txRef, binding);
      const paid = await submitPayment(
        { ...signer, agentId: signer.payerAddress, fetchImpl: signer.fetchImpl ?? fetch },
        recovery.apiBaseUrl,
        recovery.quote,
        recovery.txRef,
        recovery.asset,
        chain,
        { paymentIssuer: recovery.paymentIssuer, ...options }
      );
      await signer.completeReservation!(recovery.budgetReservationId!, recovery.txRef, binding);
      return paid;
    })();
  }
  return submitPayment(
    { ...signer, agentId: signer.payerAddress, fetchImpl: signer.fetchImpl ?? fetch },
    recovery.apiBaseUrl,
    recovery.quote,
    recovery.txRef,
    recovery.asset,
    chain,
    { paymentIssuer: recovery.paymentIssuer, ...options }
  );
}

/** The gateway rejected a receipt we believed covered the request. */
export class Aifp1ReceiptRejectedError extends Aifp1Error {}

// ── Wire shapes (mirrors of the server; do not invent fields) ─────────────

export type Aifp1Scope = "exact" | "prefix" | "merchant";

/** The 402 body — routes/gateway.js payChallenge(). */
export interface Aifp1Challenge {
  error: string; // "AIFP-402"
  protocol: string; // "AIFP-1"
  detail?: string;
  merchant_id: string;
  resource: string; // the merchant-relative path, no slug
  unit_weight: number; // billing units this route costs per call
  base_unit_price_usd?: string;
  how_to_pay?: string[];
  scopes?: { note?: string; examples?: string[] };
}

/** POST /v1/quote 200 body — routes/aifp.js (`used` is stripped server-side). */
export interface Aifp1Quote {
  quote_id: string;
  payer?: string;
  network_mode?: "live" | "test";
  payment_authorization?: {
    scheme: "wallet-signature-v1";
    domain: string;
    max_age_seconds: number;
  };
  merchant_id: string;
  resource: string;
  scope: Aifp1Scope;
  tier: string;
  unit_price: string;
  requests: number;
  units: number;
  unit_quota: number;
  amount: string; // batch total, USD, decimal string
  currency: string;
  accepted_assets: string[];
  accepted_chains: string[];
  pay_to: Record<string, string>;
  /** The target and calldata the receipt verifier expects for this quote. */
  settlement_call?:
    | V14SettlementCall
    | SolanaV14SettlementCall
    | {
        chain: string;
        contract: string;
        splitter_version: string;
        asset: string;
        function: string;
        arg_encoding: string;
        value_wei: string;
        args: {
          payment_id: string;
          merchant: string;
          gross_amount: string;
          ip_creator: string;
          valid_until: number;
          order_id: string;
        };
      };
  /** Exact stablecoin minor units; required for18dp, optional for legacy6dp. */
  token_settlement?: {
    asset: string;
    token: string;
    decimals: number;
    total_units: string;
    merchant_units: string;
    protocol_fee_units: string;
    creator_units: string;
    settlement_semantics: "gross-inclusive";
  };
  /** Native gross settlement in the selected chain currency, when backend readiness permits. */
  native_settlement?: Aifp1EvmNativeSettlement | Aifp1SolanaNativeSettlement;
  settlement: {
    batch_units: string;
    total_units: string;
    gross_units: string;
    payer_total_units: string;
    merchant_units: string;
    protocol_fee_units: string;
    creator_units: string;
    /** Canonical form, or the backend's retained legacy breakdown (not an extra fee). */
    fee_on_top: false | { provider: string; treasury: string; creator: string };
    settlement_semantics?: "gross-inclusive";
  };
  nonce: string;
  expires_at: string;
}

export interface Aifp1EvmNativeSettlement {
  asset: string;
  decimals: number;
  rate_usd: string;
  rate_fixed_at?: string;
  total_wei: string;
  gross_wei?: string;
  payer_total_wei?: string;
  merchant_wei: string;
  treasury_wei: string;
  creator_wei: string;
  valid_until?: number | string;
  settlement_semantics?: "gross-inclusive";
}
export interface Aifp1SolanaNativeSettlement {
  asset: "SOL";
  decimals: 9;
  rate_usd: string;
  rate_fixed_at?: string;
  total_lamports: string;
  merchant_lamports: string;
  treasury_lamports: string;
  creator_lamports: string;
  valid_until?: number | string;
  settlement_semantics: "gross-inclusive";
}

/**
 * A one-object, human-and-LLM-readable summary of what a quote actually buys.
 *
 * The raw quote answers "1.06 POL" and leaves the agent — or the person reading
 * over its shoulder — to work out FOR WHAT. That is the gap an agent-flow audit
 * flagged: a payment prompt that states an amount without the terms is a prompt
 * a careful agent should refuse, and a careless one over-pays on. Every field
 * here already exists in the quote; this just assembles them into the sentence
 * a reasonable payer needs before signing.
 */
export interface QuoteSummary {
  /** One line, safe to show a user or feed an LLM: what, how much, how many, until when. */
  headline: string;
  amount_usd: string;
  /** The on-chain figure and its asset, when the quote is settled natively. */
  pay: { amount: string; asset: string } | null;
  /** How many requests this batch covers, and each request's weight. */
  requests: number;
  unit_quota: number;
  /** WHERE the batch may be spent — the single most misread field (see the
   *  wildcard bug): "exact" buys one path, "prefix" buys a subtree. */
  scope: Aifp1Scope;
  resource: string;
  /** When the quote stops being settleable. */
  expires_at: string;
  /** The protocol fee, stated up front. */
  fee_bps: number | null;
}

export function describeQuote(q: Aifp1Quote): QuoteSummary {
  const ns = q.native_settlement;
  const pay = ns
    ? { amount: formatUnits("total_lamports" in ns ? ns.total_lamports : ns.total_wei, ns.decimals), asset: ns.asset }
    : null;

  // Fee as basis points, from the split the quote already carries. Stated so the
  // agent sees the rate, not just the total — the same reason the 402 does.
  let feeBps: number | null = null;
  try {
    const total = BigInt(q.settlement.gross_units);
    const merchant = BigInt(q.settlement.merchant_units);
    if (total > 0n) feeBps = Number(((total - merchant) * 10000n) / total);
  } catch {
    /* leave null rather than guess */
  }

  const where =
    q.scope === "merchant"
      ? `anything on ${q.merchant_id}`
      : q.scope === "prefix"
        ? `any path under ${q.resource}`
        : q.resource;

  const payPart = pay ? `${pay.amount} ${pay.asset}` : `$${q.amount}`;
  const headline =
    `Pay ${payPart} ($${q.amount}) for ${q.requests} request${q.requests === 1 ? "" : "s"} ` +
    `to ${where}` +
    (feeBps != null ? ` (incl. ${(feeBps / 100).toFixed(2)}% fee)` : "") +
    `, valid until ${q.expires_at}.`;

  return {
    headline,
    amount_usd: q.amount,
    pay,
    requests: q.requests,
    unit_quota: q.unit_quota,
    scope: q.scope,
    resource: q.resource,
    expires_at: q.expires_at,
    fee_bps: feeBps,
  };
}

/** wei/lamports → a decimal string with the asset's own decimals, no float. */
function formatUnits(raw: string, decimals: number): string {
  const n = BigInt(raw);
  const base = 10n ** BigInt(decimals);
  const whole = n / base;
  const frac = (n % base).toString().padStart(decimals, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : `${whole}`;
}

/** POST /v1/pay 200 body — routes/aifp.js. */
export interface Aifp1PayResult {
  network?: SolanaNetwork;
  program?: string;
  receipt_id: string;
  receipt: string; // the bearer JWT
  status: string; // "settled"
  tx_ref: string;
  merchant_id: string;
  resource: string;
  scope: Aifp1Scope;
  amount: string;
  currency: string;
  quota: number;
  unit_quota: number;
  asset: string;
  chain: string;
  settled_at: string;
  expires_at: string;
  policy_exceeded?: boolean;
  policy_reason?: string;
}

// ── Scope, ported from the server ─────────────────────────────────────────
//
// backend/aifp/scope.js decides whether a receipt covers a request, and this
// is the same decision made one round-trip earlier. It is a port, not an
// approximation: a client that is *stricter* wastes money on batches it
// already owns, and one that is *looser* sends a receipt the gateway answers
// 403 for. Keep the two in step.

/** Mirror of scope.js scopeCovers(). */
export function scopeCovers(scope: string | undefined, resource: string, path: string): boolean {
  if (scope === "merchant") return true;
  if (scope === "prefix") {
    if (resource === "/") return true; // whole site, spelled as a prefix
    if (path === resource) return true; // the prefix path itself
    // The trailing slash is what stops /articles covering /articles-internal.
    const boundary = resource.endsWith("/") ? resource : resource + "/";
    return path.startsWith(boundary);
  }
  return patternCovers(resource, path); // 'exact', and anything unrecognised
}

/**
 * Mirror of scope.js patternCovers(): a merchant registers "/movies/*" as ONE
 * resource, and both the 402 and the receipt name that pattern rather than the
 * URL. It covers "/movies" and everything under "/movies/".
 *
 * This port stopped at `path === resource` while the server and @aifinpay/gate
 * learnt wildcards, so a direct Raters page (402 for "/movies/*" on
 * "/movies/11/that-70s-show") was refused before quoting, and a receipt bought
 * for the pattern was never found in the cache for the next page.
 */
export function patternCovers(pattern: string, path: string): boolean {
  const pat = String(pattern || "");
  if (!pat.endsWith("/*")) return path === pat;
  return path === pat.slice(0, -2) || path.startsWith(pat.slice(0, -1));
}

/**
 * Mirror of routes/gateway.js prefixHint(): /articles/2026/thing → /articles/,
 * and a single-segment path → "/" (the whole site).
 */
export function prefixHint(path: string): string {
  const segs = String(path || "/")
    .split("/")
    .filter(Boolean);
  return segs.length > 1 ? `/${segs[0]}/` : "/";
}

/**
 * Split a gateway URL the way routes/gateway.js splits it: first path segment
 * is the merchant slug, the rest is the merchant-relative resource, and the
 * query string is not part of either.
 *
 * `site` (origin + slug) is the cache key. It is the only merchant identity
 * available before the first 402 answers with a merchant_id, and slug →
 * merchant is a 1:1 lookup server-side (gw.resolveSlug).
 */
/**
 * Gateway origins this client will settle against.
 *
 * Without this the client paid whoever answered. parseGatewayUrl looked only
 * at the path, so ANY host could return {error:"AIFP-402", protocol:"AIFP-1",
 * merchant_id:"mrch_theirs"} and the agent would quote, settle real POL to the
 * address in that quote, and hand over a receipt. The 402 is unauthenticated
 * by construction — it is the answer to a request that carried no credentials —
 * so the only thing separating a paywall from a trap is knowing whose paywall
 * it is.
 *
 * Override for self-hosted gateways; an empty list is refused rather than
 * treated as "allow all", because that is the shape a config bug takes.
 */
export const DEFAULT_GATEWAY_ORIGINS = ["https://gateway.aifinpay.io"] as const;

export function parseGatewayUrl(
  url: string,
  allowedOrigins: readonly string[] = DEFAULT_GATEWAY_ORIGINS,
  resourcePathMode: "gateway" | "direct" = "gateway"
): { site: string; slug: string; restPath: string } {
  if (resourcePathMode !== "gateway" && resourcePathMode !== "direct") {
    throw new Aifp1Error("resourcePathMode must be 'gateway' or 'direct'");
  }
  const u = new URL(url);
  if (!allowedOrigins.length) {
    throw new Aifp1Error(
      "no allowed gateway origins configured — refusing to pay any host. " +
        "Pass gatewayOrigins explicitly for a self-hosted gateway."
    );
  }
  if (!allowedOrigins.includes(u.origin)) {
    throw new Aifp1Error(
      `${u.origin} is not a known AiFinPay gateway (allowed: ${allowedOrigins.join(", ")}). ` +
        "Refusing to settle: a 402 is unauthenticated, so paying an unrecognised host " +
        "means paying whoever answered."
    );
  }
  if (resourcePathMode === "direct") {
    return { site: u.origin, slug: "", restPath: u.pathname };
  }
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Aifp1Error(
      `${url} has no merchant slug — a gateway URL looks like https://gateway.aifinpay.io/{slug}/path`
    );
  }
  const slug = segments[0]!;
  return {
    site: `${u.origin}/${slug}`,
    slug,
    restPath: "/" + segments.slice(1).join("/"),
  };
}

/**
 * The `exp` of a receipt JWT, in ms, without verifying it — we are not
 * authenticating the token here, only recovering a expiry the response failed
 * to state. Returns null if the claim is absent or unreadable.
 */
export function jwtExpiryMs(jwt: string): number | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return typeof json.exp === "number" ? json.exp * 1000 : null;
  } catch {
    return null;
  }
}

// ── Idempotency ───────────────────────────────────────────────────────────

/**
 * The Idempotency-Key for one /v1/pay call. Required by the server
 * (routes/aifp.js: 400 without it) and load-bearing here for a different
 * reason: it is what stops one settled transaction being turned into two
 * receipts, or a network blip during /v1/pay from becoming a second on-chain
 * payment on retry.
 *
 * Derived from exactly the four fields the server itself hashes into its
 * idempotency record — quote_id, asset, chain, tx_ref. That equivalence is the
 * point:
 *
 *   • the same payment retried ⇒ the same key ⇒ the server replays the first
 *     response instead of issuing a second receipt;
 *   • a different payment ⇒ a different key, because a different payment must
 *     differ in at least one of those four (quote_id alone is single-use —
 *     `quote.used` makes a second settlement of one quote a 409);
 *   • and the server's "same key, different body → 409" branch is unreachable
 *     from this client, since the key is a pure function of that body.
 *
 * A random key would satisfy the header requirement and none of the above.
 */
export function idempotencyKeyFor(p: { quoteId: string; chain: string; asset: string; txRef: string }): string {
  const digest = createHash("sha256").update(`aifp1|${p.quoteId}|${p.asset}|${p.chain}|${p.txRef}`).digest("hex");
  return `aifp1-${digest}`; // 70 chars — well under the server's 200 limit
}

// ── Receipt cache ─────────────────────────────────────────────────────────

export interface Aifp1CachedReceipt {
  /** origin + slug, as parseGatewayUrl() computes it. */
  site: string;
  merchantId: string;
  receiptId: string;
  /** The bearer JWT. Never log this. */
  jwt: string;
  scope: Aifp1Scope;
  resource: string;
  unitQuota: number;
  /** Billing units we believe are left. Corrected from AIFP-Quota-Remaining. */
  remaining: number;
  /** JWT expiry, ms epoch. */
  expiresAt: number;
  amountUsd: number;
}

/**
 * How close to expiry a receipt is still worth sending.
 *
 * A JWT that expires while the request is in flight comes back as a 402 with
 * `receipt expired`, which costs a round-trip and, worse, looks exactly like
 * an exhausted batch — so the client would re-quote and pay for a batch it
 * still had. Ten seconds of margin is cheap insurance against clock skew.
 */
const EXPIRY_MARGIN_MS = 10_000;

/**
 * The receipts this agent holds, and the rules for spending them.
 *
 * In-memory and per-agent-instance: a receipt is a bearer credential, and
 * writing one to disk by default would be a bigger decision than a cache
 * deserves. An agent that wants batches to survive a restart can hold the
 * entries itself (they are plain data) and re-seed a cache.
 */
export class Aifp1ReceiptCache {
  private readonly entries: Aifp1CachedReceipt[] = [];

  /**
   * Batch purchases in flight, keyed by site.
   *
   * The cache is empty between deciding to buy and the receipt arriving, so
   * ten workers sharing one agent all missed, all got a 402, and all settled
   * their own batch — ten on-chain payments and ten minimum charges where one
   * would have covered every worker. It recurred at each quota boundary, so
   * the more traffic an agent had the more it overpaid.
   *
   * Second and later callers await the first purchase, then re-check the
   * cache: whoever wins buys a batch wide enough that the rest find it
   * covering their path too. If it does not cover them (a different prefix)
   * they fall through and buy their own, which is correct — that is a
   * different batch, not a duplicate.
   */
  private readonly inflight = new Map<string, Promise<unknown>>();

  /** Run `buy` for `site`, or await the purchase already running for it. */
  async coalesce<T>(site: string, buy: () => Promise<T>): Promise<T | "retry"> {
    const running = this.inflight.get(site);
    if (running) {
      // The winner may already have paid. Share its failure and recovery
      // context; swallowing it would let every waiter buy another batch.
      await running;
      return "retry";
    }
    const p = buy().finally(() => {
      this.inflight.delete(site);
    });
    this.inflight.set(site, p);
    return p;
  }

  /**
   * The receipt to send for this request, if we hold one.
   *
   * Three conditions, all necessary:
   *   • same merchant — a receipt's `aud` is the merchant id, so sending one
   *     elsewhere is at best a 403 and at worst paying the wrong party;
   *   • the scope covers the path — the same test the gateway will apply;
   *   • quota left and not expired.
   *
   * `remaining > 0` rather than `remaining >= weight`: we only learn a route's
   * weight from a 402 refusing it, so the weight of a path we have not been
   * refused on is genuinely unknown here. The gateway's meter is authoritative
   * and answers 402 "quota exhausted" when the batch cannot cover the call —
   * at which point we re-quote. Guessing a weight would only add a way to be
   * wrong in the direction of not spending a batch we own.
   */
  find(site: string, restPath: string, merchantId?: string): Aifp1CachedReceipt | undefined {
    const now = Date.now();
    return this.entries.find(
      (e) =>
        e.site === site &&
        (merchantId === undefined || e.merchantId === merchantId) &&
        e.remaining > 0 &&
        e.expiresAt - EXPIRY_MARGIN_MS > now &&
        scopeCovers(e.scope, e.resource, restPath)
    );
  }

  put(entry: Aifp1CachedReceipt): void {
    this.entries.push(entry);
  }

  /** The gateway's own count wins over ours — it is the one doing the metering. */
  noteQuotaRemaining(entry: Aifp1CachedReceipt, remaining: number): void {
    if (Number.isFinite(remaining)) entry.remaining = Math.max(0, remaining);
  }

  evict(entry: Aifp1CachedReceipt): void {
    const i = this.entries.indexOf(entry);
    if (i >= 0) this.entries.splice(i, 1);
  }

  /** Everything we still hold, expired entries dropped. Plain data, copyable. */
  list(): Aifp1CachedReceipt[] {
    const now = Date.now();
    return this.entries.filter((e) => e.expiresAt > now);
  }

  /**
   * Redacted view for dashboards and MCP tools: everything except the bearer
   * `jwt` (a credential — only the paying agent holds it). Safe to log.
   */
  summary(): Omit<Aifp1CachedReceipt, "jwt">[] {
    return this.list().map(({ jwt: _jwt, ...rest }) => rest);
  }

  get size(): number {
    return this.entries.length;
  }
}

// ── Options ───────────────────────────────────────────────────────────────

export type Aifp1V14Chain = PaymentChain;

export interface Aifp1FetchOptions {
  /** Explicit reporting.v2 capability. Sent only to canonical first-party
   * /v1/quote, in memory; never pay/auth/access/journal/recovery authority. */
  reportingToken?: string;
  /** Solana is explicitly owner-authorized; cannot coexist with EVM v14.
   * maxFeeLamports includes transaction fees AND nonce/ATA account rent. */
  solanaV14?: {
    environment: SdkEnvironment;
    network: SolanaNetwork;
    asset?: string;
    maxFeeLamports: bigint;
    onPrepared: (payment: Aifp1SolanaPaymentRecovery) => Promise<void>;
  };
  /** Explicit native v1.4 authorization. Deployment/signer pins come from the
   * SDK registry, never from a merchant response. The journal must be durable
   * before broadcast; a prepared transaction must be recovered, never replaced. */
  v14?: {
    /** Independently selected payment chain. Defaults to Polygon; never inferred from a quote. */
    chain?: Aifp1V14Chain;
    /**
     * Native currency (POL/ETH), or a stablecoin pinned for the selected chain.
     * Defaults to native. Stablecoins need no nativeUsdPrice; maxGasWei covers
     * approval and settlement. On Base it includes buffered L1/operator fee
     * estimates, which can change before inclusion and are not a consensus cap.
     */
    asset?: string;
    maxGasWei: bigint;
    onPrepared: (payment: Aifp1PaymentRecovery & { serializedTransaction: `0x${string}` }) => Promise<void>;
  };

  /** Reviewed v1.3 deployment pin, supplied independently of the quote server.
   * The receipt flow currently verifies Polygon native settlements only. */
  settlementPin?: import("./settlement.js").TrustedSettlementRoutePin;
  /** Independent native/USD observation from the caller's trusted price source,
   * never copied from the payment quote. POL/USD on Polygon, ETH/USD on Base.
   * Required for native v1.3/v1.4 payments; <=60s old. */
  nativeUsdPrice?: { usd: number; observedAtMs: number } | (() => Promise<{ usd: number; observedAtMs: number }>);
  /**
   * How wide a batch to buy. Default "prefix" — see the comment on
   * resolveScope() for why the default is not "exact".
   */
  scope?: Aifp1Scope;
  /** Override the resource the batch is scoped to (ignored for "merchant"). */
  resource?: string;
  /**
   * Billing units to prepay. Omit it and the client buys roughly
   * DEFAULT_BATCH_USD worth, computed from the base unit price the gateway
   * states in its own 402 — so the batch stays the same amount of MONEY when
   * the tiers move.
   */
  units?: number;
  /** Maximum quoted batch cost in USD; only tightens the agent's budget caps. */
  maxAmountUsd?: number;
  /** Where /v1/quote and /v1/pay live. Default https://api.aifinpay.io */
  apiBaseUrl?: string;
  /** Per-API request deadline, including the body. Default 15 seconds. */
  apiTimeoutMs?: number;
  /** Independently configured receipt issuer. Defaults to https://api.aifinpay.io. */
  paymentIssuer?: string;
  /**
   * Gateway origins this client will settle against. Defaults to
   * DEFAULT_GATEWAY_ORIGINS — set it only for a self-hosted gateway, and
   * never to a host you do not control the paywall of.
   */
  gatewayOrigins?: readonly string[];
  /**
   * "gateway" strips the hosted merchant slug (default). "direct" uses the
   * full URL pathname and probes for the merchant before reusing a receipt.
   * Direct origins must still be explicitly trusted through gatewayOrigins.
   */
  resourcePathMode?: "gateway" | "direct";
  /** Value for the AIFP-Agent-Id header; defaults to the agent's EVM address. */
  agentId?: string;
  /** How long to keep retrying /v1/pay while the chain catches up (AIFP-425). */
  settlementConfirmMs?: number;
}

/** Default batch size: 1000 billing units — the $0.10 floor, and the size the
 *  gateway's own how_to_pay examples suggest (routes/gateway.js). If an
 *  operator has raised AIFP_MIN_BATCH_UNITS, /v1/quote answers 400 naming the
 *  real minimum, which is loud rather than silently underpaid. */
/**
 * What a default batch costs, in USD — not how many units it is.
 *
 * This was a fixed 1000 units, "= $0.10 at the base unit price", and it was.
 * Then the tiers were re-priced on 2026-08-07 and the base unit went from
 * $0.0001 to $0.0005, so the same constant silently became a $0.50 batch:
 * five times the money, with the comment beside it still saying ten cents.
 * A unit count is a number about our internal accounting; an agent budgets in
 * dollars. Fixing the constant would have fixed today and broken the next
 * re-price, so the count is derived instead.
 */
const DEFAULT_BATCH_USD = 0.1;
/** Used only when a 402 omits base_unit_price_usd — matches $0.10 at $0.0005. */
const FALLBACK_UNITS = 200;

/** Units to buy so the batch is worth about DEFAULT_BATCH_USD. */
export function defaultUnitsFor(challenge: Pick<Aifp1Challenge, "base_unit_price_usd">): number {
  const base = Number(challenge.base_unit_price_usd);
  if (!Number.isFinite(base) || base <= 0) return FALLBACK_UNITS;
  return Math.max(1, Math.ceil(DEFAULT_BATCH_USD / base));
}
const DEFAULT_API_BASE = "https://api.aifinpay.io";
const DEFAULT_SETTLEMENT_CONFIRM_MS = 60_000;

/**
 * Which scope to buy, and why the default is "prefix".
 *
 * The server's default is "exact" — one path per batch — because that is what
 * every pre-scope client sent and back-compat had to hold. It is the right
 * shape for an API an agent hammers, and the wrong one for everything else:
 * each distinct URL then needs its own quote, its own on-chain settlement and
 * its own $0.10 floor, so an agent reading a hundred articles pays $10 for
 * $0.01 of content and burns a hundred transactions' gas doing it. A client
 * that inherits the server's default inherits that bill, so this one does not.
 *
 * "prefix" over "merchant" is the deliberate part. Both cost exactly the same
 * — scope decides *where* units may be spent, never how many a call costs
 * (aifp/scope.js) — so the trade is not money, it is blast radius: the receipt
 * is a bearer JWT, and a merchant-scoped one is the agent's entire prepaid
 * balance with that merchant in a single token. "prefix" buys the case that
 * was actually ruinous (crawling one section of a site) while keeping the
 * token bound to the section we were refused on. It is also the server's own
 * suggestion — prefixHint() is what the 402's `scopes.examples` offers.
 *
 * Note that prefixHint collapses a single-segment path to "/", i.e. the whole
 * site, so the shallow-crawl case is covered by one batch anyway.
 *
 * Pass `scope: "merchant"` when the agent is crawling across sections and the
 * round-trips matter more than the blast radius.
 */
function resolveScope(
  opts: Aifp1FetchOptions,
  challenge: Aifp1Challenge
): { scope: Aifp1Scope; resource: string | undefined } {
  const scope = opts.scope ?? "prefix";
  if (scope === "merchant") return { scope, resource: undefined }; // server stores "*"
  if (opts.resource) return { scope, resource: opts.resource };
  return {
    scope,
    resource: scope === "prefix" ? prefixHint(challenge.resource) : challenge.resource,
  };
}

// ── The driver ────────────────────────────────────────────────────────────

/**
 * Everything the flow needs that is not the AIFP-1 protocol itself. The
 * settlement and the budget hooks are AiFinPayAgent's; splitting them out is
 * what lets the protocol be tested without a chain.
 */
export interface Aifp1Deps {
  walletIdentity?: string;
  /** Independently configured RPC/owner limits, never recovered from the journal. */
  quoteOwnerContext?: string;
  beginQuoteAdmission?(
    binding: SpendLedgerBinding,
    context: string,
    create: () => Promise<{ requestBody: string; statement: string }>
  ): Promise<QuoteAdmission>;
  adoptQuoteAdmission?(id: string, binding: SpendLedgerBinding, context: string, quoteJson: string): Promise<void>;
  closeQuoteAdmission?(
    id: string,
    binding: SpendLedgerBinding,
    context: string,
    terminal: "not-admitted" | "expired-unbroadcast",
    quoteJson?: string
  ): Promise<void>;
  verifyHistoricalSolanaQuote?(
    call: SolanaV14SettlementCall,
    auth: NonNullable<Aifp1FetchOptions["solanaV14"]>,
    orderId: string
  ): Promise<void>;
  prepareSolana?(
    call: SolanaV14SettlementCall,
    authorization: NonNullable<Aifp1FetchOptions["solanaV14"]>,
    orderId: string
  ): Promise<SolanaV14Plan>;
  settleSolana?(plan: SolanaV14Plan, onPrepared: (tx: SolanaV14Prepared) => Promise<void>): Promise<SolanaV14Prepared>;
  fetchImpl: typeof fetch;
  cache: Aifp1ReceiptCache;
  /** AIFP-Agent-Id / agent_id — a 0x address, or agent policies cannot key on it. */
  agentId: string;
  /** Actual settlement wallet, independent of any display/agent identifier. */
  payerAddress: string;
  signPaymentAuthorization(message: string): Promise<string>;
  /**
   * Settle one canonical v1.3 gross amount, returning a hash whose transaction
   * was included AND succeeded. Implementations must independently verify the
   * deployment/runtime profile before signing.
   */
  settle(p: {
    merchantWallet: `0x${string}`;
    grossWei: bigint;
    merchantWei: bigint;
    treasuryWei: bigint;
    creatorWei: bigint;
    validUntil: bigint;
    orderId: string;
    settlementCall?: Aifp1Quote["settlement_call"];
    /** The token a stablecoin purchase was authorized in; omitted = native. */
    token?: `0x${string}`;
    onPrepared?: (tx: { hash: `0x${string}`; serializedTransaction: `0x${string}` }) => Promise<void>;
  }): Promise<`0x${string}`>;
  /** Per-call cap. false ⇒ the caller asked to skip rather than throw. */
  checkPerCall(usd: number): boolean;
  /** Daily cap. "skip" ⇒ drop the call; a string is a reservation to resolve. */
  reserveDaily(usd: number, binding?: SpendLedgerBinding, admissionId?: string): Promise<string | null | "skip">;
  commit(reservationId: string, usd: number): Promise<void>;
  release(reservationId: string): Promise<void>;
  prepareReservation?(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void>;
  assertReservation?(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void>;
  completeReservation?(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void>;
  finalizeFailedReservation?(id: string, txRef: string, binding: SpendLedgerBinding, feeUsd: number): Promise<void>;
  onPaid?(info: { merchantId: string; amountUsd: number; txRef: string; receiptId: string }): void;
}

function validateCanonicalQuoteEconomics(quote: Aifp1Quote): void {
  try {
    const s = quote.settlement;
    const gross = BigInt(s.gross_units);
    const payer = BigInt(s.payer_total_units);
    const total = BigInt(s.total_units);
    const merchant = BigInt(s.merchant_units);
    const protocol = BigInt(s.protocol_fee_units);
    const creator = BigInt(s.creator_units);
    const expectedProtocol = gross / 100n;
    // Older backend clients consume this unfortunately named breakdown. It
    // cannot be dropped during a rolling upgrade. Only accept it as inclusive
    // when the explicit semantics and every leg agree with the canonical data.
    const legacy = s.fee_on_top;
    const matches = (value: unknown, expected: bigint) =>
      typeof value === "string" && /^\d+$/.test(value) && BigInt(value) === expected;
    const inclusiveLegacy =
      s.settlement_semantics === "gross-inclusive" &&
      legacy !== null &&
      typeof legacy === "object" &&
      !Array.isArray(legacy) &&
      matches(legacy.provider, merchant) &&
      matches(legacy.treasury, protocol) &&
      matches(legacy.creator, creator);
    if (
      (s.fee_on_top !== false && !inclusiveLegacy) ||
      gross <= 0n ||
      payer !== gross ||
      total !== gross ||
      creator !== 0n ||
      protocol !== expectedProtocol ||
      merchant !== gross - expectedProtocol
    ) {
      throw new Error("split mismatch");
    }
  } catch {
    throw new Aifp1QuoteError(
      `quote ${quote.quote_id} does not implement canonical AIFP-1 gross economics (payer 100%, merchant 99%, protocol 1%, creator 0%)`
    );
  }
}

function validateSolanaQuote(
  quote: Aifp1Quote,
  auth: NonNullable<Aifp1FetchOptions["solanaV14"]>,
  payer: string,
  expiryMs: number,
  d: SolanaV14Deployment,
  historical = false
): void {
  const call = quote.settlement_call as SolanaV14SettlementCall;
  validateSolanaV14Call(call, d, payer, quote.quote_id, historical);
  const asset = auth.asset ?? "SOL",
    q = call.args.quote,
    gross = BigInt(q.grossAmount),
    treasury = gross / 100n;
  if (
    !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(quote.amount) ||
    quote.accepted_chains.join() !== "solana" ||
    quote.accepted_assets.join() !== asset ||
    call.asset !== asset ||
    quote.payer !== payer ||
    q.merchant !== quote.pay_to.solana ||
    q.validUntil !== String(Math.floor(expiryMs / 1000)) ||
    quote.settlement.total_units !== parseUnits(quote.amount, 6).toString()
  )
    throw new Aifp1QuoteError("Solana quote amount/payer/network/merchant binding mismatch");
  if (asset === "SOL") {
    const n = quote.native_settlement as Aifp1SolanaNativeSettlement;
    if (
      !n ||
      n.asset !== "SOL" ||
      n.decimals !== 9 ||
      n.settlement_semantics !== "gross-inclusive" ||
      n.total_lamports !== q.grossAmount ||
      n.merchant_lamports !== String(gross - treasury) ||
      n.treasury_lamports !== String(treasury) ||
      n.creator_lamports !== "0" ||
      quote.token_settlement !== undefined ||
      (n.valid_until !== undefined && String(n.valid_until) !== q.validUntil)
    )
      throw new Aifp1QuoteError("SOL9 gross-inclusive amount mismatch");
  } else {
    const t = quote.token_settlement;
    if (
      quote.native_settlement !== undefined ||
      !t ||
      t.asset !== asset ||
      t.token !== solanaStableMint(auth.network, asset) ||
      t.decimals !== 6 ||
      t.settlement_semantics !== "gross-inclusive" ||
      t.total_units !== q.grossAmount ||
      t.total_units !== parseUnits(quote.amount, 6).toString() ||
      t.merchant_units !== String(gross - treasury) ||
      t.protocol_fee_units !== String(treasury) ||
      t.creator_units !== "0"
    )
      throw new Aifp1QuoteError("SPL6 token gross-inclusive amount mismatch");
  }
}

async function settleSolanaBatch(
  deps: Aifp1Deps,
  opts: Aifp1FetchOptions,
  quote: Aifp1Quote,
  plan: SolanaV14Plan,
  amountUsd: number,
  binding: SpendLedgerBinding,
  reservation: string | null,
  site: string,
  send: (receipt?: string) => Promise<Response>,
  markSettled: () => void
): Promise<Response> {
  const auth = opts.solanaV14!;
  if (
    typeof reservation === "string" &&
    (!deps.prepareReservation || !deps.assertReservation || !deps.completeReservation)
  )
    throw new Aifp1QuoteError("Solana capped payments require durable bound-journal hooks");
  let prepared: SolanaV14Prepared | undefined;
  const recoveryFor = (tx: SolanaV14Prepared): Aifp1SolanaPaymentRecovery => ({
    family: "solana",
    chain: "solana",
    apiBaseUrl: opts.apiBaseUrl ?? DEFAULT_API_BASE,
    paymentIssuer: opts.paymentIssuer,
    ...(deps.walletIdentity ? { budgetBindingVersion: 2 as const } : {}),
    quote,
    asset: auth.asset ?? "SOL",
    txRef: tx.hash,
    solana: tx,
    reservedAmountUsd: amountUsd,
    admissionSolUsdPrice: binding.solanaAdmissionRateUsd!,
    maxFeeLamports: binding.solanaMaxFeeLamports!,
    transactionFeeLamports: binding.solanaTransactionFeeLamports!,
    ...(typeof reservation === "string" ? { budgetReservationId: reservation } : {}),
  });
  let result: SolanaV14Prepared;
  try {
    result = await deps.settleSolana!(plan, async (tx) => {
      assertPreparedSolanaV14Recovery(
        quote.settlement_call as SolanaV14SettlementCall,
        tx,
        plan.deployment,
        deps.payerAddress,
        quote.quote_id
      );
      if (typeof reservation === "string") await deps.prepareReservation!(reservation, tx.hash, binding);
      await auth.onPrepared(recoveryFor(tx));
      prepared = tx;
    });
  } catch (error) {
    if (prepared) {
      markSettled(); // Unknown funds remain reserved even after blockhash expiry.
      if (
        error instanceof SolanaV14Error &&
        error.code === "SOLANA_V14_TRANSACTION_REVERTED" &&
        error.prepared?.hash === prepared.hash &&
        error.actualFeeLamports !== undefined &&
        error.actualFeeLamports <= BigInt(binding.solanaMaxFeeLamports!) &&
        typeof reservation === "string" &&
        deps.finalizeFailedReservation
      ) {
        const feeUsd = solanaLamportCostUsd(error.actualFeeLamports, binding.solanaAdmissionRateUsd!);
        try {
          await deps.finalizeFailedReservation(reservation, prepared.hash, binding, feeUsd);
        } catch (error) {
          throw new Aifp1PayError(
            error instanceof Error ? error.message : "Canonical failure fee journal requires reconciliation",
            prepared.hash,
            quote.quote_id,
            recoveryFor(prepared)
          );
        }
        throw new Aifp1FinalizedFailureError(recoveryFor(prepared), feeUsd, error.actualFeeLamports);
      }
      throw new Aifp1PayError(
        "Solana transaction prepared; recover its original signature without resending",
        prepared.hash,
        quote.quote_id,
        recoveryFor(prepared)
      );
    }
    throw error;
  }
  markSettled();
  const recovery = recoveryFor(result);
  try {
    if (typeof reservation === "string") await deps.commit(reservation, amountUsd);
    const paid = await submitPayment(deps, recovery.apiBaseUrl, quote, result.hash, recovery.asset, "solana", opts);
    if (typeof reservation === "string") await deps.completeReservation!(reservation, result.hash, binding);
    deps.cache.put({
      site,
      merchantId: paid.merchant_id,
      receiptId: paid.receipt_id,
      jwt: paid.receipt,
      scope: paid.scope,
      resource: paid.resource,
      unitQuota: paid.unit_quota,
      remaining: paid.unit_quota,
      expiresAt: Date.parse(paid.expires_at),
      amountUsd,
    });
    const response = await send(paid.receipt);
    if (response.status === 402)
      throw new Aifp1ReceiptRejectedError("Gateway rejected paid Solana receipt; recover existing purchase");
    deps.onPaid?.({ merchantId: paid.merchant_id, amountUsd, txRef: result.hash, receiptId: paid.receipt_id });
    return response;
  } catch (error) {
    throw new Aifp1PayError(
      error instanceof Error ? error.message : "Solana receipt recovery required",
      result.hash,
      quote.quote_id,
      recovery
    );
  }
}

/** Is this response the AIFP-1 paywall asking for money? */
function isAifp1Challenge(body: unknown): body is Aifp1Challenge {
  const b = body as Partial<Aifp1Challenge> | null;
  return !!b && b.protocol === "AIFP-1" && typeof b.merchant_id === "string" && typeof b.resource === "string";
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Billing units the gateway says are left, or null when it did not say. */
function quotaRemaining(resp: Response): number | null {
  const raw = resp.headers.get("AIFP-Quota-Remaining");
  if (raw === null) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? Math.max(0, n) : null;
}

/**
 * Fetch a gateway URL, paying the AIFP-1 paywall if it asks.
 *
 * Returns the merchant's response. Returns null only when a budget cap was hit
 * and `on_limit_exceeded` is "skip" — the same contract AiFinPayAgent.call()
 * already has.
 */
export async function aifp1Fetch(
  deps: Aifp1Deps,
  url: string,
  init: RequestInit = {},
  opts: Aifp1FetchOptions = {}
): Promise<Response | null> {
  if (opts.maxAmountUsd !== undefined && (!Number.isFinite(opts.maxAmountUsd) || opts.maxAmountUsd < 0)) {
    throw new Aifp1QuoteError("maxAmountUsd must be nonnegative and finite");
  }
  if (opts.v14 && opts.solanaV14) throw new Aifp1QuoteError("Only one payment family may be authorized");
  const sol = opts.solanaV14;
  const evmChain = authorizedV14Chain(opts.v14?.chain);
  const chain: Aifp1SettlementChain = sol ? "solana" : evmChain;
  const solDeployment = sol ? authorizedSolanaV14Inventory(sol.environment, sol.network) : undefined;
  if (sol && (typeof sol.maxFeeLamports !== "bigint" || sol.maxFeeLamports <= 0n))
    throw new Aifp1QuoteError("Explicit positive Solana fee plus rent budget required");
  const nativeAsset = sol ? "SOL" : paymentChain(evmChain)!.native;
  const direct = opts.resourcePathMode === "direct";
  const parsed = parseGatewayUrl(url, opts.gatewayOrigins ?? DEFAULT_GATEWAY_ORIGINS, opts.resourcePathMode);
  let site = parsed.site;
  const restPath = parsed.restPath;
  let directMerchant: string | undefined;

  // A paid flow sends the request twice, so the body has to survive being sent
  // twice. A stream cannot, and finding that out after paying would mean money
  // moved for a request that can no longer be made.
  if (
    init.body !== undefined &&
    init.body !== null &&
    typeof init.body === "object" &&
    typeof (init.body as { getReader?: unknown }).getReader === "function"
  ) {
    throw new Aifp1Error(
      "aifp1Fetch cannot use a stream body: a paywalled request is sent twice " +
        "(once to learn the price, once with the receipt) and a stream can only " +
        "be read once. Pass a string, Buffer, or URLSearchParams."
    );
  }

  const send = (receiptJwt?: string): Promise<Response> => {
    // new Headers() rather than a spread: RequestInit.headers is legally a
    // Headers instance or an array of pairs, and spreading either yields {} —
    // silently dropping every header the caller set, including their auth.
    const headers = new Headers(init.headers);
    // Reporting capability cannot ride to a partner/gateway or a redirect.
    headers.delete("AIFP-Reporting-Token");
    headers.set("AIFP-Agent-Id", deps.agentId);
    if (direct) headers.delete("AIFP-Receipt");
    if (receiptJwt) headers.set("AIFP-Receipt", receiptJwt);
    return deps.fetchImpl(url, {
      ...init,
      headers,
      // The receipt is a bearer token. fetch follows redirects by default and
      // only strips authorization/cookie/host on a cross-origin hop — a custom
      // header rides along, so one 302 from a merchant upstream would hand the
      // batch to another host. All initial probes also stop here: a redirect must
      // not turn an untrusted origin's 402 into an authorized purchase.
      redirect: "manual",
    });
  };

  // 1. Spend a batch we already own, if one covers this path.
  let held = direct ? undefined : deps.cache.find(site, restPath);
  let resp = await send(held?.jwt);
  if (direct && resp.status === 402) {
    // A direct origin can serve several merchants. Learn this resource's
    // merchant before attaching a bearer receipt, even for a cached batch.
    const probe = await resp
      .clone()
      .json()
      .catch(() => null);
    if (isAifp1Challenge(probe)) {
      // The resource may be the merchant's pattern ("/movies/*") rather than
      // the URL, but it must cover the URL: never buy a batch for a path other
      // than the one that refused us.
      if (!patternCovers(probe.resource, restPath)) {
        throw new Aifp1QuoteError("direct AIFP-1 challenge resource must cover the full URL pathname");
      }
      directMerchant = probe.merchant_id;
      site = `direct:${JSON.stringify([site, directMerchant])}`;
      held = deps.cache.find(site, restPath);
      if (held) resp = await send(held.jwt);
    }
  }
  if (held) {
    // Absent header, not "zero left": the gateway sets AIFP-Quota-Remaining
    // only on a metered paid call, and `Number(null)` is 0 — reading it
    // unguarded would retire a full batch the first time a route was free.
    const remaining = quotaRemaining(resp);
    if (remaining !== null) deps.cache.noteQuotaRemaining(held, remaining);
  }

  if (resp.status !== 402) {
    // Not a paywall refusal. That includes a 403, which for a receipt we sent
    // means the gateway disagreed with our coverage or our receipt is not
    // valid for this merchant. Drop it rather than keep re-sending a token the
    // server has already refused, and say so — paying again to work around a
    // coverage disagreement would settle a second batch for the same content.
    if (held && resp.status === 403) {
      // Not every 403 here is about the receipt. routes/gateway.js proxies the
      // merchant's upstream status verbatim, so hotlink protection or an
      // expired API key on their side arrives as a 403 too — and the gateway's
      // own refusals include merchant policy "block", which is checked before
      // the receipt is even read. Evicting a valid batch on any of those throws
      // away a paid receipt and settles a second one on the next call.
      //
      // The gateway labels its own answers: {"error":"AIFP-403", ...}.
      const detail = await resp
        .clone()
        .text()
        .catch(() => "");
      let ours = false;
      try {
        ours = JSON.parse(detail)?.error === "AIFP-403";
      } catch {
        /* upstream body, not ours */
      }
      if (!ours) return resp; // the merchant's 403, receipt intact

      deps.cache.evict(held);
      throw new Aifp1ReceiptRejectedError(
        `gateway refused receipt ${held.receiptId} for ${restPath} (403): ${detail.slice(0, 300)}`
      );
    }
    return resp;
  }

  // 402 — but only AIFP-1 is ours. x402 and anything else passes through
  // untouched; call() owns those flows.
  const challenge = await resp
    .clone()
    .json()
    .catch(() => null);
  if (!isAifp1Challenge(challenge)) return resp;
  if (direct && (challenge.merchant_id !== directMerchant || !patternCovers(challenge.resource, restPath))) {
    throw new Aifp1QuoteError("direct AIFP-1 resource or merchant changed during receipt verification");
  }

  // The batch we were spending is spent (or expired) — the gateway just said
  // so. Forget it before quoting the next one, or find() would keep handing
  // back a receipt that cannot pay for anything.
  if (held) deps.cache.evict(held);

  // Buying a batch, serialised per site.
  //
  // Ten workers sharing one agent used to arrive here together, all miss the
  // cache, and all settle their own batch: ten on-chain payments and ten
  // minimum charges where one covered every one of them. Losers await the
  // winner and then re-check — if the batch it bought covers their path they
  // spend it, and if it does not they buy their own, which is a different
  // batch rather than a duplicate.
  const buyBatch = async (): Promise<Response | null> => {
    if (opts.maxAmountUsd === 0)
      throw new Aifp1QuoteError("No payment budget remains; cached access can still be used");
    let validPayer = /^0x[0-9a-fA-F]{40}$/.test(deps.payerAddress || "");
    if (sol) {
      try {
        validPayer =
          bs58.decode(deps.payerAddress).length === 32 &&
          bs58.encode(bs58.decode(deps.payerAddress)) === deps.payerAddress;
      } catch {
        validPayer = false;
      }
    }
    if (typeof deps.signPaymentAuthorization !== "function" || !validPayer) {
      throw new Aifp1QuoteError("a settlement wallet signer is required to receive a payment receipt");
    }
    // 2. Quote.
    const stableAsset = sol
      ? sol.asset && sol.asset !== "SOL"
        ? (solanaStableMint(sol.network, sol.asset), sol.asset)
        : null
      : pinnedStableAsset(opts.v14?.asset, evmChain);
    const apiBase = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, "");
    const { scope, resource } = resolveScope(opts, challenge);
    const quoteBody: Record<string, unknown> = {
      merchant_id: challenge.merchant_id,
      payer: deps.payerAddress,
      ...(resource !== undefined ? { resource } : {}),
      scope,
      units: opts.units ?? defaultUnitsFor(challenge),
      agent_id: deps.agentId,
      ...(opts.v14 || sol ? { asset: stableAsset ?? nativeAsset } : {}),
      ...(sol || opts.v14?.chain !== undefined ? { settlement_chain: chain } : {}),
    };
    let admission: QuoteAdmission | undefined;
    let admissionBinding: SpendLedgerBinding | undefined;
    let admissionContext: string | undefined;
    if (sol) {
      if (
        !deps.beginQuoteAdmission ||
        !deps.adoptQuoteAdmission ||
        !deps.closeQuoteAdmission ||
        !deps.quoteOwnerContext
      )
        throw new Aifp1QuoteError("Solana requires a durable quote-admission ledger and independent owner context");
      admissionBinding = {
        apiBaseUrl: apiBase,
        paymentIssuer: opts.paymentIssuer ?? DEFAULT_API_BASE,
        payer: deps.payerAddress,
        merchantId: challenge.merchant_id,
        scope,
        resource: resource ?? "*",
        networkMode: sol.network === "devnet" ? "test" : "live",
        chain: `solana:${sol.network}:${solDeployment!.programId}:${solDeployment!.idl.sha256}`,
        asset: stableAsset ?? nativeAsset,
        token: stableAsset ? solanaStableMint(sol.network, stableAsset) : "11111111111111111111111111111111",
        grossAmount: "0",
        quoteId: "quote-admission",
        quoteAdmissionVersion: "1",
        ...(deps.walletIdentity ? { walletIdentity: deps.walletIdentity } : {}),
      };
      admissionContext = JSON.stringify([
        deps.quoteOwnerContext,
        sol.environment,
        sol.network,
        solDeployment!.programId,
        solDeployment!.idl.sha256,
        sol.maxFeeLamports.toString(),
        opts.maxAmountUsd ?? null,
        new URL(url).origin,
        { ...quoteBody, units: opts.units ?? null },
      ]);
      admission = await deps.beginQuoteAdmission(admissionBinding, admissionContext, async () => {
        const authorization = {
          payer: deps.payerAddress,
          network: sol.network,
          network_mode: sol.network === "devnet" ? ("test" as const) : ("live" as const),
          nonce: randomBytes(32).toString("hex"),
          expires_at: Math.floor(Date.now() / 1000) + 240,
        };
        const statement = solanaQuoteAuthorizationMessage(
          quoteBody,
          authorization,
          opts.paymentIssuer ?? DEFAULT_API_BASE
        );
        const signature = await deps.signPaymentAuthorization(statement);
        return {
          requestBody: JSON.stringify({ ...quoteBody, quote_authorization: { ...authorization, signature } }),
          statement,
        };
      });
      // The file contains no authority to change the owner-selected request or key.
      try {
        const body = JSON.parse(admission.requestBody),
          auth = body.quote_authorization;
        const expected = { ...quoteBody, ...(opts.units === undefined ? { units: body.units } : {}) };
        const { quote_authorization: _auth, ...originalBody } = body;
        const statement = solanaQuoteAuthorizationMessage(body, auth, opts.paymentIssuer ?? DEFAULT_API_BASE);
        const publicKey = createPublicKey({
          key: Buffer.concat([
            Buffer.from("302a300506032b6570032100", "hex"),
            Buffer.from(bs58.decode(deps.payerAddress)),
          ]),
          format: "der",
          type: "spki",
        });
        if (
          admission.phase !== "pending" ||
          JSON.stringify(originalBody) !== JSON.stringify(expected) ||
          auth.payer !== deps.payerAddress ||
          auth.network !== sol.network ||
          auth.network_mode !== admissionBinding.networkMode ||
          !/^[0-9a-f]{64}$/.test(auth.nonce) ||
          !Number.isSafeInteger(auth.expires_at) ||
          auth.expires_at <= 0 ||
          !Number.isSafeInteger(body.units) ||
          body.units <= 0 ||
          statement !== admission.statement ||
          bs58.decode(auth.signature).length !== 64 ||
          bs58.encode(bs58.decode(auth.signature)) !== auth.signature ||
          !verifySignature(null, Buffer.from(statement), publicKey, bs58.decode(auth.signature))
        )
          throw new Error("binding");
      } catch {
        throw new Aifp1QuoteError("Stored quote admission does not match the exact owner-authorized request");
      }
    }
    const quote = admission?.quoteJson
      ? (JSON.parse(admission.quoteJson) as Aifp1Quote)
      : await requestQuote(
          deps,
          apiBase,
          admission?.requestBody ?? quoteBody,
          opts.apiTimeoutMs,
          admission
            ? async (status, detail) => {
                const body = JSON.parse(admission!.requestBody),
                  auth = body.quote_authorization;
                if (
                  status === 410 &&
                  detail?.error === "AIFP-410-SOLANA" &&
                  detail.reason === "solana_quote_authorization_expired" &&
                  detail.admission_status === "not_admitted" &&
                  auth.expires_at <= Math.floor(Date.now() / 1000) &&
                  detail.authorization_nonce === auth.nonce &&
                  detail.authorization_statement_hash ===
                    createHash("sha256").update(admission!.statement).digest("hex") &&
                  detail.network === auth.network &&
                  detail.network_mode === auth.network_mode &&
                  detail.payer === deps.payerAddress
                )
                  await deps.closeQuoteAdmission!(admission!.id, admissionBinding!, admissionContext!, "not-admitted");
              }
            : undefined,
          opts.reportingToken
        );
    if (admission && !admission.quoteJson) {
      const quoteJson = JSON.stringify(quote);
      await deps.adoptQuoteAdmission!(admission.id, admissionBinding!, admissionContext!, quoteJson);
      admission.quoteJson = quoteJson;
    }
    if (
      quote.payer &&
      (sol ? quote.payer !== deps.payerAddress : quote.payer.toLowerCase() !== deps.payerAddress.toLowerCase())
    ) {
      throw new Aifp1QuoteError("quote names a different paying wallet");
    }
    if (quote.payment_authorization && quote.payment_authorization.scheme !== "wallet-signature-v1") {
      throw new Aifp1QuoteError("unsupported receipt authorization scheme");
    }
    trustedPaymentIssuer(quote, opts.paymentIssuer);
    const merchantWallet = sol ? quote.pay_to.solana : (quote.pay_to[chain] ?? quote.pay_to.evm);
    if (
      (opts.v14 || sol) &&
      (quote.accepted_chains.length !== 1 ||
        quote.accepted_chains[0] !== chain ||
        quote.settlement_call?.chain !== chain ||
        !merchantWallet ||
        (!sol &&
          quote.pay_to[chain] !== undefined &&
          quote.pay_to.evm !== undefined &&
          quote.pay_to[chain].toLowerCase() !== quote.pay_to.evm.toLowerCase()))
    ) {
      throw new Aifp1QuoteError("quote does not match the independently selected payment chain");
    }

    // The merchant we are about to pay must be the merchant that refused us.
    // Cheap, and the failure it catches is the one worth catching.
    if (quote.merchant_id !== challenge.merchant_id) {
      throw new Aifp1QuoteError(
        `quote ${quote.quote_id} is for merchant ${quote.merchant_id} but ${site} refused as ${challenge.merchant_id} — refusing to pay`
      );
    }

    if (
      (opts.v14 || sol) &&
      (quote.scope !== scope ||
        quote.resource !== (resource ?? "*") ||
        quote.currency !== "USD" ||
        (quote.network_mode ?? "live") !== (sol?.network === "devnet" ? "test" : "live") ||
        !Number.isSafeInteger(quote.unit_quota) ||
        quote.unit_quota <= 0)
    ) {
      throw new Aifp1QuoteError("v1.4 quote does not match the requested scope, resource or live currency");
    }
    validateCanonicalQuoteEconomics(quote);
    const quoteExpiryMs = Date.parse(quote.expires_at);
    if (!Number.isFinite(quoteExpiryMs)) throw new Aifp1QuoteError("Quote has invalid expiry; retain its admission");
    if (quoteExpiryMs <= Date.now()) {
      if (sol && admission && !admission.wasReserved) {
        validateSolanaQuote(quote, sol, deps.payerAddress, quoteExpiryMs, solDeployment!, true);
        if (!deps.verifyHistoricalSolanaQuote)
          throw new Aifp1QuoteError("Historical quote signer verification is required");
        await deps.verifyHistoricalSolanaQuote(quote.settlement_call as SolanaV14SettlementCall, sol, quote.quote_id);
        await deps.closeQuoteAdmission!(
          admission.id,
          admissionBinding!,
          admissionContext!,
          "expired-unbroadcast",
          admission.quoteJson
        );
      }
      throw new Aifp1QuoteError(`quote ${quote.quote_id} is expired; no transaction or new quote was submitted`);
    }

    // 3. Budget. The quote states the batch total in USD, so both caps are
    // checked against the real figure, before anything is signed.
    let amountUsd = Number(quote.amount);
    if (!Number.isFinite(amountUsd) || amountUsd < 0) {
      throw new Aifp1QuoteError(`quote ${quote.quote_id} has an unusable amount "${quote.amount}"`);
    }
    let solPlan: SolanaV14Plan | undefined;
    let solRate: string | undefined;
    if (sol) {
      validateSolanaQuote(quote, sol, deps.payerAddress, quoteExpiryMs, solDeployment!);
      const price = typeof opts.nativeUsdPrice === "function" ? await opts.nativeUsdPrice() : opts.nativeUsdPrice;
      const age = price ? Date.now() - price.observedAtMs : NaN;
      if (
        !price ||
        !Number.isFinite(price.usd) ||
        price.usd <= 0 ||
        !Number.isFinite(age) ||
        age < -5000 ||
        age > 60000
      )
        throw new Aifp1QuoteError("Fresh independent SOL/USD price required for gross and fee/rent budgeting");
      solRate = String(price.usd);
      solanaLamportCostUsd(0n, solRate); // Exact finite independently sourced rate.
      const gross = BigInt((quote.settlement_call as SolanaV14SettlementCall).args.quote.grossAmount);
      if (!stableAsset) {
        const debitUsd = solanaLamportCostUsd(gross, solRate);
        const quotedRate = Number(quote.native_settlement?.rate_usd);
        if (
          !Number.isFinite(debitUsd) ||
          debitUsd <= 0 ||
          !Number.isFinite(quotedRate) ||
          quotedRate <= 0 ||
          Math.abs(debitUsd - amountUsd) > Math.max(amountUsd * 0.02, 1e-6) ||
          Math.abs(solanaLamportCostUsd(gross, String(quotedRate)) - amountUsd) > Math.max(amountUsd * 0.02, 1e-6)
        )
          throw new Aifp1QuoteError("SOL gross disagrees with independent/quoted USD rate");
        amountUsd = Math.max(amountUsd, Math.ceil(debitUsd * 1e6) / 1e6);
      }
      if (!deps.prepareSolana || !deps.settleSolana)
        throw new Aifp1SettlementUnsupportedError("Solana executor unavailable");
      solPlan = await deps.prepareSolana(quote.settlement_call as SolanaV14SettlementCall, sol, quote.quote_id);
      if (solPlan.feeRentLamports < 0n || solPlan.feeRentLamports > sol.maxFeeLamports)
        throw new Aifp1QuoteError("Solana fee/rent cap exceeded");
      amountUsd += solanaLamportCostUsd(solPlan.feeRentLamports, solRate);
    } else if (stableAsset) {
      validateStableV14Quote(quote, stableAsset, deps.payerAddress as `0x${string}`, quoteExpiryMs, evmChain);
    } else if (opts.settlementPin || opts.v14) {
      const price = typeof opts.nativeUsdPrice === "function" ? await opts.nativeUsdPrice() : opts.nativeUsdPrice;
      const age = price ? Date.now() - price.observedAtMs : NaN;
      if (
        !price ||
        !Number.isFinite(price.usd) ||
        price.usd <= 0 ||
        !Number.isFinite(age) ||
        age < -5_000 ||
        age > 60_000
      ) {
        throw new Aifp1QuoteError(
          "a fresh independent nativeUsdPrice is required before native payment; quote-provided FX is not trusted"
        );
      }
      const native = quote.native_settlement as Aifp1EvmNativeSettlement | undefined;
      if (!native || !/^[0-9]{1,78}$/.test(native.total_wei)) {
        throw new Aifp1QuoteError("quote has no valid native debit to check against the independent price");
      }
      const debitUsd = (Number(BigInt(native.total_wei)) / 1e18) * price.usd;
      if (
        !Number.isFinite(debitUsd) ||
        debitUsd <= 0 ||
        Math.abs(debitUsd - amountUsd) > Math.max(0.02 * amountUsd, 1e-6)
      ) {
        throw new Aifp1QuoteError("native debit disagrees with the independent USD price");
      }
      // Reserve and charge the larger amount, so rounding/FX tolerance cannot
      // turn into a cumulative bypass of the user's daily USD budget.
      amountUsd = Math.max(amountUsd, debitUsd);
      const call = quote.settlement_call;
      const args = call?.args as
        | Exclude<Aifp1Quote["settlement_call"], V14SettlementCall | SolanaV14SettlementCall | undefined>["args"]
        | undefined;
      if (
        quote.token_settlement !== undefined ||
        native.asset !== nativeAsset ||
        native.decimals !== 18 ||
        (opts.v14
          ? quote.accepted_assets.length !== 1 || quote.accepted_assets[0] !== nativeAsset
          : !quote.accepted_assets.includes(nativeAsset))
      ) {
        throw new Aifp1QuoteError(`native receipt settlement requires accepted ${nativeAsset} with 18 decimals`);
      }
      if (opts.v14) {
        if (!call || call.splitter_version !== "1.4") {
          throw new Aifp1SettlementUnsupportedError("v1.4 authorization requires a v1.4 quote; no legacy fallback");
        }
        const signed = call as V14SettlementCall;
        validateV14SettlementCall(signed, { orderId: quote.quote_id, payer: deps.payerAddress as `0x${string}` });
        if (
          signed.chain !== chain ||
          signed.asset !== nativeAsset ||
          signed.route !== "merchant-aifp1" ||
          signed.args.quote.merchant.toLowerCase() !== merchantWallet?.toLowerCase() ||
          signed.args.quote.grossAmount !== native.total_wei ||
          BigInt(signed.args.quote.validUntil) !== BigInt(Math.floor(quoteExpiryMs / 1000))
        ) {
          throw new Aifp1QuoteError("signed v1.4 call disagrees with the requested merchant, debit or expiry");
        }
      } else if (
        !call ||
        call.chain !== "polygon" ||
        call.splitter_version !== "1.3" ||
        call.contract?.toLowerCase() !== opts.settlementPin!.splitter.toLowerCase() ||
        call.asset !== "POL" ||
        call.function !== "payNative((bytes32,address,uint256,address,uint256,string))" ||
        call.arg_encoding !== "tuple" ||
        call.value_wei !== native.total_wei ||
        args?.payment_id?.toLowerCase() !== keccak256(stringToHex(quote.quote_id)).toLowerCase() ||
        args?.merchant?.toLowerCase() !== quote.pay_to.polygon?.toLowerCase() ||
        args?.gross_amount !== native.total_wei ||
        args?.order_id !== quote.quote_id ||
        args?.valid_until !== Math.floor(quoteExpiryMs / 1000) ||
        args?.ip_creator?.toLowerCase() !== "0x0000000000000000000000000000000000000000"
      ) {
        throw new Aifp1QuoteError(
          "quote settlement_call does not match the reviewed v1.3 payment; refusing a payment the receipt verifier cannot accept"
        );
      }
    }
    if (opts.maxAmountUsd !== undefined && amountUsd > opts.maxAmountUsd) {
      throw new Aifp1QuoteError(
        `quote ${quote.quote_id} costs $${amountUsd}, above maxAmountUsd $${opts.maxAmountUsd}`
      );
    }
    if (!deps.checkPerCall(amountUsd)) return null;
    const budgetContext = {
      apiBaseUrl: apiBase,
      quote,
      asset: stableAsset ?? nativeAsset,
      chain,
      paymentIssuer: opts.paymentIssuer,
      ...(sol
        ? {
            admissionSolUsdPrice: solRate!,
            maxFeeLamports: sol.maxFeeLamports.toString(),
            transactionFeeLamports: solPlan!.transactionFeeLamports.toString(),
          }
        : {}),
    };
    const binding =
      opts.v14 || sol ? paymentBudgetBinding(budgetContext, deps.payerAddress, deps.walletIdentity) : undefined;
    const reservation = await deps.reserveDaily(amountUsd, binding, admission?.id);
    if (reservation === "skip") return null;

    let settled = false;
    let preparedTx: { hash: `0x${string}`; serializedTransaction: `0x${string}` } | undefined;
    const recoveryFor = (txRef: `0x${string}`): Aifp1EvmPaymentRecovery => ({
      ...budgetContext,
      chain: evmChain,
      txRef,
      ...(deps.walletIdentity ? { budgetBindingVersion: 2 as const } : {}),
      ...(binding && typeof reservation === "string" ? { budgetReservationId: reservation } : {}),
      ...(preparedTx?.hash === txRef ? { serializedTransaction: preparedTx.serializedTransaction } : {}),
    });
    try {
      if (sol) {
        return await settleSolanaBatch(
          deps,
          opts,
          quote,
          solPlan!,
          amountUsd,
          binding!,
          reservation,
          site,
          send,
          () => {
            settled = true;
          }
        );
      }
      if (
        binding &&
        typeof reservation === "string" &&
        (!deps.prepareReservation || !deps.assertReservation || !deps.completeReservation)
      ) {
        throw new Aifp1QuoteError("Capped v1.4 payments require durable bound-journal ledger hooks before broadcast");
      }
      // 4. Settle on-chain, then exchange the tx for a receipt.
      let settleParams: {
        merchantWallet: `0x${string}`;
        grossWei: bigint;
        merchantWei: bigint;
        treasuryWei: bigint;
        creatorWei: bigint;
        validUntil: bigint;
        token?: `0x${string}`;
      };
      let paidAsset: string;
      if (stableAsset) {
        // Every figure here was checked against the signed quote, the pinned
        // token and the USD amount in validateStableV14Quote before budgeting.
        const signed = (quote.settlement_call as V14SettlementCall).args.quote;
        const gross = BigInt(signed.grossAmount);
        const treasury = gross / 100n;
        settleParams = {
          merchantWallet: merchantWallet as `0x${string}`,
          grossWei: gross,
          merchantWei: gross - treasury,
          treasuryWei: treasury,
          creatorWei: 0n,
          validUntil: BigInt(signed.validUntil),
          token: signed.token as `0x${string}`,
        };
        paidAsset = stableAsset;
      } else {
        const native = quote.native_settlement as Aifp1EvmNativeSettlement | undefined;
        if (!native) {
          throw new Aifp1SettlementUnsupportedError(
            `quote ${quote.quote_id} carries no native_settlement for ${nativeAsset}; ` +
              `retry when a live ${nativeAsset} rate is available or request a pinned stablecoin explicitly.`
          );
        }
        if (!quote.accepted_chains.includes(chain) || !merchantWallet) {
          throw new Aifp1SettlementUnsupportedError(`quote ${quote.quote_id} does not accept ${chain}`);
        }

        // The caps above were checked in USD; the wallet is about to be debited in
        // wei. Nothing tied the two together, so a quote could pass a $0.10 cap and
        // spend any amount of POL — the client had no reason to notice, because it
        // never converted one into the other.
        //
        // The quote states the rate it used and fixes it for its lifetime
        // (routes/aifp.js: rate_fixed_at, "a quote that repriced itself would let a
        // payment that was correct when sent become underpaid"). So the three
        // numbers must agree, and if they do not, the safe reading is not "trust
        // the USD" — it is that this quote is not what it says it is.
        const quotedRate = Number(native.rate_usd);
        const weiUsd =
          Number.isFinite(quotedRate) && quotedRate > 0 ? (Number(BigInt(native.total_wei)) / 1e18) * quotedRate : NaN;
        if (!Number.isFinite(weiUsd)) {
          throw new Aifp1QuoteError(
            `quote ${quote.quote_id} states total_wei ${native.total_wei} at rate "${native.rate_usd}" — ` +
              `unusable, and the caps were checked against $${amountUsd}`
          );
        }
        // 2% covers native conversion rounding and a
        // rate printed to six places; anything wider is a disagreement, not drift.
        if (Math.abs(weiUsd - amountUsd) > Math.max(0.02 * amountUsd, 1e-6)) {
          throw new Aifp1QuoteError(
            `quote ${quote.quote_id} would debit ${native.total_wei} wei ≈ $${weiUsd.toFixed(6)} ` +
              `but states $${amountUsd} — refusing to sign a payment the budget caps did not see`
          );
        }

        const nativeGross = BigInt(native.gross_wei ?? native.total_wei);
        const nativeMerchant = BigInt(native.merchant_wei);
        const nativeTreasury = BigInt(native.treasury_wei);
        const nativeCreator = BigInt(native.creator_wei);
        if (
          native.settlement_semantics !== "gross-inclusive" ||
          BigInt(native.payer_total_wei ?? native.total_wei) !== nativeGross ||
          BigInt(native.total_wei) !== nativeGross ||
          nativeCreator !== 0n ||
          nativeTreasury !== nativeGross / 100n ||
          nativeMerchant !== nativeGross - nativeTreasury
        ) {
          throw new Aifp1QuoteError(
            `quote ${quote.quote_id} native settlement does not match canonical AIFP-1 gross split`
          );
        }
        const validUntil = BigInt(native.valid_until ?? Math.floor(quoteExpiryMs / 1000));
        if (validUntil !== BigInt(Math.floor(quoteExpiryMs / 1000))) {
          throw new Aifp1QuoteError(`quote ${quote.quote_id} valid_until does not match expires_at`);
        }
        settleParams = {
          merchantWallet: merchantWallet as `0x${string}`,
          grossWei: nativeGross,
          merchantWei: nativeMerchant,
          treasuryWei: nativeTreasury,
          creatorWei: nativeCreator,
          validUntil,
        };
        paidAsset = native.asset;
      }

      let txRef: `0x${string}`;
      try {
        txRef = await deps.settle({
          ...settleParams,
          // The binding the server verifies on-chain: the Payment event's orderId
          // must equal the quote id, or /v1/pay answers order_id_mismatch.
          orderId: quote.quote_id,
          settlementCall: quote.settlement_call,
          ...(opts.v14
            ? {
                onPrepared: async (tx: { hash: `0x${string}`; serializedTransaction: `0x${string}` }) => {
                  if (
                    !/^0x(?:[0-9a-fA-F]{2})+$/.test(tx.serializedTransaction) ||
                    keccak256(tx.serializedTransaction) !== tx.hash
                  ) {
                    throw new Aifp1QuoteError("Prepared transaction hash disagrees with its signed bytes");
                  }
                  if (binding && typeof reservation === "string")
                    await deps.prepareReservation!(reservation, tx.hash, binding);
                  await opts.v14!.onPrepared({
                    ...recoveryFor(tx.hash),
                    serializedTransaction: tx.serializedTransaction,
                  });
                  preparedTx = tx;
                },
              }
            : {}),
        });
      } catch (error) {
        const pending = error instanceof SettlementConfirmationPendingError && error.stage === "settlement";
        const provenRevert = error instanceof V14SettlementError && error.code === "V14_TRANSACTION_REVERTED";
        if (pending || (preparedTx && !provenRevert)) {
          // Treat unknown confirmation as spent until reconciliation. Releasing
          // the reservation here would let a retry spend the same budget again.
          settled = true;
          const hash = pending ? error.txHash : preparedTx!.hash;
          throw new Aifp1PayError(
            "payment broadcast; recover its confirmation and receipt without paying again",
            hash,
            quote.quote_id,
            recoveryFor(hash)
          );
        }
        throw error;
      }

      // Money has moved. The reservation becomes settled spend here and not one
      // line later — everything below can still fail, and none of those failures
      // give the funds back.
      settled = true;
      try {
        if (typeof reservation === "string") await deps.commit(reservation, amountUsd);
      } catch {
        throw new Aifp1PayError(
          "payment settled; budget reconciliation and receipt recovery required",
          txRef,
          quote.quote_id,
          recoveryFor(txRef)
        );
      }

      let paid: Aifp1PayResult;
      try {
        paid = await submitPayment(deps, apiBase, quote, txRef, paidAsset, chain, opts);
        if (binding && typeof reservation === "string") await deps.completeReservation!(reservation, txRef, binding);
      } catch (error) {
        throw new Aifp1PayError(
          error instanceof Error ? error.message : "Payment receipt/budget recovery required",
          txRef,
          quote.quote_id,
          recoveryFor(txRef)
        );
      }

      // 6. Keep the batch. This is the whole point of the design: the next call
      // this receipt covers costs a header, not a transaction.
      const entry: Aifp1CachedReceipt = {
        site,
        merchantId: paid.merchant_id,
        receiptId: paid.receipt_id,
        jwt: paid.receipt,
        scope: paid.scope,
        resource: paid.resource,
        unitQuota: paid.unit_quota,
        remaining: paid.unit_quota,
        expiresAt: Date.parse(paid.expires_at),
        amountUsd,
      };
      // Cache unconditionally. This used to be guarded on a finite expiresAt,
      // which meant an unparseable expires_at silently binned a batch that had
      // just been settled on-chain — money spent, JWT existing nowhere else,
      // and the next call settling another one. A bad timestamp is a reason to
      // distrust the expiry, not the receipt: fall back to the JWT's own exp,
      // and to "expired" only if that is missing too, so find() re-quotes
      // instead of the entry lingering forever.
      if (!Number.isFinite(entry.expiresAt)) {
        // Prefer the token's own exp; if that is unreadable too, keep the batch
        // rather than dating it into the past. The asymmetry decides it: assume
        // expired and we settle a second batch for certain, assume valid and the
        // worst case is one wasted request, because the gateway is the authority
        // and answers 402 the moment the receipt really is spent or stale.
        entry.expiresAt = jwtExpiryMs(paid.receipt) ?? Number.POSITIVE_INFINITY;
      }
      // Store the purchased access BEFORE contacting the merchant again. A
      // transport failure here must not discard a paid batch and buy it twice.
      deps.cache.put(entry);
      let receiptResp: Response;
      try {
        receiptResp = await send(paid.receipt);
      } catch {
        throw new Aifp1PayError(
          "payment settled and receipt cached; content request failed, retry without paying again",
          txRef,
          quote.quote_id,
          recoveryFor(txRef)
        );
      }
      if (receiptResp.status === 402) {
        throw new Aifp1ReceiptRejectedError(
          `gateway still answered 402 for ${restPath} with settled receipt ${paid.receipt_id} (tx ${txRef}); recover the existing payment`
        );
      }
      // The gateway's own count if it gave one; otherwise the batch minus the
      // weight of the route that refused us, which is the only figure we can
      // justify locally.
      const remaining = quotaRemaining(receiptResp);
      entry.remaining = remaining !== null ? remaining : Math.max(0, paid.unit_quota - challenge.unit_weight);

      deps.onPaid?.({
        merchantId: paid.merchant_id,
        amountUsd,
        txRef,
        receiptId: paid.receipt_id,
      });
      return receiptResp;
    } finally {
      // Only a proven prebroadcast failure/reverted settlement gives the cap back.
      if (typeof reservation === "string" && !settled) await deps.release(reservation);
    }
  };

  const outcome = await deps.cache.coalesce(site, buyBatch);
  if (outcome !== "retry") return outcome;

  const fresh = deps.cache.find(site, restPath);
  if (fresh) return send(fresh.jwt);
  return buyBatch();
}

// ── /v1/quote ─────────────────────────────────────────────────────────────

/** Trusted input only: neither a quote nor a receipt may choose a payment chain. */
function authorizedV14Chain(chain: Aifp1V14Chain | undefined): Aifp1V14Chain {
  if (chain === undefined) return "polygon";
  if (!paymentChain(chain)) throw new Aifp1QuoteError(`unsupported v1.4 chain "${chain}"`);
  return chain;
}

/** Native by default; stablecoin symbols must be pinned for the selected chain. */
function pinnedStableAsset(asset: string | undefined, chain: Aifp1V14Chain): string | null {
  if (asset === undefined || asset === paymentChain(chain)!.native) return null;
  const pinned = paymentStableAsset(chain, asset);
  if (!pinned) {
    throw new Aifp1QuoteError(`v14.asset "${asset}" is not a stablecoin pinned for ${chain} v1.4`);
  }
  return pinned.symbol;
}

/**
 * Check a v1.4 stablecoin quote before any budget is reserved. A token quote
 * has no FX to cross-check, so the binding is exact instead: the signed gross
 * equals the pinned-decimal conversion of the stated USD micro-dollars;
 * optional token metadata is checked in exact token units; the approval is for
 * exactly that gross; and the quote accepts nothing else.
 */
function validateStableV14Quote(
  quote: Aifp1Quote,
  asset: string,
  payer: `0x${string}`,
  quoteExpiryMs: number,
  chain: Aifp1V14Chain
): void {
  const call = quote.settlement_call;
  if (!call || call.splitter_version !== "1.4") {
    throw new Aifp1SettlementUnsupportedError("a stablecoin purchase requires a signed v1.4 quote; no legacy fallback");
  }
  const signed = call as V14SettlementCall;
  validateV14SettlementCall(signed, { orderId: quote.quote_id, payer });
  const pin = paymentStableAsset(chain, asset);
  const token = pin?.address;
  const merchant = quote.pay_to[chain] ?? quote.pay_to.evm;
  const q = signed.args.quote;
  let micro: bigint;
  try {
    if (!/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(String(quote.amount))) throw new Error("non-exact USD amount");
    micro = parseUnits(String(quote.amount), 6);
  } catch {
    throw new Aifp1QuoteError(`quote ${quote.quote_id} has an unusable amount "${quote.amount}"`);
  }
  const units = quote.settlement?.total_units;
  const gross = pin ? micro * 10n ** BigInt(pin.decimals - 6) : 0n;
  const metadata = quote.token_settlement;
  // Split the actual token gross, not the rounded legacy micro-dollar legs.
  const treasury = gross / 100n;
  if (
    (pin?.decimals === 18 && metadata === undefined) ||
    (metadata !== undefined &&
      (!metadata ||
        typeof metadata !== "object" ||
        metadata.asset !== asset ||
        metadata.token?.toLowerCase() !== token?.toLowerCase() ||
        metadata.decimals !== pin?.decimals ||
        metadata.settlement_semantics !== "gross-inclusive" ||
        metadata.total_units !== String(gross) ||
        metadata.merchant_units !== String(gross - treasury) ||
        metadata.protocol_fee_units !== String(treasury) ||
        metadata.creator_units !== "0"))
  )
    throw new Aifp1QuoteError("token_settlement disagrees with pinned token, decimals or exact gross-inclusive split");
  if (
    signed.chain !== chain ||
    signed.asset !== asset ||
    signed.route !== "merchant-aifp1" ||
    !token ||
    q.token.toLowerCase() !== token.toLowerCase() ||
    quote.accepted_chains.length !== 1 ||
    quote.accepted_chains[0] !== chain ||
    !merchant ||
    q.merchant.toLowerCase() !== merchant.toLowerCase() ||
    quote.native_settlement !== undefined ||
    quote.accepted_assets.length !== 1 ||
    quote.accepted_assets[0] !== asset ||
    units === undefined ||
    units !== String(micro) ||
    q.grossAmount !== String(gross) ||
    gross >= 2n ** 256n ||
    micro <= 0n ||
    !signed.approval ||
    signed.approval.token.toLowerCase() !== token.toLowerCase() ||
    signed.approval.spender.toLowerCase() !== signed.contract.toLowerCase() ||
    String(signed.approval.amount) !== q.grossAmount ||
    BigInt(q.validUntil) !== BigInt(Math.floor(quoteExpiryMs / 1000))
  ) {
    throw new Aifp1QuoteError(
      "signed v1.4 stablecoin call disagrees with the requested asset, merchant, amount, approval or expiry"
    );
  }
}

async function requestQuote(
  deps: Aifp1Deps,
  apiBase: string,
  body: Record<string, unknown> | string,
  timeoutMs?: number,
  onRefusal?: (status: number, detail: Record<string, unknown> | null) => Promise<void>,
  reportingToken?: string
): Promise<Aifp1Quote> {
  let r: Response;
  let text: string;
  try {
    ({ response: r, text } = await settlementHttp(
      deps.fetchImpl,
      `${apiBase}/v1/quote`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "AIFP-Agent-Id": deps.agentId,
          ...reportingHeaders(reportingToken, `${apiBase}/v1/quote`),
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
      timeoutMs
    ));
  } catch (e) {
    throw new Aifp1QuoteError(`POST ${apiBase}/v1/quote failed: ${(e as Error).message}`);
  }
  if (!r.ok) {
    let detail = null;
    try {
      detail = JSON.parse(text);
    } catch {
      /* Unknown response keeps the admission. */
    }
    await onRefusal?.(r.status, detail);
    // The server's own detail is the useful part — a scope refused for a
    // non-flat-rated tier, a batch under the minimum, an owner policy — and
    // none of that is guessable from the status alone.
    throw new Aifp1QuoteError(`POST /v1/quote → ${r.status}: ${text.slice(0, 400)}`);
  }
  let quote: Aifp1Quote;
  try {
    quote = JSON.parse(text) as Aifp1Quote;
  } catch {
    throw new Aifp1QuoteError(`POST /v1/quote → 200 but not JSON: ${text.slice(0, 200)}`);
  }
  if (!quote.quote_id) {
    throw new Aifp1QuoteError(`POST /v1/quote → 200 without a quote_id: ${text.slice(0, 200)}`);
  }
  return quote;
}

/** Sign only this locally constructed request; a server cannot choose the
 * ownership statement. Retry the same body/nonce after an uncertain response. */
export function solanaQuoteAuthorizationMessage(
  body: Record<string, unknown>,
  auth: {
    network: SolanaNetwork;
    network_mode: "live" | "test";
    payer: string;
    nonce: string;
    expires_at: number;
  },
  issuer: string
): string {
  return JSON.stringify([
    "AiFinPay quote authorization v1",
    issuer,
    auth.network,
    auth.network_mode,
    body.merchant_id,
    body.resource ?? null,
    body.tier ?? "standard",
    body.requests ?? null,
    body.units ?? null,
    body.currency ?? "USD",
    body.scope ?? "exact",
    "solana",
    body.asset ?? "SOL",
    auth.payer,
    auth.nonce,
    auth.expires_at,
  ]);
}

// ── /v1/pay ───────────────────────────────────────────────────────────────

/**
 * Exchange a settled transaction for a receipt.
 *
 * The retry loop exists for exactly one server answer: AIFP-425, "settlement
 * not yet confirmed — retry with the same Idempotency-Key shortly". Our money
 * is already on-chain at that point, so giving up would mean a paid batch with
 * no receipt to spend it. Every retry reuses the same key, so a retry that
 * crosses with the server's first success replays that success rather than
 * minting a second receipt.
 */
async function submitPayment(
  deps: Pick<Aifp1Deps, "fetchImpl" | "agentId" | "payerAddress" | "signPaymentAuthorization">,
  apiBase: string,
  quote: Aifp1Quote,
  txRef: string,
  asset: string,
  chain: Aifp1SettlementChain,
  opts: Aifp1FetchOptions
): Promise<Aifp1PayResult> {
  const idempotencyKey = idempotencyKeyFor({ quoteId: quote.quote_id, chain, asset, txRef });
  const deadline = Date.now() + (opts.settlementConfirmMs ?? DEFAULT_SETTLEMENT_CONFIRM_MS);

  const recovery = {
    apiBaseUrl: apiBase,
    quote,
    txRef,
    asset,
    chain,
    paymentIssuer: opts.paymentIssuer,
  };
  const failure = (message: string) =>
    new Aifp1PayError(message, txRef, quote.quote_id, recovery as Aifp1PaymentRecovery);
  let lastDetail = "";
  for (let attempt = 0; ; attempt++) {
    if (attempt > 0 && Date.now() >= deadline)
      throw failure("payment confirmation deadline elapsed; recover the existing transaction");
    const expiresAt = Math.floor(Date.now() / 1000) + 240;
    const payer = chain === "solana" ? deps.payerAddress : deps.payerAddress.toLowerCase();
    // Construct this locally; never sign an arbitrary server-provided message.
    const message = paymentAuthorizationMessage({
      quote,
      apiBase,
      chain,
      txRef,
      asset,
      idempotencyKey,
      payer,
      expiresAt,
      issuer: opts.paymentIssuer,
    });
    let signature: string;
    try {
      signature = await deps.signPaymentAuthorization(message);
    } catch (e) {
      throw failure(`payment already settled; wallet could not sign receipt authorization: ${(e as Error).message}`);
    }
    let r: Response;
    let text: string;
    try {
      ({ response: r, text } = await settlementHttp(
        deps.fetchImpl,
        `${apiBase}/v1/pay`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "Idempotency-Key": idempotencyKey,
            "AIFP-Agent-Id": deps.agentId,
          },
          body: JSON.stringify({
            quote_id: quote.quote_id,
            chain,
            asset,
            tx_ref: txRef,
            agent_id: deps.agentId,
            payment_authorization: { payer, expires_at: expiresAt, signature },
          }),
        },
        Math.max(1, Math.min(opts.apiTimeoutMs ?? 15_000, deadline - Date.now()))
      ));
    } catch (e) {
      if (Date.now() >= deadline || (e instanceof SettlementHttpError && e.code !== "request_timeout")) {
        throw failure(`POST ${apiBase}/v1/pay failed after settling: ${(e as Error).message}`);
      }
      await sleep(Math.min(1000 * 2 ** attempt, 8000, Math.max(0, deadline - Date.now())));
      continue;
    }
    if (r.ok) {
      let paid: Aifp1PayResult;
      try {
        paid = JSON.parse(text) as Aifp1PayResult;
      } catch {
        throw failure(`/v1/pay returned invalid JSON after settlement`);
      }
      if (!paid.receipt) {
        throw failure(`/v1/pay → 200 without a receipt: ${text.slice(0, 300)}`);
      }
      if (quote.settlement_call?.splitter_version === "1.4") {
        try {
          await verifyPaidReceipt(
            paid,
            quote,
            asset,
            chain,
            txRef,
            deps.payerAddress,
            opts.paymentIssuer ?? DEFAULT_API_BASE,
            deps.fetchImpl,
            opts.apiTimeoutMs
          );
        } catch {
          throw failure("receipt signature or purchase binding could not be verified; recover the existing payment");
        }
      }
      return paid;
    }
    lastDetail = text.slice(0, 400);
    // A 503 after settlement may mean accounting is unavailable, or that a
    // committed response was lost. Retry issuance, never the transfer.
    if (![425, 503].includes(r.status) || Date.now() >= deadline) {
      throw failure(
        `POST /v1/pay → ${r.status} after on-chain settlement ${txRef} for quote ${quote.quote_id}: ${lastDetail}`
      );
    }
    await sleep(Math.min(1000 * 2 ** attempt, 8000, Math.max(0, deadline - Date.now())));
  }
}

/** Only the configured issuer supplies keys; JWT headers cannot select a URL.
 * v1.4 native purchases accept Ed25519 receipts bound to the exact purchase. */
async function verifyPaidReceipt(
  paid: Aifp1PayResult,
  quote: Aifp1Quote,
  asset: string,
  chain: Aifp1SettlementChain,
  txRef: string,
  payer: string,
  issuer: string,
  fetchImpl: typeof fetch,
  timeoutMs?: number
): Promise<void> {
  const reject = () => {
    throw new Aifp1Error("invalid payment receipt");
  };
  if (typeof paid.receipt !== "string" || paid.receipt.length > 32768) reject();
  const parts = paid.receipt.split(".");
  if (parts.length !== 3 || parts.some((p) => !/^[A-Za-z0-9_-]+$/.test(p))) reject();
  const [headerPart, payloadPart, signaturePart] = parts as [string, string, string];
  const header = JSON.parse(Buffer.from(headerPart, "base64url").toString("utf8"));
  if (header.alg !== "EdDSA" || header.typ !== "JWT" || typeof header.kid !== "string" || header.crit !== undefined)
    reject();
  const { response, text } = await settlementHttp(
    fetchImpl,
    `${issuer.replace(/\/$/, "")}/.well-known/jwks.json`,
    {},
    timeoutMs
  );
  if (!response.ok) reject();
  const jwks = JSON.parse(text);
  if (!Array.isArray(jwks.keys)) reject();
  const keys = jwks.keys.filter(
    (key: Record<string, unknown>) =>
      key.kid === header.kid &&
      key.kty === "OKP" &&
      key.crv === "Ed25519" &&
      key.d === undefined &&
      (key.alg === undefined || key.alg === "EdDSA") &&
      (key.use === undefined || key.use === "sig")
  );
  if (
    keys.length !== 1 ||
    (keys[0].key_ops !== undefined && (!Array.isArray(keys[0].key_ops) || !keys[0].key_ops.includes("verify")))
  )
    reject();
  const signature = Buffer.from(signaturePart, "base64url");
  if (
    signature.length !== 64 ||
    !verifySignature(
      null,
      Buffer.from(`${headerPart}.${payloadPart}`),
      createPublicKey({ key: keys[0], format: "jwk" }),
      signature
    )
  )
    reject();
  const claims = JSON.parse(Buffer.from(payloadPart, "base64url").toString("utf8"));
  const now = Math.floor(Date.now() / 1000);
  if (
    claims.iss !== issuer ||
    claims.aud !== quote.merchant_id ||
    typeof claims.sub !== "string" ||
    (chain === "solana" ? claims.sub !== payer : claims.sub.toLowerCase() !== payer.toLowerCase()) ||
    claims.tx_ref !== txRef ||
    claims.scope !== quote.scope ||
    claims.resource !== quote.resource ||
    claims.chain !== chain ||
    (chain === "solana" &&
      (claims.network !== (quote.settlement_call as SolanaV14SettlementCall).network ||
        claims.program !== quote.settlement_call!.contract ||
        paid.network !== claims.network ||
        paid.program !== claims.program)) ||
    typeof claims.asset !== "string" ||
    claims.asset.toUpperCase() !== asset.toUpperCase() ||
    claims.currency !== "USD" ||
    (claims.network_mode ?? "live") !== (quote.network_mode ?? "live") ||
    Number(claims.amount) !== Number(quote.amount) ||
    claims.unit_quota !== quote.unit_quota ||
    !Number.isSafeInteger(claims.exp) ||
    claims.exp <= now ||
    (claims.nbf !== undefined && (!Number.isSafeInteger(claims.nbf) || claims.nbf > now)) ||
    !Number.isSafeInteger(claims.iat) ||
    claims.iat > now + 30 ||
    typeof claims.receipt_id !== "string" ||
    !claims.receipt_id ||
    paid.receipt_id !== claims.receipt_id ||
    paid.merchant_id !== claims.aud ||
    paid.tx_ref !== claims.tx_ref ||
    paid.scope !== claims.scope ||
    paid.resource !== claims.resource ||
    paid.unit_quota !== claims.unit_quota ||
    paid.chain !== claims.chain ||
    paid.asset !== claims.asset ||
    paid.currency !== claims.currency ||
    Number(paid.amount) !== Number(claims.amount) ||
    Math.floor(Date.parse(paid.expires_at) / 1000) !== claims.exp
  )
    reject();
}

/** Fixed, domain-separated receipt claim; sign with the wallet that settled. */
export function paymentAuthorizationMessage(p: {
  quote: Aifp1Quote;
  apiBase: string;
  chain: string;
  txRef: string;
  asset: string;
  idempotencyKey: string;
  payer: string;
  expiresAt: number;
  issuer?: string;
}): string {
  return JSON.stringify([
    "AiFinPay receipt authorization v1",
    trustedPaymentIssuer(p.quote, p.issuer),
    p.quote.quote_id,
    p.quote.nonce,
    p.quote.merchant_id,
    p.quote.network_mode || "live",
    p.chain,
    p.txRef,
    p.asset || "",
    p.idempotencyKey,
    p.payer,
    p.expiresAt,
  ]);
}

function trustedPaymentIssuer(quote: Aifp1Quote, configured = "https://api.aifinpay.io"): string {
  if (quote.payment_authorization?.domain && quote.payment_authorization.domain !== configured) {
    throw new Aifp1QuoteError("receipt authorization domain does not match the trusted paymentIssuer");
  }
  return configured;
}
