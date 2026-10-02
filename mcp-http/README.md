## @aifinpay/mcp-http

Streamable HTTP transport wrapper for [`@aifinpay/mcp`](../mcp). Public
endpoint at **`https://mcp.aifinpay.io/mcp`** so catalogs that
require an HTTP URL (Smithery, mcp.so, LobeHub MCP) can list us.

For local Claude Desktop / Cursor / Windsurf use, stick with the stdio
[`@aifinpay/mcp`](../mcp) — lower latency, no Cloudflare hop, persistent
agent identity via env.

### Run locally

```bash
cd mcp-http
npm ci --no-audit --no-fund
PORT=3010 node server.js
```

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

### Production

Deployed on the operator VPS at port 3010, fronted by nginx vhost
`mcp.aifinpay.io`. systemd unit at
`/etc/systemd/system/mcp-http.service` (see
`docs/mcp-http-deploy.md` in the oracle repo for the runbook).
