import { AiFinPayAgent, Agent } from "@aifinpay/agent";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import type { McpConfig } from "./config.js";
import { payableFetchTool, runPayableFetch } from "./tools/payable-fetch.js";
import { agentAddressTool, runAgentAddress } from "./tools/agent-address.js";
import { agentQuoteTool, runAgentQuote } from "./tools/agent-quote.js";
import { agentCallTool, runAgentCall } from "./tools/agent-call.js";
import { agentClaimSelfTool, runAgentClaimSelf } from "./tools/agent-claim-self.js";
import { myAgentsTool, runMyAgents } from "./tools/my-agents.js";
import {
  payWithSplitTool,
  runPayWithSplit,
  quoteSplitTool,
  runQuoteSplit,
} from "./tools/pay-with-split.js";

/**
 * Build an MCP server that wraps the AiFinPay agent SDK as MCP tools.
 *
 * Returned server is unstarted — caller wires up a transport (stdio, SSE,
 * etc.) via the official `@modelcontextprotocol/sdk` package.
 *
 * As of 0.1.0-alpha.3 the wrapped identity is `AiFinPayAgent` — dual-chain
 * (Solana base58 pubkey AND Polygon EVM address from one secret). Tools
 * that previously called legacy `Agent` methods now reach them via
 * `agent.inner.*`.
 */
export async function createServer(config: McpConfig = {}) {
  const log = config.logFn ?? defaultLog;

  // Agent identity: load from env secret if provided, else generate one
  // and print to stderr so the human knows what to fund.
  const agent = config.agentSecretB58
    ? await AiFinPayAgent.fromSolanaSecret(config.agentSecretB58, {
        baseUrl:   config.baseUrl,
        timeoutMs: config.timeoutMs,
      })
    : await (async () => {
        const a = await AiFinPayAgent.new({
          baseUrl:   config.baseUrl,
          timeoutMs: config.timeoutMs,
        });
        log(
          "warn",
          `[aifinpay-mcp] no AIFINPAY_AGENT_SECRET set — generated EPHEMERAL agent.\n` +
            `  solana_address: ${a.solanaAddress}\n` +
            `  evm_address:    ${a.evmAddress}\n` +
            `  solana_secret:  ${a.inner.secretB58}\n` +
            `  >> Save the secret to AIFINPAY_AGENT_SECRET to keep the agent across restarts.`,
        );
        return a;
      })();

  // AIFINPAY_MAX_USD is the documented "hard cap on a single payment".
  // payable_fetch enforces it via PayOptions, but agent_call settles through
  // AiFinPayAgent.call() which only honours the agent's budget caps — wire
  // the cap there too, otherwise the primary tool has NO runaway protection.
  if (config.maxAmountUsd !== undefined && Number.isFinite(config.maxAmountUsd)) {
    agent.setBudget({ per_call_usd: config.maxAmountUsd });
    log("info", `[aifinpay-mcp] per-call cap: $${config.maxAmountUsd} (AIFINPAY_MAX_USD)`);
  } else {
    log(
      "warn",
      "[aifinpay-mcp] AIFINPAY_MAX_USD not set — agent_call/payable_fetch have NO per-payment cap. Strongly recommended.",
    );
  }

  log("info", `[aifinpay-mcp] solana: ${agent.solanaAddress} · evm: ${agent.evmAddress}`);

  const server = new Server(
    {
      name: "@aifinpay/mcp",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    return {
      tools: [
        agentAddressTool(),
        agentCallTool(),
        agentClaimSelfTool(),
        myAgentsTool(),
        payableFetchTool(),
        agentQuoteTool(),
        payWithSplitTool(),
        quoteSplitTool(),
      ],
    };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const ctx = { agent, config, log };
    switch (name) {
      case "agent_address":
        return runAgentAddress(ctx, args ?? {});
      case "agent_call":
        return runAgentCall(ctx, args ?? {});
      case "agent_claim_self":
        return runAgentClaimSelf(ctx, args ?? {});
      case "my_agents":
        return runMyAgents(ctx, args ?? {});
      case "payable_fetch":
        return runPayableFetch(ctx, args ?? {});
      case "agent_quote":
        return runAgentQuote(ctx, args ?? {});
      case "pay_with_split":
        return runPayWithSplit(ctx, args ?? {});
      case "quote_split":
        return runQuoteSplit(ctx, args ?? {});
      default:
        return {
          isError: true,
          content: [
            { type: "text", text: `unknown tool: ${name}` },
          ],
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
  // MCP stdio servers MUST NOT write to stdout — the transport owns it.
  // stderr is safe.
  process.stderr.write(`[${level}] ${msg}\n`);
}
