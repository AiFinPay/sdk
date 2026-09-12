import { AiFinPayAgent } from "@aifinpay/agent";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig } from "./config.js";
import { agentAddressTool, runAgentAddress } from "./tools/agent-address.js";
import { agentQuotaTool, runAgentQuota } from "./tools/agent-quota.js";
import { makeSafeFetch } from "./safe-fetch.js";
import { loadConfigFromEnv } from "./config.js";
import {
  agentPassportResolveTool,
  runAgentPassportResolve,
  settlementRoutesTool,
  runSettlementRoutes,
  settlementInvoiceTool,
  runSettlementInvoice,
} from "./tools/production-control.js";

// Every backend/public request made by this server goes through safeFetch.
// Public deployments never lift private-network protection; local development
// may explicitly use AIFINPAY_ALLOW_PRIVATE_FETCH=1.
const safeFetch = makeSafeFetch({
  allowPrivate: process.env.AIFINPAY_ALLOW_PRIVATE_FETCH === "1",
  // Exact hosts an operator vouches for. Skips only the DNS pre-check, and only
  // for those names — see safe-fetch.ts for why this is not a proxy switch.
  trustedHosts: loadConfigFromEnv().trustedHosts,
});

/**
 * Production-RC MCP surface.
 *
 * IMPORTANT: the old agent_call, payable_fetch, pay_with_split, quote_split,
 * agent_claim_self and agent_quote tools are deliberately NOT registered.
 * They depend on @aifinpay/agent 1.x legacy splitter/x402 semantics and must not
 * be available to a model after the 0% AIFP-2 / gross-inclusive AIFP-1 change.
 *
 * This server remains useful before the SDK 2.0 package is published: it can
 * expose the wallet address, resolve Agent Passport identity, read verified
 * v1.3 routes, and construct a non-signing settlement invoice. Signing/moving
 * value returns only after MCP depends on the published v2 executor and its E2E
 * release gate has passed.
 */
export async function createServer(config: McpConfig = {}) {
  const log = config.logFn ?? defaultLog;

  const agent = config.agentSecretB58
    ? await AiFinPayAgent.fromSolanaSecret(config.agentSecretB58, {
        fetchImpl: safeFetch,
        baseUrl: config.baseUrl,
        timeoutMs: config.timeoutMs,
      })
    : await (async () => {
        const a = await AiFinPayAgent.new({
          fetchImpl: safeFetch,
          baseUrl: config.baseUrl,
          timeoutMs: config.timeoutMs,
        });
        log(
          "warn",
          `[aifinpay-mcp] no AIFINPAY_AGENT_SECRET set — generated an EPHEMERAL, NON-RECOVERABLE agent.\n` +
            `  solana_address: ${a.solanaAddress}\n` +
            `  evm_address:    ${a.evmAddress}\n` +
            `  >> DO NOT FUND these addresses. This identity is lost when the process exits.\n` +
            `  >> For a persistent wallet, create one from a seed you back up\n` +
            `     (AiFinPayAgent.fromSeed / \`aifinpay init\`) and set AIFINPAY_AGENT_SECRET.`,
        );
        return a;
      })();

  // Keep the legacy agent budget configured even though this RC exposes no
  // signing tool. It remains an additional defence for downstream/private code
  // and for the subsequent v2 MCP executor integration.
  if (config.maxAmountUsd !== undefined && Number.isFinite(config.maxAmountUsd)) {
    agent.setBudget({ per_call_usd: config.maxAmountUsd });
    log("info", `[aifinpay-mcp] per-call cap: $${config.maxAmountUsd} (AIFINPAY_MAX_USD)`);
  }

  log(
    "info",
    `[aifinpay-mcp] production RC safe surface · solana: ${agent.solanaAddress} · evm: ${agent.evmAddress}`,
  );

  const server = new Server(
    {
      name: "@aifinpay/mcp",
      version: "2.0.0-rc.1",
    },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      agentAddressTool(),
      agentQuotaTool(),
      agentPassportResolveTool(),
      settlementRoutesTool(),
      settlementInvoiceTool(),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const ctx = { agent, config, log };
    switch (name) {
      case "agent_address":
        return runAgentAddress(ctx, args ?? {});
      case "agent_quota":
        return runAgentQuota(ctx, args ?? {});
      case "agent_passport_resolve":
        return runAgentPassportResolve(ctx, args ?? {});
      case "settlement_routes":
        return runSettlementRoutes(ctx, args ?? {});
      case "settlement_invoice":
        return runSettlementInvoice(ctx, args ?? {});
      default:
        return {
          isError: true,
          content: [{ type: "text", text: `unknown or retired tool: ${name}` }],
        };
    }
  });

  return { server, agent };
}

export interface ToolContext {
  agent: AiFinPayAgent;
  config: McpConfig;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}

function defaultLog(level: "info" | "warn" | "error", msg: string) {
  process.stderr.write(`[${level}] ${msg}\n`);
}
