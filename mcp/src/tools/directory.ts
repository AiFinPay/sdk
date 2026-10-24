/**
 * Directory tools — the READ-ONLY surface submitted to the OpenAI ChatGPT App
 * Directory. Every tool here is a thin wrapper over a public `api.aifinpay.io`
 * GET endpoint: no agent identity, no keys, no money movement, no auth. This is
 * what makes the directory app reviewable (OpenAI prohibits payment/crypto
 * EXECUTION in directory apps — see Obsidian/32). Execution tools live only on
 * the full BYO-MCP connector (`server.ts`), never here.
 *
 * Each tool declares `readOnlyHint: true`, an `outputSchema`, and ALWAYS returns
 * `structuredContent` matching it (the audit found 4 connector tools that declare
 * outputSchema but return only text — Apps SDK validation may reject that; we
 * don't repeat it).
 */

/** Public API base. Defaults to production; override with AIFINPAY_API_BASE. */
export const DIRECTORY_API_BASE = (process.env.AIFINPAY_API_BASE || "https://api.aifinpay.io").replace(/\/$/, "");

export interface DirectoryContext {
  apiBase: string;
  timeoutMs: number;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  // structuredContent must be an object; wrap bare arrays/primitives.
  const structured =
    data && typeof data === "object" && !Array.isArray(data) ? (data as Record<string, unknown>) : { result: data };
  return {
    content: [{ type: "text", text: JSON.stringify(data, null, 2) }],
    structuredContent: structured,
  };
}

function fail(msg: string): ToolResult {
  return { isError: true, content: [{ type: "text", text: msg }] };
}

async function apiGet(ctx: DirectoryContext, path: string): Promise<ToolResult> {
  const url = `${ctx.apiBase}${path}`;
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ctx.timeoutMs);
  try {
    const resp = await fetch(url, {
      headers: { accept: "application/json" },
      signal: ctrl.signal,
    });
    if (!resp.ok) {
      return fail(`upstream ${resp.status} for ${path}`);
    }
    const data = await resp.json();
    return ok(data);
  } catch (e) {
    return fail(`request failed for ${path}: ${(e as Error).message}`);
  } finally {
    clearTimeout(t);
  }
}

const RO = { readOnlyHint: true, openWorldHint: false, destructiveHint: false };

// ── Tool definitions ───────────────────────────────────────────────────────

export function directoryTools() {
  return [
    {
      name: "list_providers",
      description:
        "List the AI services available through AiFinPay (e.g. web search, " +
        "image generation, LLM inference) with their per-call price and " +
        "supported networks. Read-only; returns the public provider catalog.",
      inputSchema: { type: "object", properties: {} },
      annotations: RO,
      // Permissive: the upstream provider catalog is the source of truth and its
      // leaf field types vary (e.g. price_usd may be a number or a string for
      // range/tier pricing). The MCP client validates structuredContent against
      // this schema strictly, so we only assert the top-level shape.
      outputSchema: {
        type: "object",
        properties: {
          providers: { type: "array", items: { type: "object" } },
        },
      },
    },
    {
      name: "provider_info",
      description:
        "Get the details of one AiFinPay provider by name (price, supported " +
        "networks, service type, homepage). Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          name: {
            type: "string",
            description: "Provider name, e.g. 'exa', 'venice', 'io-net'.",
          },
        },
        required: ["name"],
      },
      annotations: RO,
      outputSchema: { type: "object" },
    },
    {
      name: "provider_status",
      description:
        "Report which AiFinPay provider bridges are currently reachable " + "(up/down). Read-only health view.",
      inputSchema: { type: "object", properties: {} },
      annotations: RO,
      outputSchema: { type: "object" },
    },
    {
      name: "service_coverage",
      description:
        "Show which categories of AI service (search, compute, …) AiFinPay " +
        "currently covers and the providers in each. Read-only.",
      inputSchema: { type: "object", properties: {} },
      annotations: RO,
      outputSchema: {
        type: "object",
        properties: {
          covered: { type: "array", items: { type: "object" } },
        },
      },
    },
    {
      name: "network_stats",
      description:
        "Return public protocol statistics: supported networks, number of " +
        "active agents, total settled volume, and active providers. Read-only.",
      inputSchema: { type: "object", properties: {} },
      annotations: RO,
      outputSchema: { type: "object" },
    },
    {
      name: "leaderboard",
      description:
        "Return the public on-chain leaderboard of AiFinPay agents ranked by " + "settled volume. Read-only.",
      inputSchema: { type: "object", properties: {} },
      annotations: RO,
      outputSchema: {
        type: "object",
        properties: {
          total_seats: { type: "number" },
          leaderboard: { type: "array", items: { type: "object" } },
        },
      },
    },
    {
      name: "quote_cost",
      description:
        "Preview the fee-on-top breakdown (merchant amount + protocol fee + " +
        "creator fee + total) for a given price, WITHOUT making any payment. " +
        "Read-only price calculator.",
      inputSchema: {
        type: "object",
        properties: {
          chain: { type: "string", enum: ["solana", "polygon"] },
          amount: {
            type: "string",
            description:
              "Merchant's quoted price in base units: lamports (Solana SOL), " +
              "wei (Polygon POL), or 6-decimal units (Polygon USDC/USDT).",
          },
          asset: {
            type: "string",
            enum: ["SOL", "POL", "USDC", "USDT"],
            description:
              "Settlement asset. Defaults to SOL on Solana, POL on Polygon. " +
              "Use USDC/USDT for Polygon stablecoin quotes.",
          },
        },
        required: ["chain", "amount"],
      },
      annotations: RO,
      outputSchema: { type: "object" },
    },
    {
      name: "verify_passport",
      description:
        "Check whether an agent public key holds an AiFinPay AgentPassport and " +
        "return its on-chain status. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          pubkey: {
            type: "string",
            description: "Agent public key (Solana base58 or EVM address).",
          },
        },
        required: ["pubkey"],
      },
      annotations: RO,
      outputSchema: { type: "object" },
    },
    {
      name: "agent_profile",
      description:
        "Return the public profile and activity summary for an AiFinPay agent " + "by its address. Read-only.",
      inputSchema: {
        type: "object",
        properties: {
          address: {
            type: "string",
            description: "Agent address (EVM 0x… or Solana base58).",
          },
        },
        required: ["address"],
      },
      annotations: RO,
      outputSchema: { type: "object" },
    },
  ];
}

// ── Dispatch ────────────────────────────────────────────────────────────────

export async function runDirectoryTool(
  ctx: DirectoryContext,
  name: string,
  args: Record<string, unknown>
): Promise<ToolResult> {
  switch (name) {
    case "list_providers":
      return apiGet(ctx, "/providers");
    case "provider_info": {
      const n = String(args.name ?? "").trim();
      if (!n) return fail("missing required arg: name");
      return apiGet(ctx, `/providers/${encodeURIComponent(n)}`);
    }
    case "provider_status":
      return apiGet(ctx, "/providers/status");
    case "service_coverage":
      return apiGet(ctx, "/registry/coverage");
    case "network_stats":
      return apiGet(ctx, "/network-stats");
    case "leaderboard":
      return apiGet(ctx, "/leaderboard");
    case "quote_cost": {
      const chain = String(args.chain ?? "")
        .trim()
        .toLowerCase();
      const amount = String(args.amount ?? "").trim();
      const asset = String(args.asset ?? "")
        .trim()
        .toUpperCase();
      if (!chain || !amount) return fail("missing required args: chain, amount");
      const qs = new URLSearchParams();
      if (chain === "solana") {
        qs.set("merchant_amount_lamports", amount);
      } else if (chain === "polygon") {
        if (asset === "USDC" || asset === "USDT") {
          qs.set("merchant_amount_units", amount);
          qs.set("asset", asset);
        } else {
          qs.set("merchant_amount_wei", amount);
        }
      } else {
        return fail("chain must be 'solana' or 'polygon'");
      }
      return apiGet(ctx, `/b2b/quote-split?${qs.toString()}`);
    }
    case "verify_passport": {
      const pk = String(args.pubkey ?? "").trim();
      if (!pk) return fail("missing required arg: pubkey");
      return apiGet(ctx, `/passport/${encodeURIComponent(pk)}`);
    }
    case "agent_profile": {
      const addr = String(args.address ?? "").trim();
      if (!addr) return fail("missing required arg: address");
      return apiGet(ctx, `/network/agents/${encodeURIComponent(addr)}`);
    }
    default:
      return fail(`unknown directory tool: ${name}`);
  }
}
