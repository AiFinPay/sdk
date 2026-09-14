# @aifinpay/wallet — agent guide

Light agent wallet (Solana + EVM + Casper) with 5 tiny crypto deps — no viem, no @solana/web3.js. Keystore: `~/.aifinpay/agent.json` (mode 600), shared with `@aifinpay/mcp`.

## Scope

- This package only. Do not touch `gate/`, `mcp/`, `mcp-http/`, `node/`, `python/`.
- Source is 4 files: `src/derive.ts`, `src/index.ts`, `src/cli.ts`, `scripts/check-libsecret.js`.

## Commands

- `npm run build` — `tsc -p tsconfig.json`
- `npm test` — `vitest run` (from `wallet/`)

## CLI Usage

```bash
npx @aifinpay/wallet                    # create if absent, else show (encrypted by default)
npx @aifinpay/wallet new                # create encrypted keystore (won't overwrite existing)
npx @aifinpay/wallet new --plain        # create unencrypted legacy keystore (not recommended)
npx @aifinpay/wallet show               # print addresses
npx @aifinpay/wallet export             # print the seed to back up
npx @aifinpay/wallet keyring-save       # store secret in OS keyring
npx @aifinpay/wallet keyring-load       # load secret from OS keyring to ~/.aifinpay/agent.json
npx @aifinpay/wallet keyring-delete     # BLOCKED: use 'keyring-delete-all' instead
npx @aifinpay/wallet keyring-save-passphrase   # store passphrase in OS keyring (for agents)
npx @aifinpay/wallet keyring-load-passphrase   # load passphrase from OS keyring
npx @aifinpay/wallet keyring-delete-all # remove BOTH secret and passphrase (safe cleanup)
```

**Security Policy:** `keyring-delete` is blocked to prevent agents from orphaning encrypted wallets. Only `keyring-delete-all` can remove keyring entries, and it removes both secret and passphrase together.

## Security Features

- **Encrypted by default**: New wallets use scrypt-aes-256-gcm encryption (passphrase required)
- **Passphrase in OS Keyring**: `keyring-save-passphrase` stores the passphrase separately (agents can auto-decrypt)
- **Legacy plain format**: `--plain` flag creates unencrypted keystore for backwards compatibility
- **OS Keyring integration**: `keyring-*` commands store/retrieve secrets from the OS secure storage
- **File permissions**: Keystore is mode 600, directory is mode 700

## Agent Workflow

```bash
# First-time setup (human)
npx @aifinpay/wallet new
# Enter passphrase twice when prompted
npx @aifinpay/wallet keyring-save-passphrase
# Enter the same passphrase — now stored in OS keyring

# Agent auto-decrypt (no human interaction)
npx @aifinpay/wallet show  # reads passphrase from keyring, decrypts automatically
```

**Important:** The passphrase is stored under a separate keyring account (`agent-passphrase`) from the secret (`agent-secret`). This allows:
- Agents to auto-decrypt the wallet file
- Humans to delete the passphrase (`keyring-delete-passphrase`) for extra security
- Both secret and passphrase protected by OS security (biometrics, login password)

## Prerequisites

- **Linux**: `libsecret-1-dev` (Debian/Ubuntu) or `libsecret-devel` (Red Hat) required for keyring support
- **preinstall script**: `scripts/check-libsecret.js` runs before npm install and blocks installation with helpful instructions if libsecret is missing on Linux

## Rules

- Never silently overwrite the keystore: `new` refuses if the file exists (see `src/cli.ts`); keep that guard.
- Derivation is NOT BIP-39 — never claim standard-wallet recovery works.
- Keep deps tiny (`@noble/*`, `bs58`, `tweetnacl`, `keytar`); do not add viem/web3.js. `AIFINPAY_HOME` override must keep working.
- Keystore perms stay 600 (dir 700); new key handling needs a test in `tests/`.
- Encrypted keystores require `AIFINPAY_WALLET_PASSPHRASE` in node/ and MCP.
