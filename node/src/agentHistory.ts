import { resolveAgentPassport, agentPassportWallet, type AgentPassportNetwork } from "./agentPassport.js";
import { aifinpayApiUrl } from "./apiUrl.js";

export interface AgentHistoryOptions {
  address?: string;
  /** Public @username, AIFP number or aifp_agent_* identifier; never a secret. */
  passport?: string;
  network?: AgentPassportNetwork;
  source?: "transactions" | "receipts";
  limit?: number;
  offset?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Public fields returned for source="receipts". Single source of truth — MCP must import, not copy. */
export const AGENT_RECEIPT_FIELDS = [
  "receipt_id", "merchant_id", "resource", "scope", "tier", "quota", "used",
  "remaining", "amount", "currency", "exp", "chain", "tx_ref", "payer",
  "network_mode", "settled_at", "expires_at", "unit_quota", "metering_version",
];

/** Public fields returned for source="transactions". Single source of truth — MCP must import, not copy. */
export const AGENT_TRANSACTION_FIELDS = [
  "tx_hash", "log_index", "chain", "payment_id", "block_number", "block_ts",
  "agent_address", "merchant_address", "token_address", "total_amount",
  "merchant_amount", "treasury_fee", "ip_creator_fee",
];

/** Read public payment metadata. A passport is resolved to a verified wallet first. */
export async function getAgentHistory(options: AgentHistoryOptions): Promise<Record<string, unknown>> {
  const base = options.baseUrl || "https://aifinpay.io";
  const fetchImpl = options.fetchImpl || fetch;
  const network = options.network || "polygon";
  const source = options.source || "transactions";
  const limit = options.limit ?? 25, offset = options.offset ?? 0;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100000) {
    throw new Error("History limit must be 1..100 and offset 0..100000");
  }
  if (source !== "transactions" && source !== "receipts") throw new Error("Unknown history source");
  let address = options.address;
  if (options.passport) {
    const identity = await resolveAgentPassport(options.passport, base, fetchImpl);
    identity.wallets = identity.wallets.filter(wallet => wallet.chain_family === "evm" && Number(wallet.verified_at) > 0);
    const wallet = agentPassportWallet(identity, network);
    if (address && address.toLowerCase() !== wallet.address.toLowerCase()) {
      throw new Error("Address does not match this passport's verified wallet on the requested network");
    }
    address = wallet.address;
  }
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("History requires an EVM address or a passport with an EVM wallet binding");
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (source === "transactions") query.set("chain", network);
  const response = await fetchImpl(aifinpayApiUrl(base,
    `/v1/agents/${address.toLowerCase()}/${source}?${query}`), { headers: { accept: "application/json" } });
  if (!response.ok) throw new Error(`Payment history unavailable: HTTP ${response.status}; source=${source}. Use receipts for retained prepaid batches; indexed transactions currently cover Polygon only.`);
  const body = await response.json() as Record<string, unknown>;
  if (!body || typeof body !== "object" || !Array.isArray(body[source])) throw new Error("Invalid history response");
  // Defense in depth: even a misconfigured/older backend must not send bearer
  // tokens to a caller of this metadata-only API.
  const fields = source === "receipts" ? AGENT_RECEIPT_FIELDS : AGENT_TRANSACTION_FIELDS;
  const items = (body[source] as Record<string, unknown>[]).map(item => Object.fromEntries(
    fields.filter(field => item[field] !== undefined).map(field => [field, item[field]])));
  return { address: address.toLowerCase(), ...(options.passport ? { passport: options.passport } : {}),
    source, items, limit, offset,
    next_offset: typeof body.next_offset === "number" ? body.next_offset : null,
    coverage: source === "receipts" ? "Retained AiFinPay receipts only; external merchant quota may lag" : "Indexed AiFinPay Polygon settlements only; excludes arbitrary wallet transfers and may lag the chain" };
}

export interface QuotaOptions {
  address: string;
  /** Optional mrch_… filter — only batches bought from this service. */
  merchantId?: string;
  /** Also list batches with 0 remaining (still retained, not yet expired). */
  includeExhausted?: boolean;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

export interface QuotaBatch {
  merchant_id?: string;
  resource?: string;
  scope: string;
  tier?: string;
  used: number;
  remaining: number;
  quota: number;
  paid?: string;
  expires?: string;
  receipt_id?: string;
}

export interface QuotaSummary {
  agent: string;
  totals: Record<string, { remaining: number; batches: number }>;
  batches: QuotaBatch[];
}

/**
 * Prepaid quota batches for an address, most room first, rolled up per
 * merchant. Data only — the human-facing "no quota, go pay a 402" note stays
 * with the caller (MCP). `remaining` is authoritative where AiFinPay meters;
 * merchants running their own gate meter locally and our copy can lag.
 */
export async function getQuota(options: QuotaOptions): Promise<QuotaSummary> {
  const base = (options.baseUrl || "https://aifinpay.io").replace(/\/+$/, "");
  const fetchImpl = options.fetchImpl || fetch;
  const address = options.address.toLowerCase();
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("Quota requires an EVM address");
  const response = await fetchImpl(aifinpayApiUrl(base, `/v1/agents/${address}/receipts`), {
    headers: { accept: "application/json" },
  });
  if (!response.ok) throw new Error(`Quota lookup failed: HTTP ${response.status}`);
  const body = (await response.json()) as { receipts?: Record<string, unknown>[] };
  const now = Math.floor(Date.now() / 1000);
  const num = (v: unknown, dflt: number) => (typeof v === "number" && Number.isFinite(v) ? v : dflt);
  const batches: QuotaBatch[] = ((body.receipts ?? []) as Record<string, unknown>[])
    .filter((r) => r.exp == null || num(r.exp, 0) > now)
    .filter((r) => (options.merchantId ? r.merchant_id === options.merchantId : true))
    .filter((r) => options.includeExhausted || num(r.remaining, 0) > 0)
    .map((r) => ({
      merchant_id: typeof r.merchant_id === "string" ? r.merchant_id : undefined,
      resource: typeof r.resource === "string" ? r.resource : undefined,
      scope: typeof r.scope === "string" ? r.scope : "exact",
      tier: typeof r.tier === "string" ? r.tier : undefined,
      used: num(r.used, 0),
      remaining: num(r.remaining, 0),
      quota: num(r.quota, 1),
      paid: r.amount != null ? `${r.amount} ${typeof r.currency === "string" ? r.currency : "USD"}` : undefined,
      expires: typeof r.exp === "number" ? new Date(r.exp * 1000).toISOString() : undefined,
      receipt_id: typeof r.receipt_id === "string" ? r.receipt_id : undefined,
    }))
    .sort((a, b) => b.remaining - a.remaining);
  const totals: QuotaSummary["totals"] = {};
  for (const b of batches) {
    const key = b.merchant_id ?? "unknown";
    const cur = totals[key] ?? { remaining: 0, batches: 0 };
    cur.remaining += b.remaining;
    cur.batches += 1;
    totals[key] = cur;
  }
  return { agent: address, totals, batches };
}
