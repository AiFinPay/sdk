# @aifinpay/mcp-http — agent guide

HTTP/Streamable transport wrapper around `@aifinpay/mcp` for `https://mcp.aifinpay.io/mcp` (catalog listings that require a public URL).

## Scope
- This package only: `server.js`. Upstream logic lives in `mcp/` — fix it there, not here.
- Do not touch `gate/`, `wallet/`, `node/`, `python/`.

## Commands
- `npm start` — `node server.js` (Node >= 20)

## Rules
- Preserve rate limiting (`express-rate-limit`) and `ws` / `fast-uri` / `ip-address` overrides (security pins).
- Do not add auth bypasses or log secrets; this is a thin transport shim, keep it thin.
