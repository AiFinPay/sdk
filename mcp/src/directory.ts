/**
 * createDirectoryServer — the READ-ONLY MCP server submitted to the OpenAI
 * ChatGPT App Directory. Distinct from `createServer` (the full BYO-MCP
 * connector with payment execution): this one exposes ONLY the read-only
 * directory tools, requires NO agent identity and NO auth, and never moves
 * money — so it is reviewable under OpenAI's directory policy (Obsidian/32 /34).
 *
 * One codebase, two profiles: the HTTP wrapper picks this when
 * AIFINPAY_MCP_PROFILE=directory.
 */
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { directoryTools, runDirectoryTool, DIRECTORY_API_BASE, type DirectoryContext } from "./tools/directory.js";

export interface DirectoryServerConfig {
  /** Public API base for the wrapped GET endpoints. Defaults to production. */
  apiBase?: string;
  /** Per-request timeout (ms). */
  timeoutMs?: number;
  log?: (level: "info" | "warn" | "error", msg: string) => void;
}

// Server-wide instructions returned at initialize. ChatGPT/Codex use these as a
// cross-tool guide (OpenAI readiness checklist item; the audit found it ABSENT
// on the connector server). States the read-only contract, networks, and limits.
const DIRECTORY_INSTRUCTIONS = [
  "AiFinPay is payment infrastructure for AI agents. THIS server is the",
  "read-only directory surface: it answers questions about the AiFinPay agent",
  "economy and prices AI services — it does NOT move money, hold funds, sign",
  "transactions, or execute any payment. Every tool is read-only.",
  "",
  "Use it to: list available AI providers and their per-call prices",
  "(list_providers / provider_info / provider_status / service_coverage),",
  "preview a fee-on-top cost breakdown without paying (quote_cost), read public",
  "protocol stats (network_stats) and the on-chain agent leaderboard",
  "(leaderboard), verify an agent's AgentPassport (verify_passport), and look up",
  "a public agent profile (agent_profile).",
  "",
  "Networks: Polygon and Solana mainnet. Data is public on-chain / registry",
  "information. To actually execute a payment, an agent uses the separate",
  "AiFinPay connector or SDK — not this directory app. Requests are rate limited;",
  "on HTTP 429 (rate_limit_exceeded), back off and retry.",
].join("\n");

export async function createDirectoryServer(config: DirectoryServerConfig = {}) {
  const log = config.log ?? ((lvl, msg) => process.stderr.write(`[${lvl}] ${msg}\n`));
  const ctx: DirectoryContext = {
    apiBase: (config.apiBase || DIRECTORY_API_BASE).replace(/\/$/, ""),
    timeoutMs: config.timeoutMs ?? 15000,
    log,
  };

  const server = new Server(
    { name: "@aifinpay/mcp-directory", version: "1.0.0" },
    {
      capabilities: { tools: {} },
      instructions: DIRECTORY_INSTRUCTIONS,
    }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: directoryTools(),
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    return runDirectoryTool(ctx, name, args ?? {});
  });

  log("info", `[aifinpay-mcp-directory] read-only profile · api=${ctx.apiBase}`);
  return { server };
}
