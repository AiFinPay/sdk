# @aifinpay/wallet

Derive an AiFinPay agent wallet — Solana, EVM and Casper addresses from one
seed — with five tiny crypto dependencies and nothing else.

```
npx @aifinpay/wallet
```

```
Created ~/.aifinpay/agent.json (mode 600).

Your agent's addresses — the EVM one is the same on every EVM chain:

  EVM     0x…
  Solana  …
  Casper  account-hash-…
```

## Prerequisites

### Linux

This package uses `keytar` for OS keyring integration, which requires `libsecret`:

```bash
# Debian/Ubuntu
sudo apt-get update && sudo apt-get install libsecret-1-dev

# Red Hat-based
sudo yum install libsecret-devel

# Arch Linux
sudo pacman -S libsecret
```

**Alternative (no keyring support):** If you don't need OS keyring integration, you can skip libsecret:
```bash
npm install @aifinpay/wallet --ignore-scripts
```
Note: `keyring-*` commands will fail without libsecret.

### macOS

Xcode Command Line Tools required:
```bash
xcode-select --install
```

### Windows

No additional prerequisites. Visual Studio Build Tools may be required for native module compilation.

## Why this exists

`@aifinpay/agent` is the full SDK — it derives keys **and** signs transactions,
so installing it pulls `viem` and `@solana/web3.js`: ~142 packages, ~157 MB. In a
constrained agent sandbox that install does not merely bloat, it **fails**.

Making a wallet needs none of that. This package installs **5 packages, ~5 MB**
in a couple of seconds and derives the **exact same addresses** the full SDK
would — checked byte-for-byte against `@aifinpay/agent` in CI. The division of
labour:

|                                     | install | use for                                          |
| ----------------------------------- | ------- | ------------------------------------------------ |
| `@aifinpay/wallet`                  | ~5 MB   | **create** a wallet, anywhere                    |
| `@aifinpay/agent` / `@aifinpay/mcp` | ~157 MB | **pay** — only when you actually settle on-chain |

The keystore this writes (`~/.aifinpay/agent.json`) is the one `@aifinpay/mcp`
reads, so `npx @aifinpay/mcp` picks up a wallet made here with no extra config.

## CLI

```
npx @aifinpay/wallet                    create if absent, else show
npx @aifinpay/wallet new                create (won't overwrite a funded wallet)
npx @aifinpay/wallet new --encrypt      create encrypted keystore (prompts for passphrase)
npx @aifinpay/wallet show               print addresses
npx @aifinpay/wallet export             print the seed to back up
npx @aifinpay/wallet keyring-save       store secret in OS keyring
npx @aifinpay/wallet keyring-load       load secret from OS keyring to ~/.aifinpay/agent.json
npx @aifinpay/wallet keyring-delete     remove secret from OS keyring
```

**Encrypted Keystore:** Use `--encrypt` to create a passphrase-encrypted keystore (scrypt-aes-256-gcm). The encrypted format is compatible with `@aifinpay/agent` and `@aifinpay/mcp` (requires `AIFINPAY_WALLET_PASSPHRASE` environment variable).

**OS Keyring:** The `keyring-*` commands store/retrieve your secret from the OS secure storage (macOS Keychain, Windows Credential Manager, Linux libsecret/KWallet). After `keyring-save`, you can safely delete `~/.aifinpay/agent.json` and restore it later with `keyring-load`.

## Library

```ts
import { deriveWallet, newWallet } from "@aifinpay/wallet";

const w = await newWallet();
w.evmAddress; // 0x… (same on every EVM chain)
w.solanaAddress; // base58
w.casperAddress; // account-hash-…
w.keys.seedHex; // 32-byte seed — THE thing to back up
w.keys.evmPrivateKey; // for building your own transactions
w.keys.solanaSecretKeyB58; // tweetnacl 64-byte secret, base58

deriveWallet(w.keys.seedHex); // same seed → same wallet, deterministic
```

## Recovery

The derivation is **not** BIP-39/BIP-44 — no standard wallet (MetaMask, Phantom)
can recover this from a phrase. The 32-byte seed is the backup. Keep
`~/.aifinpay/agent.json`, or `npx @aifinpay/wallet export` and store the seed.

## What it does not do

Sign or send anything. It returns addresses and raw keys. To pay, use
`@aifinpay/agent` — that is when the heavier install earns its size.

MIT.
