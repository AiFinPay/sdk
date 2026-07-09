#!/usr/bin/env node
/**
 * stdio entry point — run `npx @aifinpay/mcp` to start the MCP server
 * in stdio mode. Compatible with Claude Desktop, MCP Inspector, and any
 * MCP-aware agent runtime.
 *
 * Configure via env:
 *   AIFINPAY_AGENT_SECRET          base58 secret (load existing identity)
 *   AIFINPAY_BASE_URL              default https://aifinpay.io
 *   AIFINPAY_TIMEOUT_MS            default 30000
 *   AIFINPAY_MAX_USD               hard cap per single payment (no default)
 *   AIFINPAY_HEARTBEAT_INTERVAL_MS default 300000 (5 min); 0 disables
 */
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer, loadConfigFromEnv } from "../dist/index.js";

const { server, stopHeartbeat } = await createServer(loadConfigFromEnv());
const transport = new StdioServerTransport();
await server.connect(transport);

// Most MCP clients close stdin on shutdown, which the SDK's stdio
// transport already turns into server.onclose() (and thus stopHeartbeat()
// via the hook in createServer()). Some hosts instead send a signal
// without closing stdin first, so also clear the heartbeat interval there
// — belt-and-suspenders, stopHeartbeat() is idempotent.
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopHeartbeat();
    process.exit(0);
  });
}
