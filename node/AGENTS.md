# @aifinpay/agent — agent guide

Agent Passport identity + route-verified AIFP-1/AIFP-2 settlement for autonomous agents.

## Scope

- This package only. Do not touch `python/`, `gate/`, `mcp/`, `mcp-http/`, `wallet/`.
- Entry: `src/index.ts`. Core: `src/unifiedAgent.ts`, `src/agent.ts`, `src/settlement*.ts`, `src/agentPassport.ts`, `src/wallet.ts`, `src/facilitators/`.

## Commands

- `npm run build` — clears only this package's generated `dist/`, then runs `tsc -p tsconfig.json`; retired output must never enter a package.
- `npm test` — `vitest run` (from `node/`)
- `npm run registry:sync` regenerates `src/generated/splitterRoutes.generated.ts` and `src/generated/v14Deployments.generated.ts`/`src/generated/solanaV14Deployments.generated.ts` from the installed `@aifinpay/deployments` package; `npm run registry:check` verifies both in CI

## Rules

- Never edit `generated/*.ts` by hand — change the `@aifinpay/deployments` registry inputs or `scripts/generate-*.mjs`, then run the matching `registry:sync`.
- Keep both exports working (`.`, `./wallet`); `PAYMENT_RECEIPTS.md` ships in `files` — update it if receipt shape changes.
- Settlement changes need tests in `tests/`; no live RPC, mock at `settlementHttp.ts` / facilitator boundaries.
- Do not weaken route verification or log secret keys.

## Runtime and release evidence

Client descriptors and source tests are not production approval. Payment
availability is determined by the installed deployment registry, runtime
verification and backend/merchant capabilities. Preserve explicit owner chain,
environment and budget selection, payer proof, receipt/SSRF checks and durable
recovery. Never bypass an unavailable registry/runtime check or infer activation
from a source build; use package manifests and lockfiles, registry inputs,
capability APIs, executor tests and CI for current evidence.
