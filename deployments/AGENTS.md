# @aifinpay/deployments — agent guide

Canonical deployment registry grabber. Fetches the latest AIFP deployment records from upstream contract repositories and produces `registry/deployments.json`, plus ABI/IDL artifact paths for downstream SDK packages.

## Scope

- This package only (`src/`, `tests/`, `registry/`, `package.json`). Do not touch `node/`, `python/`, `mcp/`, `mcp-http/`, `wallet/`, `gate/`, `skill/`.
- Entry: `src/index.ts`. Core: `src/grabber.ts` (EVM + Solana fetch + latest-per-chain logic), `src/types.ts` (registry types), `src/build.ts` (CLI that writes `registry/deployments.json`).
- Output artifacts live in `registry/`:
  - `registry/deployments.json` — combined latest EVM + Solana records.
  - `registry/abi/` — EVM ABI bundles and Tron ABI artifacts.
  - `registry/idl/` — Solana IDL copies plus Aptos/Casper IDL artifacts.

## Commands

- `npm run build` — `tsc -p tsconfig.json`
- `npm run registry:build` — `node dist/build.js`, fetches upstream and writes `registry/deployments.json`
- `npm test` — `vitest run` (from `deployments/`)

## Rules

- Keep `IDL_DIR` and ABI paths under `registry/` so they ship with the package (`files: ["dist", "registry"]`).
- `registry/deployments.json` is a generated artifact: refresh it with `npm run registry:build`, do not hand-edit.
- Tests are offline-only; mock GitHub and fetch via the patterns already used in `tests/grabber.test.ts`.
- Bump `version` + `CHANGELOG.md` together when changing shipped files; CI checks via `scripts/check-version-bump.mjs`.
