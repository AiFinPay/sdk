# @aifinpay/gate — agent guide

Merchant-side AIFP-1 paywall: 402 challenge, local receipt verification, billing-unit quota metering.

## Scope

- This package only. Do not touch `mcp/`, `mcp-http/`, `wallet/`, `node/`, `python/`.
- Entry: `src/index.ts`. Flow: `src/challenge.ts` → `src/verify.ts` → `src/core.ts` → `src/express.ts`.
- Stores in `src/stores/`; test helpers in `src/testing.ts`.

## Commands

- `npm run build` — `tsc -p tsconfig.json`
- `npm test` — `vitest run` (from `gate/`)

## Rules

- Never weaken verification: receipts verify locally via `jose`; quotas stay in billing units.
- Core (`core.ts`, `challenge.ts`, `verify.ts`) must not import express; `express` stays an optional peer dep.
- New paywall behavior needs a test in `tests/`; use `src/testing.ts`, no live network.
- Do not change the `exports` map without updating README + CHANGELOG.
