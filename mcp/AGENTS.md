# @aifinpay/mcp — agent guide

MCP control surface for Agent Passport resolution, runtime-verified AIFP-1/AIFP-2
settlement invoices and owner-configured payment tools. Signing tools stay gated;
do not ungate them or bypass runtime verification.

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
- Tests cover behavior and bundled skill consistency, not exact package versions
  in manifests or documentation. Keep protocol and contract version checks.


## Runtime and release evidence

Payment availability is determined by the installed deployment registry,
runtime verification and backend/merchant capabilities; client descriptors and
source tests are not production approval. Preserve explicit owner chain,
environment and budget selection, payer proof, receipt/SSRF checks and durable
recovery. Do not bypass unavailable registry/runtime checks or infer activation
from a source build. Use package manifests and lockfiles, registry inputs,
capability APIs, executor tests and CI for current evidence.
