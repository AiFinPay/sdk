# @aifinpay/wallet — agent guide

Light agent wallet (Solana + EVM + NEAR + Aptos + Tron) with 4 tiny crypto deps — no viem, no @solana/web3.js. Casper was removed in 2.0.0; do not reintroduce it. Keystore: `~/.aifinpay/agent.json` (mode 600), shared with `@aifinpay/mcp`.

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
npx @aifinpay/wallet new --index 0  # indexed wallet: same addresses in MCP and the full SDK
npx @aifinpay/wallet show         # print addresses
npx @aifinpay/wallet export       # print the seed to back up
```

## Security Features

- **Encrypted by default**: New wallets use scrypt-aes-256-gcm encryption (passphrase required)
- **Legacy plain format**: `--plain` flag creates unencrypted keystore for backwards compatibility
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
```

**Recommended:** Store passphrase in `~/.aifinpay/secrets/passphrase` (mode 600) for persistence across reboots. Add to `~/.bashrc` for auto-load:

```bash
echo 'export AIFINPAY_WALLET_PASSPHRASE=$(cat ~/.aifinpay/secrets/passphrase)' >> ~/.bashrc
```

## Library Usage

The wallet package can be used programmatically:

```ts
import { newWallet, deriveWallet, createWalletCLI } from "@aifinpay/wallet";

const wallet = await newWallet(); // root wallet
const child = deriveWallet(wallet.exportSeed(), { index: 0 }); // what MCP and the full SDK use

await createWalletCLI("new", ["node", "wallet", "--index", "0"]);
```

## Rules (Mandatory)

- Never silently overwrite the keystore: `new` refuses if the file exists (see `src/cli.ts`); keep that guard.
- Derivation is NOT BIP-39 — never claim standard-wallet recovery works.
- Keep deps tiny (`@noble/*`, `bs58`, `tweetnacl`); do not add viem/web3.js. `AIFINPAY_HOME` override must keep working.
- Keystore perms stay 600 (dir 700); new key handling needs a test in `tests/`.
- Key material stays in `DerivedWallet`'s `#seed` and leaves only through `exportSeed()` / `<chain>.exportPrivateKey()`; never add an enumerable or serialisable key field.
- Encrypted keystores require `AIFINPAY_WALLET_PASSPHRASE` in node/ and MCP.
- There is one Solana derivation. legacy-solana (raw-seed Solana key) was removed in 2.0.0: keep `--legacy-solana` and `{ mode: "legacy-solana" }` throwing, and keep unindexed legacy-solana keystores refused rather than shown at a different address. Do not reintroduce it.
