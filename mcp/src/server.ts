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
import { loadConfigFromEnv, validatePaymentConfig } from "./config.js";
import { PaymentStateStore } from "./payment-state.js";
import { payableFetchTool, runPayableFetch } from "./tools/payable-fetch.js";
import {
  agentPassportResolveTool,
  runAgentPassportResolve,
  settlementRoutesTool,
  runSettlementRoutes,
  settlementInvoiceTool,
  runSettlementInvoice,
  settlementSolanaTool,
  runSettlementSolana,
  settlementCasperTool,
  runSettlementCasper,
} from "./tools/production-control.js";
import { deploymentInfoTool, runDeploymentInfo } from "./tools/supported-chains.js";

// Every backend/public request made by this server goes through safeFetch.
// Public deployments never lift private-network protection; local development
// may explicitly use AIFINPAY_ALLOW_PRIVATE_FETCH=1.
const safeFetch = makeSafeFetch({
  allowPrivate: process.env.AIFINPAY_ALLOW_PRIVATE_FETCH === "1",
  // Exact hosts an operator vouches for. Skips only the DNS pre-check, and only
  // for those names — see safe-fetch.ts for why this is not a proxy switch.
  trustedHosts: loadConfigFromEnv().trustedHosts,
});

/** Read-only by default. Explicit owner configuration enables the reviewed
 * native Polygon v1.4 payable_fetch path; legacy signing tools stay retired. */
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
  let agent =
    configured?.loaded ??
    (await AiFinPayAgent.new({
      fetchImpl: safeFetch,
      baseUrl: config.baseUrl,
      timeoutMs: config.timeoutMs,
    }));
  identitySource = configured?.source ?? "ephemeral";
  if (!configured)
    log(
      "warn",
      "[aifinpay-mcp] EPHEMERAL wallet — DO NOT FUND. Run `npx @aifinpay/mcp init`, then agent_reload in this connection."
    );
  let paymentState: PaymentStateStore | undefined;
  if (config.paymentsEnabled) {
    validatePaymentConfig(config);
    if (!configured) throw new Error("Payments require a persistent configured wallet; run init first");
    paymentState = new PaymentStateStore(agent.evmAddress, config.walletHome);
  }
  // Keep the legacy agent budget configured even though this RC exposes no
  // signing tool. It remains an additional defence for downstream/private code
  // and for the subsequent v2 MCP executor integration.
  if (config.maxAmountUsd !== undefined && Number.isFinite(config.maxAmountUsd)) {
    agent.setBudget({ per_call_usd: config.maxAmountUsd });
    log("info", `[aifinpay-mcp] per-call cap: $${config.maxAmountUsd} (AIFINPAY_MAX_USD)`);
  }

  log("info", `[aifinpay-mcp] production RC safe surface · solana: ${agent.solanaAddress} · evm: ${agent.evmAddress}`);

  const server = new Server(
    {
      name: "@aifinpay/mcp",
      version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
    },
    { capabilities: { tools: {}, resources: {} } }
  );

  server.setRequestHandler(ListResourcesRequestSchema, async () => ({
    resources: [
      {
        uri: "aifinpay://skill",
        name: "AiFinPay skill",
        mimeType: "text/markdown",
        description: "Wallet source priority, payment history routes, reconnect behavior and dev testing limits",
      },
    ],
  }));
  server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
    if (request.params.uri !== "aifinpay://skill") throw new Error("Unknown resource");
    return {
      contents: [
        {
          uri: "aifinpay://skill",
          mimeType: "text/markdown",
          text: readFileSync(new URL("../skills/SKILL.md", import.meta.url), "utf8"),
        },
      ],
    };
  });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      agentAddressTool(),
      {
        name: "agent_reload",
        description:
          "Reload the configured local wallet files after init or a file update, without starting a new conversation. Returns public addresses only. Shell environment changes still require reconnecting the MCP process.",
        inputSchema: { type: "object", properties: {}, additionalProperties: false },
        annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
      },
      ...(paymentState ? [payableFetchTool()] : []),
      agentQuotaTool(),
      agentHistoryTool(),
      ...(config.devMode ? [devPaymentQuoteTool()] : []),
      agentPassportResolveTool(),
      settlementRoutesTool(),
      settlementInvoiceTool(),
      settlementSolanaTool(),
      settlementCasperTool(),
      deploymentInfoTool(),
    ],
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const ctx = { agent, config, log, paymentState };
    switch (name) {
      case "agent_reload":
        try {
          const replacement = await configuredAgent();
          if (!replacement)
            throw new Error("No persistent wallet configured; run init or configure the project wallet first");
          if (config.maxAmountUsd !== undefined && Number.isFinite(config.maxAmountUsd)) {
            replacement.loaded.setBudget({ per_call_usd: config.maxAmountUsd });
          }
          if (paymentState && replacement.loaded.evmAddress.toLowerCase() !== agent.evmAddress.toLowerCase()) {
            throw new Error(
              "Reconnect to switch payment wallets; pending state must remain associated with its original wallet"
            );
          }
          agent = replacement.loaded;
          identitySource = replacement.source;
          return {
            content: [
              {
                type: "text",
                text: JSON.stringify({
                  source: identitySource,
                  solana: agent.solanaAddress,
                  evm: agent.evmAddress,
                  casper: agent.casperAddress,
                  reloaded: true,
                }),
              },
            ],
          };
        } catch (error) {
          return {
            isError: true,
            content: [{ type: "text", text: `Wallet reload failed: ${(error as Error).message}` }],
          };
        }
      case "payable_fetch":
        return runPayableFetch(ctx, args ?? {});
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
      case "settlement_solana":
        return runSettlementSolana(ctx, args ?? {});
      case "settlement_casper":
        return runSettlementCasper(ctx, args ?? {});
      case "deployment_info":
        return runDeploymentInfo(ctx, args ?? {});
      default:
        return {
          isError: true,
          content: [{ type: "text", text: `unknown or retired tool: ${name}` }],
        };
    }
  });

  return {
    server,
    get agent() {
      return agent;
    },
  };
}

export interface ToolContext {
  agent: AiFinPayAgent;
  config: McpConfig;
  paymentState?: PaymentStateStore;
  log: (level: "info" | "warn" | "error", msg: string) => void;
}

function defaultLog(level: "info" | "warn" | "error", msg: string) {
  process.stderr.write(`[${level}] ${msg}\n`);
}
