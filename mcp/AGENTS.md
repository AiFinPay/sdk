# @aifinpay/mcp — agent guide

MCP production-RC control surface: Agent Passport resolution + runtime-verified AIFP-1/AIFP-2 settlement invoices. Signing tools stay gated until @aifinpay/agent v2.

## Scope
- This package only. Do not touch `gate/`, `mcp-http/`, `wallet/`, `node/`, `python/`.
- Entry: `src/index.ts`; server wiring in `src/server.ts`; tools in `src/tools/`; config in `src/config.ts`; keystore read in `src/identity.ts`.

## Commands
- `npm run build` — `tsc -p tsconfig.json`
- `npm test` — `vitest run` (from `mcp/`)
- Run locally: `npx @aifinpay/mcp` (reads `~/.aifinpay/agent.json`, created by `@aifinpay/wallet`)

## Rules
- Do not ungate signing tools or bypass runtime verification in `src/tools/` / `src/api.ts`.
- No new runtime deps without justification; keep stdio transport working (`bin/aifinpay-mcp.js`).
- `skills/` ships in the published files — keep it in sync if tools change.
- Tests go in `tests/`; no live network, mock via `src/safe-fetch.ts` patterns.
