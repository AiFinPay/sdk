## @aifinpay/mcp-http

Streamable HTTP transport wrapper for [`@aifinpay/mcp`](../mcp). Public
endpoint at **`https://mcp.aifinpay.io/mcp`** so catalogs that
require an HTTP URL (Smithery, mcp.so, LobeHub MCP) can list us.

For local Claude Desktop / Cursor / Windsurf use, stick with the stdio
[`@aifinpay/mcp`](../mcp) — lower latency, no Cloudflare hop, persistent
agent identity via env.

### Run locally

`@aifinpay/mcp` comes from this repository (`file:../mcp`), not from npm, so
build it first:

```bash
(cd mcp && npm ci --no-audit --no-fund && npm run build)
cd mcp-http
npm ci --no-audit --no-fund
PORT=3010 node server.js
```

npm 11.4.0 writes a broken symlink for a `file:` dependency when
`package.json` has `overrides` (`node_modules/@aifinpay/mcp -> ../mcp`), and
the server then fails with `Cannot find package '@aifinpay/mcp'`. npm 10.x
(Node 22) and 11.5+ are fine.

Do not publish this package to npm while the dependency is `file:../mcp`;
switch it to the published `@aifinpay/mcp` range first.

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

### Profiles

`AIFINPAY_MCP_PROFILE` picks the server; any other value refuses to start.

| Profile | Server | Auth | Production |
|---|---|---|---|
| `connector` (default) | `createServer()` — the full tool set, `payable_fetch` included | Bearer gate when `AIFINPAY_AUTH_REQUIRED=true` | `mcp-http.service`, port 3010, `https://mcp.aifinpay.io/mcp` |
| `directory` | `createDirectoryServer()` — nine read-only tools, no agent | always off, whatever `AIFINPAY_AUTH_REQUIRED` says | `mcp-http-directory.service`, port 3011, `https://mcp.aifinpay.io/directory/mcp` (OpenAI ChatGPT App Directory) |

The directory profile reads `AIFINPAY_API_BASE` (default
`https://api.aifinpay.io`).

### OAuth (connector profile)

| Variable | Meaning |
|---|---|
| `AIFINPAY_AUTH_REQUIRED` | `true` turns the Bearer gate on; a missing or bad token gets 401 + `WWW-Authenticate`. |
| `AIFINPAY_OAUTH_ISSUER` | IdP issuer; the JWKS is discovered from its OIDC metadata. |
| `MCP_RESOURCE_URL` | `resource` in `/.well-known/oauth-protected-resource`; defaults to `MCP_PUBLIC_URL`. |
| `AIFINPAY_OAUTH_AUDIENCE` | Comma list of accepted `aud` values (Stytch puts the project id there). A token passes if any of its `aud` is listed. Defaults to the resource URL. |
| `AIFINPAY_OAUTH_SCOPES` | Space list advertised as `scopes_supported`; defaults to `openid profile email offline_access`. |
| `AIFINPAY_REQUIRED_SCOPE` | Optional scope every token must carry. |

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

Deployed on the operator VM from a checkout of this repository (`mcp/` built
next to `mcp-http/`), ports 3010 (connector) and 3011 (directory), fronted by
the nginx vhost `mcp.aifinpay.io`. systemd units
`/etc/systemd/system/mcp-http.service` and `mcp-http-directory.service` (see
`docs/mcp-http-deploy.md` in the oracle repo for the runbook).
