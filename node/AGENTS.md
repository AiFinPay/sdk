# @aifinpay/agent — agent guide

Agent Passport identity + route-verified AIFP-1/AIFP-2 settlement for autonomous agents.

## Scope
- This package only. Do not touch `python/`, `gate/`, `mcp/`, `mcp-http/`, `wallet/`.
- Entry: `src/index.ts`. Core: `src/unifiedAgent.ts`, `src/agent.ts`, `src/settlement*.ts`, `src/agentPassport.ts`, `src/wallet.ts`, `src/facilitators/`.

## Commands
- `npm run build` — `tsc -p tsconfig.json`
- `npm test` — `vitest run` (from `node/`)
- `npm run registry:sync` regenerates `src/splitterRoutes.generated.ts` + `src/*Deployments.generated.ts`; `registry:check` verifies freshness in CI

## Rules
- Never edit `*.generated.ts` by hand — change `registry/` inputs or `scripts/generate-splitter-routes.mjs`, then run `registry:sync`.
- Keep both exports working (`.`, `./wallet`); `PAYMENT_RECEIPTS.md` ships in `files` — update it if receipt shape changes.
- Settlement changes need tests in `tests/`; no live RPC, mock at `settlementHttp.ts` / facilitator boundaries.
- Do not weaken route verification or log secret keys.
