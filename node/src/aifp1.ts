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
import { createHash } from "node:crypto";
import { AiFinPayError } from "./errors.js";

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
 * in the error there is nothing to retry with.
 */
export class Aifp1PayError extends Aifp1Error {
  constructor(msg: string, public readonly txRef?: string, public readonly quoteId?: string) {
    super(msg);
  }
}

/** The gateway rejected a receipt we believed covered the request. */
export class Aifp1ReceiptRejectedError extends Aifp1Error {}

// ── Wire shapes (mirrors of the server; do not invent fields) ─────────────

export type Aifp1Scope = "exact" | "prefix" | "merchant";

/** The 402 body — routes/gateway.js payChallenge(). */
export interface Aifp1Challenge {
  error:       string;          // "AIFP-402"
  protocol:    string;          // "AIFP-1"
  detail?:     string;
  merchant_id: string;
  resource:    string;          // the merchant-relative path, no slug
  unit_weight: number;          // billing units this route costs per call
  base_unit_price_usd?: string;
  how_to_pay?: string[];
  scopes?:     { note?: string; examples?: string[] };
}

/** POST /v1/quote 200 body — routes/aifp.js (`used` is stripped server-side). */
export interface Aifp1Quote {
  quote_id:        string;
  merchant_id:     string;
  resource:        string;
  scope:           Aifp1Scope;
  tier:            string;
  unit_price:      string;
  requests:        number;
  units:           number;
  unit_quota:      number;
  amount:          string;      // batch total, USD, decimal string
  currency:        string;
  accepted_assets: string[];
  accepted_chains: string[];
  pay_to:          Record<string, string>;
  /** Native Polygon v1.3 gross settlement, when enabled by backend readiness. */
  native_settlement?: {
    asset:                 string;       // "POL"
    decimals:              number;
    rate_usd:              string;
    rate_fixed_at?:        string;
    total_wei:             string;       // gross payer amount
    gross_wei?:            string;
    payer_total_wei?:      string;
    merchant_wei:          string;
    treasury_wei:          string;
    creator_wei:           string;
    valid_until?:          string;       // Unix seconds; must equal expires_at
    settlement_semantics?: "gross-inclusive";
  };
  settlement: {
    batch_units:           string;
    total_units:           string;
    gross_units:           string;
    payer_total_units:     string;
    merchant_units:        string;
    protocol_fee_units:    string;
    creator_units:         string;
    fee_on_top:            false;
  };
  nonce:      string;
  expires_at: string;
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
    ? { amount: formatUnits(ns.total_wei, ns.decimals), asset: ns.asset }
    : null;

  // Fee as basis points, from the split the quote already carries. Stated so the
  // agent sees the rate, not just the total — the same reason the 402 does.
  let feeBps: number | null = null;
  try {
    const total = BigInt(q.settlement.gross_units);
    const merchant = BigInt(q.settlement.merchant_units);
    if (total > 0n) feeBps = Number(((total - merchant) * 10000n) / total);
  } catch { /* leave null rather than guess */ }

  const where =
    q.scope === "merchant" ? `anything on ${q.merchant_id}`
    : q.scope === "prefix" ? `any path under ${q.resource}`
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
  receipt_id:  string;
  receipt:     string;          // the bearer JWT
  status:      string;          // "settled"
  tx_ref:      string;
  merchant_id: string;
  resource:    string;
  scope:       Aifp1Scope;
  amount:      string;
  currency:    string;
  quota:       number;
  unit_quota:  number;
  asset:       string;
  chain:       string;
  settled_at:  string;
  expires_at:  string;
  policy_exceeded?: boolean;
  policy_reason?:   string;
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
    if (resource === "/") return true;              // whole site, spelled as a prefix
    if (path === resource) return true;             // the prefix path itself
    // The trailing slash is what stops /articles covering /articles-internal.
    const boundary = resource.endsWith("/") ? resource : resource + "/";
    return path.startsWith(boundary);
  }
  return path === resource;                         // 'exact', and anything unrecognised
}

/**
 * Mirror of routes/gateway.js prefixHint(): /articles/2026/thing → /articles/,
 * and a single-segment path → "/" (the whole site).
 */
export function prefixHint(path: string): string {
  const segs = String(path || "/").split("/").filter(Boolean);
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
): { site: string; slug: string; restPath: string } {
  const u = new URL(url);
  if (!allowedOrigins.length) {
    throw new Aifp1Error(
      "no allowed gateway origins configured — refusing to pay any host. "
      + "Pass gatewayOrigins explicitly for a self-hosted gateway.",
    );
  }
  if (!allowedOrigins.includes(u.origin)) {
    throw new Aifp1Error(
      `${u.origin} is not a known AiFinPay gateway (allowed: ${allowedOrigins.join(", ")}). `
      + "Refusing to settle: a 402 is unauthenticated, so paying an unrecognised host "
      + "means paying whoever answered.",
    );
  }
  const segments = u.pathname.split("/").filter(Boolean);
  if (segments.length === 0) {
    throw new Aifp1Error(`${url} has no merchant slug — a gateway URL looks like https://gateway.aifinpay.io/{slug}/path`);
  }
  const slug = segments[0]!;
  return {
    site:     `${u.origin}/${slug}`,
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
export function idempotencyKeyFor(p: {
  quoteId: string; chain: string; asset: string; txRef: string;
}): string {
  const digest = createHash("sha256")
    .update(`aifp1|${p.quoteId}|${p.asset}|${p.chain}|${p.txRef}`)
    .digest("hex");
  return `aifp1-${digest}`;   // 70 chars — well under the server's 200 limit
}

// ── Receipt cache ─────────────────────────────────────────────────────────

export interface Aifp1CachedReceipt {
  /** origin + slug, as parseGatewayUrl() computes it. */
  site:        string;
  merchantId:  string;
  receiptId:   string;
  /** The bearer JWT. Never log this. */
  jwt:         string;
  scope:       Aifp1Scope;
  resource:    string;
  unitQuota:   number;
  /** Billing units we believe are left. Corrected from AIFP-Quota-Remaining. */
  remaining:   number;
  /** JWT expiry, ms epoch. */
  expiresAt:   number;
  amountUsd:   number;
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
      await running.catch(() => { /* the winner's failure is theirs to throw */ });
      return "retry";
    }
    const p = buy().finally(() => { this.inflight.delete(site); });
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
    return this.entries.find((e) =>
      e.site === site
      && (merchantId === undefined || e.merchantId === merchantId)
      && e.remaining > 0
      && e.expiresAt - EXPIRY_MARGIN_MS > now
      && scopeCovers(e.scope, e.resource, restPath));
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

  get size(): number { return this.entries.length; }
}

// ── Options ───────────────────────────────────────────────────────────────

export interface Aifp1FetchOptions {
  /**
   * How wide a batch to buy. Default "prefix" — see the comment on
   * resolveScope() for why the default is not "exact".
   */
  scope?:    Aifp1Scope;
  /** Override the resource the batch is scoped to (ignored for "merchant"). */
  resource?: string;
  /**
   * Billing units to prepay. Omit it and the client buys roughly
   * DEFAULT_BATCH_USD worth, computed from the base unit price the gateway
   * states in its own 402 — so the batch stays the same amount of MONEY when
   * the tiers move.
   */
  units?:    number;
  /** Where /v1/quote and /v1/pay live. Default https://api.aifinpay.io */
  apiBaseUrl?: string;
  /**
   * Gateway origins this client will settle against. Defaults to
   * DEFAULT_GATEWAY_ORIGINS — set it only for a self-hosted gateway, and
   * never to a host you do not control the paywall of.
   */
  gatewayOrigins?: readonly string[];
  /** Value for the AIFP-Agent-Id header; defaults to the agent's EVM address. */
  agentId?:  string;
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
const DEFAULT_BATCH_USD = 0.10;
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
  challenge: Aifp1Challenge,
): { scope: Aifp1Scope; resource: string | undefined } {
  const scope = opts.scope ?? "prefix";
  if (scope === "merchant") return { scope, resource: undefined };  // server stores "*"
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
  fetchImpl: typeof fetch;
  cache:     Aifp1ReceiptCache;
  /** AIFP-Agent-Id / agent_id — a 0x address, or agent policies cannot key on it. */
  agentId:   string;
  /**
   * Settle one canonical v1.3 gross amount, returning a hash whose transaction
   * was included AND succeeded. Implementations must independently verify the
   * deployment/runtime profile before signing.
   */
  settle(p: {
    merchantWallet: `0x${string}`;
    grossWei:       bigint;
    merchantWei:    bigint;
    treasuryWei:    bigint;
    creatorWei:     bigint;
    validUntil:     bigint;
    orderId:        string;
  }): Promise<`0x${string}`>;
  /** Per-call cap. false ⇒ the caller asked to skip rather than throw. */
  checkPerCall(usd: number): boolean;
  /** Daily cap. "skip" ⇒ drop the call; a string is a reservation to resolve. */
  reserveDaily(usd: number): Promise<string | null | "skip">;
  commit(reservationId: string, usd: number): Promise<void>;
  release(reservationId: string): Promise<void>;
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
    if (
      s.fee_on_top !== false
      || gross <= 0n
      || payer !== gross
      || total !== gross
      || creator !== 0n
      || protocol !== expectedProtocol
      || merchant !== gross - expectedProtocol
    ) {
      throw new Error("split mismatch");
    }
  } catch {
    throw new Aifp1QuoteError(
      `quote ${quote.quote_id} does not implement canonical AIFP-1 gross economics (payer 100%, merchant 99%, protocol 1%, creator 0%)`,
    );
  }
}

/** Is this response the AIFP-1 paywall asking for money? */
function isAifp1Challenge(body: unknown): body is Aifp1Challenge {
  const b = body as Partial<Aifp1Challenge> | null;
  return !!b && b.protocol === "AIFP-1" && typeof b.merchant_id === "string"
    && typeof b.resource === "string";
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
  opts: Aifp1FetchOptions = {},
): Promise<Response | null> {
  const { site, restPath } = parseGatewayUrl(url, opts.gatewayOrigins ?? DEFAULT_GATEWAY_ORIGINS);

  // A paid flow sends the request twice, so the body has to survive being sent
  // twice. A stream cannot, and finding that out after paying would mean money
  // moved for a request that can no longer be made.
  if (init.body !== undefined && init.body !== null
      && typeof init.body === "object"
      && typeof (init.body as { getReader?: unknown }).getReader === "function") {
    throw new Aifp1Error(
      "aifp1Fetch cannot use a stream body: a paywalled request is sent twice "
      + "(once to learn the price, once with the receipt) and a stream can only "
      + "be read once. Pass a string, Buffer, or URLSearchParams.",
    );
  }

  const send = (receiptJwt?: string): Promise<Response> => {
    // new Headers() rather than a spread: RequestInit.headers is legally a
    // Headers instance or an array of pairs, and spreading either yields {} —
    // silently dropping every header the caller set, including their auth.
    const headers = new Headers(init.headers);
    headers.set("AIFP-Agent-Id", deps.agentId);
    if (receiptJwt) headers.set("AIFP-Receipt", receiptJwt);
    return deps.fetchImpl(url, {
      ...init,
      headers,
      // The receipt is a bearer token. fetch follows redirects by default and
      // only strips authorization/cookie/host on a cross-origin hop — a custom
      // header rides along, so one 302 from a merchant upstream would hand the
      // batch to another host. Stop at the redirect and let the caller decide.
      ...(receiptJwt ? { redirect: "manual" as const } : {}),
    });
  };

  // 1. Spend a batch we already own, if one covers this path.
  const held = deps.cache.find(site, restPath);
  const resp = await send(held?.jwt);
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
      const detail = await resp.clone().text().catch(() => "");
      let ours = false;
      try { ours = JSON.parse(detail)?.error === "AIFP-403"; } catch { /* upstream body, not ours */ }
      if (!ours) return resp;               // the merchant's 403, receipt intact

      deps.cache.evict(held);
      throw new Aifp1ReceiptRejectedError(
        `gateway refused receipt ${held.receiptId} for ${restPath} (403): ${detail.slice(0, 300)}`,
      );
    }
    return resp;
  }

  // 402 — but only AIFP-1 is ours. x402 and anything else passes through
  // untouched; call() owns those flows.
  const challenge = await resp.clone().json().catch(() => null);
  if (!isAifp1Challenge(challenge)) return resp;

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
    // 2. Quote.
    const apiBase = (opts.apiBaseUrl ?? DEFAULT_API_BASE).replace(/\/$/, "");
    const { scope, resource } = resolveScope(opts, challenge);
    const quote = await requestQuote(deps, apiBase, {
      merchant_id: challenge.merchant_id,
      ...(resource !== undefined ? { resource } : {}),
      scope,
      units: opts.units ?? defaultUnitsFor(challenge),
      agent_id: deps.agentId,
    });

    // The merchant we are about to pay must be the merchant that refused us.
    // Cheap, and the failure it catches is the one worth catching.
    if (quote.merchant_id !== challenge.merchant_id) {
      throw new Aifp1QuoteError(
        `quote ${quote.quote_id} is for merchant ${quote.merchant_id} but ${site} refused as ${challenge.merchant_id} — refusing to pay`,
      );
    }

    validateCanonicalQuoteEconomics(quote);
    const quoteExpiryMs = Date.parse(quote.expires_at);
    if (!Number.isFinite(quoteExpiryMs) || quoteExpiryMs <= Date.now()) {
      throw new Aifp1QuoteError(`quote ${quote.quote_id} is expired or has invalid expires_at`);
    }

    // 3. Budget. The quote states the batch total in USD, so both caps are
    // checked against the real figure, before anything is signed.
    const amountUsd = Number(quote.amount);
    if (!Number.isFinite(amountUsd) || amountUsd < 0) {
      throw new Aifp1QuoteError(`quote ${quote.quote_id} has an unusable amount "${quote.amount}"`);
    }
    if (!deps.checkPerCall(amountUsd)) return null;
    const reservation = await deps.reserveDaily(amountUsd);
    if (reservation === "skip") return null;

    let settled = false;
    try {
      // 4. Settle on-chain, then exchange the tx for a receipt.
      const native = quote.native_settlement;
      if (!native) {
        throw new Aifp1SettlementUnsupportedError(
          `quote ${quote.quote_id} carries no native_settlement — the backend had no live POL rate, `
          + `and the deployed B2BSplitter has no ERC-20 entrypoint, so this SDK cannot settle `
          + `${quote.accepted_assets.join("/")}. Retry when a POL rate is available or settle the quote yourself.`,
        );
      }
      if (!quote.accepted_chains.includes("polygon") || !quote.pay_to.polygon) {
        throw new Aifp1SettlementUnsupportedError(
          `quote ${quote.quote_id} does not accept polygon (accepts ${quote.accepted_chains.join(", ")}) — `
          + `AIFP-1 settlement verification is Polygon-only server-side (aifp/verify-settlement.js)`,
        );
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
    const weiUsd = Number.isFinite(quotedRate) && quotedRate > 0
      ? (Number(BigInt(native.total_wei)) / 1e18) * quotedRate
      : NaN;
    if (!Number.isFinite(weiUsd)) {
      throw new Aifp1QuoteError(
        `quote ${quote.quote_id} states total_wei ${native.total_wei} at rate "${native.rate_usd}" — `
        + `unusable, and the caps were checked against $${amountUsd}`,
      );
    }
    // 2% covers native conversion rounding and a
    // rate printed to six places; anything wider is a disagreement, not drift.
    if (Math.abs(weiUsd - amountUsd) > Math.max(0.02 * amountUsd, 1e-6)) {
      throw new Aifp1QuoteError(
        `quote ${quote.quote_id} would debit ${native.total_wei} wei ≈ $${weiUsd.toFixed(6)} `
        + `but states $${amountUsd} — refusing to sign a payment the budget caps did not see`,
      );
    }

    const nativeGross = BigInt(native.gross_wei ?? native.total_wei);
    const nativeMerchant = BigInt(native.merchant_wei);
    const nativeTreasury = BigInt(native.treasury_wei);
    const nativeCreator = BigInt(native.creator_wei);
    if (
      native.settlement_semantics !== "gross-inclusive"
      || BigInt(native.payer_total_wei ?? native.total_wei) !== nativeGross
      || BigInt(native.total_wei) !== nativeGross
      || nativeCreator !== 0n
      || nativeTreasury !== nativeGross / 100n
      || nativeMerchant !== nativeGross - nativeTreasury
    ) {
      throw new Aifp1QuoteError(
        `quote ${quote.quote_id} native settlement does not match canonical AIFP-1 gross split`,
      );
    }
    const validUntil = BigInt(native.valid_until ?? Math.floor(quoteExpiryMs / 1000));
    if (validUntil !== BigInt(Math.floor(quoteExpiryMs / 1000))) {
      throw new Aifp1QuoteError(`quote ${quote.quote_id} valid_until does not match expires_at`);
    }

    const txRef = await deps.settle({
        merchantWallet: quote.pay_to.polygon as `0x${string}`,
        grossWei:       nativeGross,
        merchantWei:    nativeMerchant,
        treasuryWei:    nativeTreasury,
        creatorWei:     nativeCreator,
        validUntil,
        // The binding the server verifies on-chain: the Payment event's orderId
        // must equal the quote id, or /v1/pay answers order_id_mismatch.
        orderId:        quote.quote_id,
      });

      // Money has moved. The reservation becomes settled spend here and not one
      // line later — everything below can still fail, and none of those failures
      // give the funds back.
      settled = true;
      if (typeof reservation === "string") await deps.commit(reservation, amountUsd);

      const paid = await submitPayment(deps, apiBase, quote, txRef, native.asset, opts);

      // 5. Retry the original request with the receipt.
      const receiptResp = await send(paid.receipt);
      if (receiptResp.status === 402) {
        const body = await receiptResp.clone().text().catch(() => "");
        throw new Aifp1ReceiptRejectedError(
          `gateway still answered 402 for ${restPath} with a freshly settled receipt `
          + `${paid.receipt_id} (tx ${txRef}): ${body.slice(0, 300)}`,
        );
      }

      // 6. Keep the batch. This is the whole point of the design: the next call
      // this receipt covers costs a header, not a transaction.
      const entry: Aifp1CachedReceipt = {
        site,
        merchantId: paid.merchant_id,
        receiptId:  paid.receipt_id,
        jwt:        paid.receipt,
        scope:      paid.scope,
        resource:   paid.resource,
        unitQuota:  paid.unit_quota,
        remaining:  paid.unit_quota,
        expiresAt:  Date.parse(paid.expires_at),
        amountUsd,
      };
      // The gateway's own count if it gave one; otherwise the batch minus the
      // weight of the route that refused us, which is the only figure we can
      // justify locally.
      const remaining = quotaRemaining(receiptResp);
      entry.remaining = remaining !== null
        ? remaining
        : Math.max(0, paid.unit_quota - challenge.unit_weight);
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
      deps.cache.put(entry);

      deps.onPaid?.({
        merchantId: paid.merchant_id, amountUsd, txRef, receiptId: paid.receipt_id,
      });
      return receiptResp;
    } finally {
      // Anything that did not move money gives the cap back now rather than
      // waiting for the reservation to expire — same rule as call().
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

async function requestQuote(
  deps: Aifp1Deps,
  apiBase: string,
  body: Record<string, unknown>,
): Promise<Aifp1Quote> {
  let r: Response;
  try {
    r = await deps.fetchImpl(`${apiBase}/v1/quote`, {
      method:  "POST",
      headers: { "content-type": "application/json", "AIFP-Agent-Id": deps.agentId },
      body:    JSON.stringify(body),
    });
  } catch (e) {
    throw new Aifp1QuoteError(`POST ${apiBase}/v1/quote failed: ${(e as Error).message}`);
  }
  const text = await r.text();
  if (!r.ok) {
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
  deps: Aifp1Deps,
  apiBase: string,
  quote: Aifp1Quote,
  txRef: `0x${string}`,
  asset: string,
  opts: Aifp1FetchOptions,
): Promise<Aifp1PayResult> {
  const chain = "polygon";
  const idempotencyKey = idempotencyKeyFor({ quoteId: quote.quote_id, chain, asset, txRef });
  const deadline = Date.now() + (opts.settlementConfirmMs ?? DEFAULT_SETTLEMENT_CONFIRM_MS);

  let lastDetail = "";
  for (let attempt = 0; ; attempt++) {
    let r: Response;
    try {
      r = await deps.fetchImpl(`${apiBase}/v1/pay`, {
        method: "POST",
        headers: {
          "content-type":    "application/json",
          "Idempotency-Key": idempotencyKey,
          "AIFP-Agent-Id":   deps.agentId,
        },
        body: JSON.stringify({
          quote_id: quote.quote_id, chain, asset, tx_ref: txRef, agent_id: deps.agentId,
        }),
      });
    } catch (e) {
      throw new Aifp1PayError(
        `POST ${apiBase}/v1/pay failed after settling: ${(e as Error).message}`,
        txRef, quote.quote_id,
      );
    }
    const text = await r.text();
    if (r.ok) {
      const paid = JSON.parse(text) as Aifp1PayResult;
      if (!paid.receipt) {
        throw new Aifp1PayError(`/v1/pay → 200 without a receipt: ${text.slice(0, 300)}`, txRef, quote.quote_id);
      }
      return paid;
    }
    lastDetail = text.slice(0, 400);
    // 425 is the only status worth retrying: the chain has not caught up with
    // us yet. Everything else is a verdict.
    if (r.status !== 425 || Date.now() >= deadline) {
      throw new Aifp1PayError(
        `POST /v1/pay → ${r.status} after on-chain settlement ${txRef} for quote ${quote.quote_id}: ${lastDetail}`,
        txRef, quote.quote_id,
      );
    }
    await sleep(Math.min(1000 * 2 ** attempt, 8000));
  }
}
