# @aifinpay/wallet — agent guide

Light agent wallet (Solana + EVM + Casper) with 5 tiny crypto deps — no viem, no @solana/web3.js. Keystore: `~/.aifinpay/agent.json` (mode 600), shared with `@aifinpay/mcp`.

## Scope

- This package only. Do not touch `gate/`, `mcp/`, `mcp-http/`, `node/`, `python/`.
- Source is 3 files: `src/derive.ts`, `src/index.ts`, `src/cli.ts`.

## Commands

- `npm run build` — `tsc -p tsconfig.json`
- `npm test` — `vitest run` (from `wallet/`)

## CLI Usage

```bash
npx @aifinpay/wallet                    # create if absent, else show
npx @aifinpay/wallet new                # create (won't overwrite existing)
npx @aifinpay/wallet new --encrypt      # create encrypted keystore (prompts for passphrase)
npx @aifinpay/wallet show               # print addresses
npx @aifinpay/wallet export             # print the seed to back up
npx @aifinpay/wallet keyring-save       # store secret in OS keyring (macOS Keychain, Windows Credential Manager, libsecret)
npx @aifinpay/wallet keyring-load       # load secret from OS keyring to ~/.aifinpay/agent.json
npx @aifinpay/wallet keyring-delete     # remove secret from OS keyring
```

## Security Features

- **Encrypted keystore**: `--encrypt` flag creates a scrypt-aes-256-gcm encrypted keystore
- **OS Keyring integration**: `keyring-*` commands store/retrieve secrets from the OS secure storage
- **File permissions**: Keystore is mode 600, directory is mode 700

## Rules

- Never silently overwrite the keystore: `new` refuses if the file exists (see `src/cli.ts`); keep that guard.
- Derivation is NOT BIP-39 — never claim standard-wallet recovery works.
- Keep deps tiny (`@noble/*`, `bs58`, `tweetnacl`, `keytar`); do not add viem/web3.js. `AIFINPAY_HOME` override must keep working.
- Keystore perms stay 600 (dir 700); new key handling needs a test in `tests/`.
- Encrypted keystores require `AIFINPAY_WALLET_PASSPHRASE` in node/ and MCP.
