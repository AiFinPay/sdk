# @aifinpay/wallet — agent guide

Light agent wallet (Solana + EVM + Casper) with 4 tiny crypto deps — no viem, no @solana/web3.js. Keystore: `~/.aifinpay/agent.json` (mode 600), shared with `@aifinpay/mcp`.

## Scope

- This package only. Do not touch `gate/`, `mcp/`, `mcp-http/`, `node/`, `python/`.
- Source is 3 files: `src/derive.ts`, `src/index.ts`, `src/cli.ts` (`npx @aifinpay/wallet [new|show|export]`).

## Commands

- `npm run build` — `tsc -p tsconfig.json`
- `npm test` — `vitest run` (from `wallet/`)

## Rules

- Never silently overwrite the keystore: `new` refuses if the file exists (see `src/cli.ts`); keep that guard.
- Derivation is NOT BIP-39 — never claim standard-wallet recovery works.
- Keep deps tiny (`@noble/*`, `bs58`, `tweetnacl`); do not add viem/web3.js. `AIFINPAY_HOME` override must keep working.
- Keystore perms stay 600 (dir 700); new key handling needs a test in `tests/`.
