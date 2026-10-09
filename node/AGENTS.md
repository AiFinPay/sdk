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

## FULL-PAYMENT-FLOW-20261004 source state

The user authorized coordinated Node/Python/MCP work on the existing v1.4 kernel.
Nine EVM client descriptors do not establish production readiness or activate
networks. Generated deployment pins, flags, profiles and economics are unchanged.
Stable token units are independent chain/address-pinned6/18 decimals and additive
quote metadata is validated. Preserve explicit owner chain, budgets, runtime,
payer proof, receipt/SSRF and durable recovery controls. MCP2.6.0 requires
agent2.4.0 source-pack integration, then published dependency/lock refresh before
standalone release. No publish/merge/contract operations are authorized by this note.

## SOLANA-INTEGRATION-20261005 source state

Node 2.5.0 adds the explicitly owner-selected `solanaV14` family option;
`v14` and `solanaV14` together refuse. Network/environment, independent price and
integer fee plus rent cap are required. Real deployment records stay disabled.
Preserve exact pinned IDL, signed quote, fresh account/signer/profile/token evidence,
same-signature bytes, shared wallet cap and canonical finalized-failure proof.
Unknown outcomes never expire or authorize replacement. Historical recovery and
public history preserve case and bind the independently selected cluster/program.
MCP 2.7/skill 2.8 are a new source cohort; the old EVM release branch remains intact.
