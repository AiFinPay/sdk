## @aifinpay/mcp-http

Streamable HTTP transport wrapper for [`@aifinpay/mcp`](../mcp). Public
URL when deployed: **`https://mcp.aifinpay.io/mcp`**, for catalogs that
require an HTTP URL (Smithery, mcp.so, LobeHub MCP) can list us.

For local Claude Desktop / Cursor / Windsurf use, stick with the stdio
[`@aifinpay/mcp`](../mcp) — lower latency, no Cloudflare hop, persistent
agent identity via env.

### Run locally

```bash
cd mcp
npm ci --no-audit --no-fund
cd ../mcp-http
npm ci --no-audit --no-fund
npm run build
PORT=3010 node server.js
```

The `file:../mcp` dependency resolves to the upstream package's compiled
`dist/` exports, not its TypeScript source. Build it before starting the shim
and after changing upstream source. `npm run build` invokes that package's
build; `npm test` does so automatically through `pretest` before exercising
the HTTP transport. This prevents stale exports from breaking the directory
profile or its `/toolspec.json` endpoint. The directory integration tests use
the real linked MCP package without calling external APIs.

```bash
# Probe the catalog descriptor
curl http://localhost:3010/

# Send an initialize over the MCP HTTP transport
curl -X POST http://localhost:3010/mcp \
  -H 'content-type: application/json' \
  -H 'accept: application/json, text/event-stream' \
  -d '{
    "jsonrpc":"2.0","id":1,"method":"initialize",
    "params":{
      "protocolVersion":"2024-11-05",
      "capabilities":{},
      "clientInfo":{"name":"curl","version":"0"}
    }
  }'
```

### Catalog submission

| Catalog | URL to submit | Status |
|---|---|---|
| Smithery | `https://mcp.aifinpay.io/mcp` | submit via `https://smithery.ai/new` (HTTP type) |
| mcp.so | `https://mcp.aifinpay.io/mcp` | submit via `https://mcp.so/submit` |
| LobeHub | `https://mcp.aifinpay.io/mcp` | submit via LobeHub MCP catalog |

Drafts live at `oracle-financial-hub-59/docs/launch/{smithery,mcp.so,lobehub-mcp}-submission.*`.

### Architecture

- Express server with `StreamableHTTPServerTransport` per session.
- Each session = own MCP server instance + own ephemeral agent identity.
  Session lifetime tied to the transport; reaped on `transport.onclose`.
- Tool handlers reused 1:1 from `@aifinpay/mcp` — same `createServer()`,
  just wired to HTTP transport instead of stdio.
- Rate-limited at 120 req/min/IP (catalog crawlers, not real agents).

### Why both stdio + HTTP?

Two transports, two audiences:

- **stdio (`@aifinpay/mcp`)** — what Claude Desktop / Cursor / Windsurf
  speak natively. One persistent agent per host, configured via env.
  Lower latency, no extra hop, runs offline.
- **HTTP (`@aifinpay/mcp-http`)** — what most MCP catalogs require so
  their crawlers can introspect the tool list without spawning a local
  process. Each session gets its own ephemeral agent.

Real production agent traffic should go through the stdio version with
a funded identity. HTTP is for discoverability + occasional one-off
calls from web-only MCP clients.

### Deployment

Deployment configuration and operational status are maintained by the service
operator. This package's local-run instructions do not establish that a hosted
endpoint is currently deployed or available.
