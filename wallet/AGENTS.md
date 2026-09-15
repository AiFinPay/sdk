# @aifinpay/wallet — agent guide

Light agent wallet (Solana + EVM + Casper) with 4 tiny crypto deps — no viem, no @solana/web3.js. Keystore: `~/.aifinpay/agent.json` (mode 600), shared with `@aifinpay/mcp`.

## Scope

- This package only. Do not touch `gate/`, `mcp/`, `mcp-http/`, `node/`, `python/`.
- Source is 4 files: `src/derive.ts`, `src/index.ts`, `src/cli.ts`, `scripts/check-libsecret.js`.

## Commands

- `npm run build` — `tsc -p tsconfig.json`
- `npm test` — `vitest run` (from `wallet/`)

## CLI Usage

```bash
npx @aifinpay/wallet              # create if absent, else show (encrypted by default)
npx @aifinpay/wallet new          # create encrypted keystore (won't overwrite existing)
npx @aifinpay/wallet new --plain  # create unencrypted legacy keystore (not recommended)
npx @aifinpay/wallet new --legacy-solana  # create wallet with legacy Solana derivation (not recommended)
npx @aifinpay/wallet show         # print addresses
npx @aifinpay/wallet export       # print the seed to back up
```

## Security Features

- **Encrypted by default**: New wallets use scrypt-aes-256-gcm encryption (passphrase required)
- **Legacy plain format**: `--plain` flag creates unencrypted keystore for backwards compatibility
- **Legacy Solana derivation**: `--legacy-solana` flag creates wallet with raw seed Solana derivation (not recommended for new wallets)
- **File permissions**: Keystore is mode 600, directory is mode 700
- **Environment variable**: `AIFINPAY_WALLET_PASSPHRASE` for non-interactive mode

## Agent Workflow

```bash
# First-time setup (human)
export AIFINPAY_WALLET_PASSPHRASE="your-secure-passphrase"
npx @aifinpay/wallet new

# Agent auto-decrypt (no human interaction)
export AIFINPAY_WALLET_PASSPHRASE=$(cat ~/.aifinpay/secrets/passphrase)
npx @aifinpay/wallet show

# Create wallet with legacy Solana derivation (compatibility only)
npx @aifinpay/wallet new --legacy-solana
```

**Recommended:** Store passphrase in `~/.aifinpay/secrets/passphrase` (mode 600) for persistence across reboots. Add to `~/.bashrc` for auto-load:

```bash
echo 'export AIFINPAY_WALLET_PASSPHRASE=$(cat ~/.aifinpay/secrets/passphrase)' >> ~/.bashrc
```

## Library Usage

The wallet package can be used programmatically:

```ts
import { newWallet, deriveWallet, createWalletCLI } from "@aifinpay/wallet";

// Create wallet with standard derivation (recommended)
const wallet = await newWallet({ mode: "standard" });

// Create wallet with legacy Solana derivation (compatibility)
const legacy = await newWallet({ mode: "legacy-solana" });

// Use CLI function with --legacy-solana flag
await createWalletCLI("new", ["node", "wallet", "--legacy-solana"]);
```

## Rules

- Never silently overwrite the keystore: `new` refuses if the file exists (see `src/cli.ts`); keep that guard.
- Derivation is NOT BIP-39 — never claim standard-wallet recovery works.
- Keep deps tiny (`@noble/*`, `bs58`, `tweetnacl`); do not add viem/web3.js. `AIFINPAY_HOME` override must keep working.
- Keystore perms stay 600 (dir 700); new key handling needs a test in `tests/`.
- Encrypted keystores require `AIFINPAY_WALLET_PASSPHRASE` in node/ and MCP.
- Legacy Solana derivation (`--legacy-solana`) should only be used for compatibility with existing wallets.
