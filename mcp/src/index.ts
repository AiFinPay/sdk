/**
 * @aifinpay/mcp — MCP server exposing AiFinPay's autonomous x402 payment
 * loop as agent-callable tools.
 *
 * Tools: public addresses, history, quotas, passport resolution, non-signing
 * settlement invoices, local wallet reload, and opt-in dev batch quoting.
 * The one signing tool, payable_fetch, is registered only when the owner
 * enables payments with every limit set.
 *
 * Quick start (stdio transport for Claude Desktop / MCP-aware runtimes):
 *
 *   $ npx @aifinpay/mcp
 *
 * Or programmatically:
 *
 *   import { createServer } from "@aifinpay/mcp";
 *   import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
 *
 *   const { server } = await createServer({ agentSecretB58: process.env.SECRET });
 *   await server.connect(new StdioServerTransport());
 */
export { createServer } from "./server.js";
export type { ToolContext } from "./server.js";
export type { McpConfig } from "./config.js";
export { loadConfigFromEnv } from "./config.js";
