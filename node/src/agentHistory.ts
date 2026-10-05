import { resolveAgentPassport, agentPassportWallet, type AgentPassportNetwork } from "./agentPassport.js";
import { aifinpayApiUrl } from "./apiUrl.js";
import { PublicKey } from "@solana/web3.js";
import { solanaV14Inventory } from "./settlementSolanaV14.js";
import type { SolanaNetwork } from "./generated/solanaV14Deployments.generated.js";

export interface AgentHistoryOptions {
  address?: string;
  /** Public @username, AIFP number or aifp_agent_* identifier; never a secret. */
  passport?: string;
  network?: AgentPassportNetwork;
  /** Required with network="solana"; never infer a cluster from an address. */
  solanaNetwork?: SolanaNetwork;
  source?: "transactions" | "receipts";
  limit?: number;
  offset?: number;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
}

/** Public fields returned for source="receipts". Single source of truth — MCP must import, not copy. */
export const AGENT_RECEIPT_FIELDS = [
  "receipt_id",
  "merchant_id",
  "resource",
  "scope",
  "tier",
  "quota",
  "used",
  "remaining",
  "amount",
  "currency",
  "exp",
  "chain",
  "tx_ref",
  "payer",
  "network_mode",
  "settled_at",
  "expires_at",
  "unit_quota",
  "metering_version",
  "asset",
  "network",
  "program",
];

/** Public fields returned for source="transactions". Single source of truth — MCP must import, not copy. */
export const AGENT_TRANSACTION_FIELDS = [
  "tx_hash",
  "log_index",
  "chain",
  "payment_id",
  "block_number",
  "block_ts",
  "agent_address",
  "merchant_address",
  "token_address",
  "total_amount",
  "merchant_amount",
  "treasury_fee",
  "ip_creator_fee",
  "network",
  "program",
  "block_hash",
  "nonce",
  "treasury_address",
  "fee_lamports",
  "nonce_rent_lamports",
  "ata_rent_lamports",
  "cost_allocation",
  "order_id_hash",
  "route_id",
];

function historyIdentity(address: string | undefined, network: AgentPassportNetwork, cluster?: SolanaNetwork) {
  if (network === "solana") {
    if (!cluster) throw new Error("Solana history requires an explicit solanaNetwork");
    const d = solanaV14Inventory(cluster === "mainnet" ? "prod" : "dev", cluster);
    try {
      if (!address || new PublicKey(address).toBase58() !== address) throw new Error();
    } catch {
      throw new Error("History requires a canonical case-preserved Solana address");
    }
    return { address: address!, network: cluster, program: d.programId };
  }
  if (cluster !== undefined) throw new Error("solanaNetwork requires network=solana");
  if (!address || !/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error("History requires an EVM address");
  return { address: address.toLowerCase() };
}

function assertHistoryContext(
  body: Record<string, unknown>,
  selected: ReturnType<typeof historyIdentity>,
  identityField = "address"
) {
  if (
    selected.network &&
    (!body ||
      typeof body !== "object" ||
      body.chain !== "solana" ||
      body.network !== selected.network ||
      body.program !== selected.program ||
      body[identityField] !== selected.address)
  )
    throw new Error("History response changed the selected Solana payer/network/program");
}

function solanaCoverage(value: unknown): Record<string, unknown> {
  const v = value as Record<string, unknown>;
  if (
    !v ||
    typeof v !== "object" ||
    v.coverage_kind !== "retained_rpc_inventory" ||
    v.archive_complete !== false ||
    !(v.coverage_start === null || (Number.isSafeInteger(v.coverage_start) && Number(v.coverage_start) > 0))
  )
    throw new Error("Invalid retained Solana history coverage");
  return { coverage_kind: v.coverage_kind, coverage_start: v.coverage_start, archive_complete: false };
}

/** Read public payment metadata. A passport is resolved to a verified wallet first. */
export async function getAgentHistory(options: AgentHistoryOptions): Promise<Record<string, unknown>> {
  const base = options.baseUrl || "https://aifinpay.io";
  const fetchImpl = options.fetchImpl || fetch;
  const network = options.network || "polygon";
  const source = options.source || "transactions";
  const limit = options.limit ?? 25,
    offset = options.offset ?? 0;
  if (
    !Number.isSafeInteger(limit) ||
    limit < 1 ||
    limit > 100 ||
    !Number.isSafeInteger(offset) ||
    offset < 0 ||
    offset > 100000
  ) {
    throw new Error("History limit must be 1..100 and offset 0..100000");
  }
  if (source !== "transactions" && source !== "receipts") throw new Error("Unknown history source");
  let address = options.address;
  if (options.passport) {
    const identity = await resolveAgentPassport(options.passport, base, fetchImpl);
    identity.wallets = identity.wallets.filter(
      (wallet) => wallet.chain_family === (network === "solana" ? "solana" : "evm") && Number(wallet.verified_at) > 0
    );
    const wallet = agentPassportWallet(identity, network);
    if (
      address &&
      (network === "solana" ? address !== wallet.address : address.toLowerCase() !== wallet.address.toLowerCase())
    ) {
      throw new Error("Address does not match this passport's verified wallet on the requested network");
    }
    address = wallet.address;
  }
  const selected = historyIdentity(address, network, options.solanaNetwork);
  const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
  if (source === "transactions" || network === "solana") query.set("chain", network);
  if (selected.network) {
    query.set("network", selected.network);
    query.set("program", selected.program!);
  }
  const response = await fetchImpl(aifinpayApiUrl(base, `/v1/agents/${selected.address}/${source}?${query}`), {
    headers: { accept: "application/json" },
  });
  if (!response.ok)
    throw new Error(`Payment history unavailable: HTTP ${response.status}; source=${source}; chain=${network}.`);
  const body = (await response.json()) as Record<string, unknown>;
  if (!body || typeof body !== "object" || !Array.isArray(body[source])) throw new Error("Invalid history response");
  assertHistoryContext(body, selected);
  // Defense in depth: even a misconfigured/older backend must not send bearer
  // tokens to a caller of this metadata-only API.
  const fields = source === "receipts" ? AGENT_RECEIPT_FIELDS : AGENT_TRANSACTION_FIELDS;
  const items = (body[source] as Record<string, unknown>[]).map((item) => {
    if (!item || typeof item !== "object") throw new Error("Invalid history row");
    assertHistoryContext(item, selected, source === "receipts" ? "payer" : "agent_address");
    return Object.fromEntries(fields.filter((field) => item[field] !== undefined).map((field) => [field, item[field]]));
  });
  return {
    address: selected.address,
    ...(selected.network ? { chain: "solana", network: selected.network, program: selected.program } : {}),
    ...(options.passport ? { passport: options.passport } : {}),
    source,
    items,
    limit,
    offset,
    next_offset: typeof body.next_offset === "number" ? body.next_offset : null,
    ...(selected.network && body.indexing !== undefined ? { indexing: solanaCoverage(body.indexing) } : {}),
    coverage:
      source === "receipts"
        ? "Retained AiFinPay receipts only; external merchant quota may lag"
        : selected.network
          ? "Verified AiFinPay settlements from retained RPC inventory only; partial history, no archive/full-wallet attestation. Shared transaction costs may be unallocated."
          : `Indexed AiFinPay ${network} settlements only; excludes arbitrary wallet transfers and may lag the chain`,
  };
}

export interface QuotaOptions {
  address: string;
  network?: AgentPassportNetwork;
  solanaNetwork?: SolanaNetwork;
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
  chain?: string;
  network?: SolanaNetwork;
  program?: string;
  asset?: string;
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
  const selected = historyIdentity(options.address, options.network ?? "polygon", options.solanaNetwork);
  const query = new URLSearchParams();
  if (options.network) query.set("chain", options.network);
  if (selected.network) {
    query.set("network", selected.network);
    query.set("program", selected.program!);
  }
  const response = await fetchImpl(
    aifinpayApiUrl(base, `/v1/agents/${selected.address}/receipts${query.size ? `?${query}` : ""}`),
    {
      headers: { accept: "application/json" },
    }
  );
  if (!response.ok) throw new Error(`Quota lookup failed: HTTP ${response.status}`);
  const body = (await response.json()) as Record<string, unknown> & { receipts?: Record<string, unknown>[] };
  if (!body || !Array.isArray(body.receipts)) throw new Error("Invalid quota response");
  assertHistoryContext(body, selected);
  body.receipts.forEach((row) => {
    assertHistoryContext(row, selected, "payer");
    if (
      selected.network &&
      (![row.used, row.remaining, row.unit_quota].every((v) => Number.isSafeInteger(v) && Number(v) >= 0) ||
        !Number.isSafeInteger(Number(row.used) + Number(row.remaining)) ||
        Number(row.used) + Number(row.remaining) !== row.unit_quota ||
        (row.exp !== undefined &&
          row.exp !== null &&
          (!Number.isSafeInteger(row.exp) || Number(row.exp) <= 0 || Number(row.exp) > 8640000000000)))
    )
      throw new Error("Malformed Solana unit quota, usage or expiry");
  });
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
      quota: selected.network ? Number(r.unit_quota) : num(r.quota, 1),
      paid: r.amount != null ? `${r.amount} ${typeof r.currency === "string" ? r.currency : "USD"}` : undefined,
      expires: typeof r.exp === "number" ? new Date(r.exp * 1000).toISOString() : undefined,
      receipt_id: typeof r.receipt_id === "string" ? r.receipt_id : undefined,
      chain: typeof r.chain === "string" ? r.chain : undefined,
      ...(selected.network ? { network: selected.network, program: selected.program } : {}),
      asset: typeof r.asset === "string" ? r.asset : undefined,
    }))
    .sort((a, b) => b.remaining - a.remaining);
  const totals: QuotaSummary["totals"] = {};
  for (const b of batches) {
    const key = b.merchant_id ?? "unknown";
    const cur = totals[key] ?? { remaining: 0, batches: 0 };
    cur.remaining += b.remaining;
    cur.batches += 1;
    if (selected.network && (!Number.isSafeInteger(cur.remaining) || !Number.isSafeInteger(cur.batches)))
      throw new Error("Solana quota totals exceed safe integer bounds");
    totals[key] = cur;
  }
  return { agent: selected.address, totals, batches };
}
