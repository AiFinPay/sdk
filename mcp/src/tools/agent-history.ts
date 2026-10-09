import { AGENT_RECEIPT_FIELDS, AGENT_TRANSACTION_FIELDS } from "@aifinpay/agent";
import type { ToolContext } from "../server.js";
import { apiUrl } from "../api.js";
import {
  isSolanaPublicKey,
  solanaHistorySelection,
  assertSolanaReadContext,
  solanaIndexingMetadata,
} from "../payment-identity.js";

export function agentHistoryTool() {
  return {
    name: "agent_history",
    description:
      "Read an agent's indexed AiFinPay payment history by wallet address, public passport identifier, or both. Defaults to the configured payment chain and its local wallet. Solana history requires the owner-selected cluster; arbitrary wallet transfers are excluded. Receipts include retained prepaid batches and test payments. Never pass a seed, private key or API secret as a passport.",
    inputSchema: {
      type: "object",
      additionalProperties: false,
      properties: {
        address: { type: "string" },
        passport: {
          type: "string",
          description: "Public @username, AIFP-… number or aifp_agent_… identifier",
        },
        network: {
          type: "string",
          description:
            "Exact wallet chain; defaults to the configured payment chain (Polygon when unset). Solana cluster comes from owner configuration.",
        },
        source: { type: "string", enum: ["transactions", "receipts"], default: "transactions" },
        limit: { type: "integer", minimum: 1, maximum: 100, default: 25 },
        offset: { type: "integer", minimum: 0, maximum: 100000, default: 0 },
      },
    },
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
  };
}

export async function runAgentHistory(ctx: ToolContext, args: Record<string, unknown>) {
  const base = ctx.config.baseUrl || "https://aifinpay.io";
  const source = args.source ?? "transactions",
    network = args.network ?? ctx.config.payChain ?? "polygon";
  const solana = network === "solana";
  const limit = args.limit ?? 25,
    offset = args.offset ?? 0;
  const failure = (message: string) => ({
    isError: true,
    content: [{ type: "text", text: message }],
  });
  if (
    !Number.isSafeInteger(limit) ||
    Number(limit) < 1 ||
    Number(limit) > 100 ||
    !Number.isSafeInteger(offset) ||
    Number(offset) < 0 ||
    Number(offset) > 100000
  )
    return failure("Invalid history pagination");
  if (source !== "receipts" && source !== "transactions") return failure("Unknown history source");
  async function get(path: string) {
    const response = await ctx.agent.inner.fetchImpl(apiUrl(base, path), {
      headers: { accept: "application/json" },
    });
    if (!response.ok)
      throw new Error(
        `HTTP ${response.status} from history/resolver; passport resolution requires a deployed Agent Passport backend`
      );
    return (await response.json()) as any;
  }
  try {
    if (typeof network !== "string") throw new Error("History network must be an exact chain name");
    const solanaSelection = solana ? solanaHistorySelection(ctx.config) : undefined;
    let address = args.address == null ? undefined : String(args.address);
    if (args.passport) {
      const identifier = String(args.passport).trim();
      if (!/^(@[a-z][a-z0-9_]{2,31}|AIFP-\d{1,18}|aifp_agent_[0-9a-f]{32})$/i.test(identifier)) {
        return failure("passport must be a public @username, AIFP number or aifp_agent_* id; never a secret");
      }
      const resolved = await get(`/api/agent/resolve/${encodeURIComponent(identifier)}`);
      if (resolved?.agent?.status !== "active" || !Array.isArray(resolved.agent.wallets))
        throw new Error("Passport is not active or has no verified wallets");
      const wallets = resolved.agent.wallets.filter(
        (w: any) => w.network === network && w.chain_family === (solana ? "solana" : "evm") && Number(w.verified_at) > 0
      );
      const wallet = wallets.find((w: any) => w.is_primary) || wallets[0];
      if (!wallet || typeof wallet.address !== "string")
        throw new Error("Passport has no verified wallet on the requested network");
      if (address && (solana ? address !== wallet.address : address.toLowerCase() !== wallet.address.toLowerCase()))
        throw new Error("Address does not match passport wallet");
      address = wallet.address;
    }
    address ??= solana ? ctx.agent.solanaAddress : ctx.agent.evmAddress;
    if (solana ? !isSolanaPublicKey(address) : !/^0x[0-9a-fA-F]{40}$/.test(address))
      return failure(solana ? "Expected a canonical 32-byte Solana address" : "Expected an EVM address");
    const canonicalAddress = solana ? address : address.toLowerCase();
    const query = new URLSearchParams({ limit: String(limit), offset: String(offset) });
    if (source === "transactions" || solana) query.set("chain", String(network));
    if (solanaSelection) {
      query.set("network", solanaSelection.network);
      query.set("program", solanaSelection.program);
    }
    const body = await get(`/v1/agents/${canonicalAddress}/${source}?${query}`);
    if (!Array.isArray(body?.[source])) throw new Error("Invalid history response");
    if (solanaSelection) assertSolanaReadContext(body, canonicalAddress, solanaSelection, "address");
    const fields = [
      ...(source === "receipts" ? AGENT_RECEIPT_FIELDS : AGENT_TRANSACTION_FIELDS),
      "program_id",
      "idl_sha256",
      "token_decimals",
      "asset",
      "cost_allocation",
    ];
    const items = body[source].map((row: any) => {
      if (solanaSelection)
        assertSolanaReadContext(
          row,
          canonicalAddress,
          solanaSelection,
          source === "receipts" ? "payer" : "agent_address"
        );
      if (
        solanaSelection &&
        fields.some(
          (f) =>
            row[f] !== undefined &&
            row[f] !== null &&
            (typeof row[f] === "object" ||
              !["string", "number", "boolean"].includes(typeof row[f]) ||
              (typeof row[f] === "number" && !Number.isFinite(row[f])))
        )
      )
        throw new Error("Invalid structured Solana public metadata");
      return Object.fromEntries(fields.filter((f) => row?.[f] !== undefined).map((f) => [f, row[f]]));
    });
    const indexing = solanaSelection && source === "transactions" ? solanaIndexingMetadata(body.indexing) : undefined;
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              address: canonicalAddress,
              ...(solanaSelection ? { chain: "solana", ...solanaSelection } : {}),
              ...(indexing ? { indexing } : {}),
              source,
              items,
              limit,
              offset,
              next_offset: typeof body.next_offset === "number" ? body.next_offset : null,
              coverage:
                source === "receipts"
                  ? "Retained receipts only; externally metered quotas may lag"
                  : solanaSelection
                    ? "Verified Solana settlements from retained RPC inventory only; partial history, no full archive or wallet coverage attestation; shared or unquoted transaction costs may be unavailable"
                    : "Indexed AiFinPay settlements for the requested chain and cluster; excludes arbitrary wallet transfers and may lag the chain",
            },
            null,
            2
          ),
        },
      ],
    };
  } catch (error) {
    return failure(`History lookup failed: ${(error as Error).message}`);
  }
}
