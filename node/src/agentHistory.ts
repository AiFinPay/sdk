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
  const fields = source === "receipts"
    ? ["receipt_id", "merchant_id", "resource", "scope", "tier", "quota", "used", "remaining", "amount", "currency", "exp", "chain", "tx_ref", "payer", "network_mode", "settled_at", "expires_at", "unit_quota", "metering_version"]
    : ["tx_hash", "log_index", "chain", "payment_id", "block_number", "block_ts", "agent_address", "merchant_address", "token_address", "total_amount", "merchant_amount", "treasury_fee", "ip_creator_fee"];
  const items = (body[source] as Record<string, unknown>[]).map(item => Object.fromEntries(
    fields.filter(field => item[field] !== undefined).map(field => [field, item[field]])));
  return { address: address.toLowerCase(), ...(options.passport ? { passport: options.passport } : {}),
    source, items, limit, offset,
    next_offset: typeof body.next_offset === "number" ? body.next_offset : null,
    coverage: source === "receipts" ? "Retained AiFinPay receipts only; external merchant quota may lag" : "Indexed AiFinPay Polygon settlements only; excludes arbitrary wallet transfers and may lag the chain" };
}
