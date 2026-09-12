import type { ToolContext } from "../server.js";
import { apiUrl } from "../api.js";

export function agentHistoryTool() {
  return {
    name: "agent_history",
    description: "Read an agent's payment history by EVM address, public passport identifier, or both. Defaults to the current wallet. Transactions are indexed AiFinPay Polygon settlements, not arbitrary wallet transfers. Receipts include retained prepaid batches and test payments. Never pass a seed, private key or API secret as a passport.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      address: { type: "string" },
      passport: { type: "string", description: "Public @username, AIFP-… number or aifp_agent_… identifier" },
      network: { type: "string", default: "polygon", description: "Exact passport wallet network; indexed transactions currently support polygon only" },
      source: { type: "string", enum: ["transactions", "receipts"], default: "transactions" },
      limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
      offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
    } },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
}

export async function runAgentHistory(ctx: ToolContext, args: Record<string, unknown>) {
  const base = ctx.config.baseUrl || "https://aifinpay.io";
  const source = args.source ?? "transactions", network = args.network ?? "polygon";
  const limit = args.limit ?? 25, offset = args.offset ?? 0;
  const failure = (message: string) => ({ isError: true, content: [{ type: "text", text: message }] });
  if (!Number.isSafeInteger(limit) || Number(limit) < 1 || Number(limit) > 100 ||
      !Number.isSafeInteger(offset) || Number(offset) < 0 || Number(offset) > 100000) return failure("Invalid history pagination");
  if (source !== "receipts" && source !== "transactions") return failure("Unknown history source");
  async function get(path: string) {
    const response = await ctx.agent.inner.fetchImpl(apiUrl(base, path), { headers: { accept: "application/json" } });
    if (!response.ok) throw new Error(`HTTP ${response.status} from history/resolver; passport resolution requires a deployed Agent Passport backend`);
    return await response.json() as any;
  }
  try {
    let address = args.address == null ? undefined : String(args.address);
    if (args.passport) {
      const identifier = String(args.passport).trim();
      if (!/^(@[a-z][a-z0-9_]{2,31}|AIFP-\d{1,18}|aifp_agent_[0-9a-f]{32})$/i.test(identifier)) {
        return failure("passport must be a public @username, AIFP number or aifp_agent_* id; never a secret");
      }
      const resolved = await get(`/api/agent/resolve/${encodeURIComponent(identifier)}`);
      if (resolved?.agent?.status !== "active" || !Array.isArray(resolved.agent.wallets)) throw new Error("Passport is not active or has no verified wallets");
      const wallets = resolved.agent.wallets.filter((w: any) => w.network === network && w.chain_family === "evm" && Number(w.verified_at) > 0);
      const wallet = wallets.find((w: any) => w.is_primary) || wallets[0];
      if (!wallet || typeof wallet.address !== "string") throw new Error("Passport has no verified EVM wallet on the requested network");
      if (address && address.toLowerCase() !== wallet.address.toLowerCase()) throw new Error("Address does not match passport wallet");
      address = wallet.address;
    }
    address ??= ctx.agent.evmAddress;
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) return failure("Expected an EVM address");
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (source === "transactions") query.set("chain", String(network));
    const body = await get(`/v1/agents/${address.toLowerCase()}/${source}?${query}`);
    if (!Array.isArray(body?.[source])) throw new Error("Invalid history response");
    const fields = source === "receipts"
      ? ["receipt_id", "merchant_id", "resource", "scope", "tier", "quota", "used", "remaining", "amount", "currency", "exp", "chain", "tx_ref", "payer", "network_mode", "settled_at", "expires_at", "unit_quota", "metering_version"]
      : ["tx_hash", "log_index", "chain", "payment_id", "block_number", "block_ts", "agent_address", "merchant_address", "token_address", "total_amount", "merchant_amount", "treasury_fee", "ip_creator_fee"];
    const items = body[source].map((row: any) => Object.fromEntries(fields.filter(f => row?.[f] !== undefined).map(f => [f, row[f]])));
    return { content: [{ type: "text", text: JSON.stringify({ address: address.toLowerCase(), source, items,
      limit, offset, next_offset: typeof body.next_offset === "number" ? body.next_offset : null,
      coverage: source === "receipts" ? "Retained receipts only; externally metered quotas may lag" : "Indexed AiFinPay Polygon settlements only; excludes arbitrary wallet transfers and may lag the chain",
    }, null, 2) }] };
  } catch (error) { return failure(`History lookup failed: ${(error as Error).message}`); }
}
