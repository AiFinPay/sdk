# @aifinpay/mcp-http — agent guide

HTTP/Streamable transport wrapper around `@aifinpay/mcp` for `https://mcp.aifinpay.io/mcp` (catalog listings that require a public URL).

## Scope
- This package only: `server.js`. Upstream logic lives in `mcp/` — fix it there, not here.
- Do not touch `gate/`, `wallet/`, `node/`, `python/`.

## Commands
- Install the linked upstream package first: `npm ci --no-audit --no-fund` in
  `mcp/`, then the same command in this directory. Each lockfile owns its
  package's dependencies.
- `npm run build` — build the linked `../mcp` package, including its bundled skill.
- `npm test` — rebuild that upstream package via `pretest`, then run the HTTP
  transport tests against its compiled exports.
- `npm start` — `node server.js` (Node >= 22); run the build first.

## Rules
- Preserve rate limiting (`express-rate-limit`) and `ws` / `fast-uri` / `ip-address` overrides (security pins).
- Do not add auth bypasses or log secrets; this is a thin transport shim, keep it thin.
