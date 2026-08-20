// ──────────────────────────────────────────────────────────────────────────
// Wire shapes — mirrors of the server, not a translation layer.
//
// Every field name here is copied verbatim from the code that produces it
// (backend/aifp/receipts.js signReceipt, backend/aifp/resources.js
// createResource). No camelCase rewrite, no renaming, no "nicer" aliases:
// a partner debugging a 403 pastes the decoded JWT next to their own object
// and greps for the same word in both. A translation layer buys ergonomics
// once and costs a support round-trip on every incident after that.
// ──────────────────────────────────────────────────────────────────────────

/** The three merchant-selectable price settings. There are no custom prices. */
export type Tier = "standard" | "complex" | "premium";

/** Which paths one prepaid batch may be spent on (backend/aifp/scope.js). */
export type Scope = "exact" | "prefix" | "merchant";

export type ResourceType = "page" | "api" | "dataset" | "mcp_tool" | "product";

/** Claims our issuer actually signs. Optional fields are optional in the
 *  signer too — `quota` predates billing units and still appears on old
 *  receipts, which is why the gate falls back to it rather than requiring
 *  `unit_quota`. */
export interface AifpReceiptClaims {
  iss: string;
  aud: string;
  /** Agent id ("agt_…") — the payer, not the caller. See README on bearer risk. */
  sub: string;
  iat: number;
  exp: number;
  /** Path the batch was quoted for; "*" when scope is "merchant". */
  resource: string;
  scope: Scope;
  tier?: Tier;
  amount: string;
  currency?: string;
  /** Legacy: prepaid REQUEST count. */
  quota?: number;
  /** Canonical: prepaid BILLING UNITS. */
  unit_quota?: number;
  /** "rcpt_" + 16 hex — the quota counter key, and the only id the meter uses. */
  receipt_id: string;
  nonce: string;
  asset?: string;
  chain?: string;
  tx_ref?: string;
  /** Absent on a quota receipt. The issuer signs other token kinds with the same
   *  key and the same audience — `"action"` is a per-call billing receipt, proof
   *  that a call was ALREADY served and charged. The gate refuses to spend
   *  anything that carries this claim; see the type check in core.ts. */
  typ_aifp?: string;
}

/** Registry record, field-for-field what backend/aifp/resources.js stores. */
export interface AifpResource {
  /** "res_" + 12 hex. */
  id: string;
  /** "/api/search" or "/api/lookup/*". */
  route_pattern: string;
  type: ResourceType;
  paywall_enabled: boolean;
  tier: Tier | string | null;
  /** Billing units per call; null → resolve from the tier preset. */
  unit_weight: number | null;
  name: string | null;
  created_at: string;
  /** Present on a create/upsert response from a backend that reports it: false
   *  means the record only reached a single API process's memory because Redis
   *  was down, so it will not survive a restart and the dashboard will never
   *  show it. Absent on older backends. */
  durable?: boolean;
}

/** What you send to create or patch a resource. */
export interface ResourceInput {
  route_pattern: string;
  type: ResourceType;
  paywall_enabled?: boolean;
  tier?: Tier | string | null;
  unit_weight?: number | null;
  name?: string | null;
}

/** What the gate hands your handler once a call is paid for. */
export interface AifpContext {
  /** payload.sub — the agent that PAID. Advisory only; see requireAgentMatch. */
  agent: string | null;
  receipt_id: string;
  /** The resource this call was metered against (route_pattern in registry mode). */
  resource: string;
  /** Billing units this call consumed. */
  weight: number;
  /** The batch limit in billing units. */
  unit_quota: number;
  /** Units consumed AFTER this call. */
  used: number;
  remaining: number;
  /** "open" = the merchant registered this resource with paywall_enabled false. */
  mode: "paid" | "open";
}

export interface GateErrorBody {
  error: "AIFP-402" | "AIFP-403" | "AIFP-503-METER" | "AIFP-503-PRICING";
  detail: string;
  protocol?: "AIFP-1";
  merchant_id?: string;
  resource?: string;
  tier?: Tier;
  unit_weight?: number;
  unit_price_usd?: string;
  min_requests?: number;
  protocol_fee_bps?: 100;
  no_minimum_fee?: true;
  how_to_pay?: string[];
}

export type GateResult =
  | { ok: true; status: 200; headers: Record<string, string>; aifp: AifpContext }
  | { ok: false; status: 402 | 403 | 503; headers: Record<string, string>; body: GateErrorBody };

/** What the core needs from a request. Deliberately two fields: it is the whole
 *  reason the decision logic can be unit-tested without a server, and the whole
 *  reason a Fastify/Hono/Workers adapter is ~15 lines. */
export interface GateRequest {
  path: string;
  header(name: string): string | undefined;
}

export type GateEventKind = "402" | "serve" | "403" | "meter_error" | "pricing_unavailable";

export interface GateEvent {
  kind: GateEventKind;
  resource: string;
  weight: number;
  agent?: string | null;
  receipt_id?: string;
  detail?: string;
}

/** Public view of a merchant, as `GET /v1/merchants/:id` returns it. Loosely
 *  typed on purpose — the control plane may add fields, and a strict interface
 *  here would make a server-side addition look like a client-side break. */
export interface MerchantPublicView {
  merchant_id: string;
  name?: string;
  pay_to?: Record<string, string>;
  unit_prices?: Record<string, string | number>;
  [k: string]: unknown;
}

export interface MerchantStats {
  [k: string]: unknown;
}

export interface SettlementRecord {
  [k: string]: unknown;
}
