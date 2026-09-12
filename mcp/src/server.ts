import { AiFinPayAgent } from "@aifinpay/agent";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  ListResourcesRequestSchema,
  ReadResourceRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { readFileSync } from "node:fs";
import type { McpConfig } from "./config.js";
import { loadWalletIdentity } from "./identity.js";
import { agentHistoryTool, runAgentHistory } from "./tools/agent-history.js";
import { devPaymentQuoteTool, runDevPaymentQuote } from "./tools/dev-payment-quote.js";
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

  let identitySource = "ephemeral";
  async function configuredAgent() {
    const identity = loadWalletIdentity(config);
    if (!identity) return null;
    const options = { fetchImpl: safeFetch, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs };
    const loaded = identity.seedHash
      ? await AiFinPayAgent.fromSeed(identity.seedHash, options)
      : await AiFinPayAgent.fromSolanaSecret(identity.secretB58!, options);
    return { loaded, source: identity.source };
  }
  const configured = await configuredAgent();
  let agent = configured?.loaded ?? await AiFinPayAgent.new({
    fetchImpl: safeFetch, baseUrl: config.baseUrl, timeoutMs: config.timeoutMs,
  });
  identitySource = configured?.source ?? "ephemeral";
  if (!configured) log("warn", "[aifinpay-mcp] EPHEMERAL wallet — DO NOT FUND. Run `npx @aifinpay/mcp init`, then agent_reload in this connection.");
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
      version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    },
    { capabilities: { tools: {}, resources: {} } },
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({ resources: [{
    uri: "aifinpay://skill", name: "AiFinPay skill", mimeType: "text/markdown",
    description: "Wallet source priority, payment history routes, reconnect behavior and dev testing limits",
  }] }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== "aifinpay://skill") throw new Error("Unknown resource");
    return { contents: [{ uri: "aifinpay://skill", mimeType: "text/markdown",
      text: readFileSync(new URL("../skills/SKILL.md", import.meta.url), "utf8") }] };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      agentAddressTool(),
      {
        name: "agent_reload",
        description: "Reload the configured local wallet files after init or a file update, without starting a new conversation. Returns public addresses only. Shell environment changes still require reconnecting the MCP process.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      agentQuotaTool(),
      agentHistoryTool(),
      ...(config.devMode ? [devPaymentQuoteTool()] : []),
      agentPassportResolveTool(),
      settlementRoutesTool(),
      settlementInvoiceTool(),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const ctx = { agent, config, log };
    switch (name) {
      case "agent_reload":
        try {
          const replacement = await configuredAgent();
          if (!replacement) throw new Error("No persistent wallet configured; run init or configure the project wallet first");
          if (config.maxAmountUsd !== undefined && Number.isFinite(config.maxAmountUsd)) {
            replacement.loaded.setBudget({ per_call_usd: config.maxAmountUsd });
          }
          agent = replacement.loaded;
          identitySource = replacement.source;
          return { content: [{ type: "text", text: JSON.stringify({
            source: identitySource, solana: agent.solanaAddress, evm: agent.evmAddress,
            casper: agent.casperAddress, reloaded: true,
          }) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: `Wallet reload failed: ${(error as Error).message}` }] };
        }
      case "agent_reload":
        try {
          const replacement = await configuredAgent();
          if (!replacement) throw new Error("No persistent wallet configured; run init or configure the project wallet first");
          if (config.maxAmountUsd !== undefined && Number.isFinite(config.maxAmountUsd)) {
            replacement.loaded.setBudget({ per_call_usd: config.maxAmountUsd });
          }
          agent = replacement.loaded;
          return { content: [{ type: "text", text: JSON.stringify({
            source: replacement.source, solana: agent.solanaAddress, evm: agent.evmAddress,
            casper: agent.casperAddress, reloaded: true,
          }) }] };
        } catch (error) {
          return { isError: true, content: [{ type: "text", text: `Wallet reload failed: ${(error as Error).message}` }] };
        }
      case "agent_address":
        return runAgentAddress(ctx, args ?? {});
      case "agent_quota":
        return runAgentQuota(ctx, args ?? {});
      case "agent_history":
        return runAgentHistory(ctx, args ?? {});
      case "dev_payment_quote":
        return runDevPaymentQuote(ctx, args ?? {});
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

  return { server, get agent() { return agent; } };
}

export interface ToolContext {
  agent: AiFinPayAgent;
  config: McpConfig;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}

function defaultLog(level: "info" | "warn" | "error", msg: string) {
  process.stderr.write(`[${level}] ${msg}\n`);
}
