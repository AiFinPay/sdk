# @aifinpay/wallet

Derive an AiFinPay agent wallet — Solana, EVM and Casper addresses (plus NEAR
and Aptos) from one seed — with four tiny crypto dependencies and nothing else.

```
npx @aifinpay/wallet new
```

```
Generated strong passphrase and saved to ~/.aifinpay/.env

Your agent's addresses — the EVM one is the same on every EVM chain:

  EVM     0x…
  Solana  …
  Casper  account-hash-…
```

With `--plain` the first line reads `Created ~/.aifinpay/agent.json (mode 600).`
instead.

> **Using this wallet with `@aifinpay/mcp` or `@aifinpay/agent`? Create it with
> `--legacy-solana`.** In the default (`standard`) mode this package derives
> the Solana key from a domain-separated hash of the seed and stores that key
> in `agent.json`. `@aifinpay/mcp` and `AiFinPayAgent.fromSolanaSecret` read
> only that stored key and derive the EVM and Casper keys from it, so they run
> the agent at **different EVM and Casper addresses** from the ones this CLI
> prints. Only `legacy-solana` wallets derive the same addresses as the full
> SDK. Do not fund a default-mode wallet for use with MCP.

## Why this exists

`@aifinpay/agent` is the full SDK — it derives keys **and** signs transactions,
so installing it pulls `viem` and `@solana/web3.js`: ~142 packages, ~157 MB. In a
constrained agent sandbox that install does not merely bloat, it **fails**.

Making a wallet needs none of that. This package has **four dependencies
(~4.5 MB)** — `@noble/curves`, `@noble/hashes`, `bs58`, `tweetnacl` — and
installs in seconds. In `legacy-solana` mode it derives the same Solana, EVM
and Casper addresses as `@aifinpay/agent`'s `fromSeed`. The division of labour:

|                                     | install  | use for                                          |
| ----------------------------------- | -------- | ------------------------------------------------ |
| `@aifinpay/wallet`                  | ~4.5 MB  | **create** a wallet, anywhere                    |
| `@aifinpay/agent` / `@aifinpay/mcp` | ~157 MB  | **pay** — only when you actually settle on-chain |

The keystore this writes is `~/.aifinpay/agent.json` (or
`$AIFINPAY_HOME/agent.json`), the file `@aifinpay/mcp` reads. See the note
above about which derivation mode MCP can use.

## CLI

```
npx @aifinpay/wallet new                    create an encrypted keystore (refuses to overwrite an existing one)
npx @aifinpay/wallet new --plain            create an unencrypted keystore (not recommended)
npx @aifinpay/wallet new --legacy-solana    derive Solana from the raw seed (the full SDK's and MCP's derivation)
npx @aifinpay/wallet show                   print the addresses
npx @aifinpay/wallet export                 print the seed to back up
npx @aifinpay/wallet --help                 usage
```

A command is required: `npx @aifinpay/wallet` on its own exits with
"command required".

**Encrypted keystore (default).** New wallets are encrypted with
scrypt-aes-256-gcm.
- If `AIFINPAY_WALLET_PASSPHRASE` is set, it is the passphrase. It must be at
  least 16 characters and contain a lower-case letter, an upper-case letter, a
  digit and one of `!@$.^*_+=-`.
- If it is not set, the CLI generates a passphrase and saves it to
  `~/.aifinpay/.env` and `~/.aifinpay/secrets/passphrase` (both mode 600). It
  does not prompt.
- `show` needs `AIFINPAY_WALLET_PASSPHRASE` in the environment to open an
  encrypted keystore; the CLI does not read `.env` itself. `@aifinpay/mcp`
  needs the same variable in its `env`. The seed itself is stored encrypted (`seedEnc`) — no plaintext key material is written to the keystore.

> **Known issues** (recorded as failing tests in AiFinPay/sdk#96):
> - The encrypted keystore currently also stores the seed (`seedHex`) in
>   plaintext next to the ciphertext, and `export` prints it without the
>   passphrase. Treat `agent.json` as a plaintext secret until this is fixed.
> - About 3–4% of generated passphrases do not meet the rule above, and `show`
>   then refuses them. Setting your own `AIFINPAY_WALLET_PASSPHRASE` avoids it.
> - `show` cannot read a keystore written by `npx @aifinpay/mcp init`.

**Plain keystore.** `--plain` writes an unencrypted keystore, protected only by
file mode 600.

## Local development

When working from the source tree (without publishing to npm):

```bash
cd wallet/
npm ci
npm run build

node dist/cli.js new
node dist/cli.js show
node dist/cli.js export
node dist/cli.js new --plain
```

Non-interactive use with your own passphrase:

```bash
export AIFINPAY_WALLET_PASSPHRASE='Correct-Horse-Battery-9'   # ≥16 chars, upper, lower, digit, special
node dist/cli.js new
node dist/cli.js show
```

## Library

```ts
import { deriveWallet, newWallet, walletFromSeed } from "@aifinpay/wallet";

const w = await newWallet();
w.evmAddress; // 0x… (same on every EVM chain)
w.solanaAddress; // base58
w.casperAddress; // account-hash-…
w.nearAddress; // hex Ed25519 public key
w.aptosAddress; // 0x… authentication key
w.keys.seedHex; // 32-byte seed — THE thing to back up
w.keys.evmPrivateKey; // for building your own transactions
w.keys.solanaSecretKeyB58; // tweetnacl 64-byte secret, base58

deriveWallet(w.keys.seedHex); // same seed → same wallet, deterministic
```

### Derivation modes

`standard` (the default) derives the Solana key from
`SHA-256("aifinpay:solana:v1\0" || seed)`. `legacy-solana` derives it from the
raw seed, as `@aifinpay/agent` and `@aifinpay/mcp` do. EVM, Casper, NEAR and
Aptos are the same in both modes.

```ts
import { newWallet, walletFromSeed } from "@aifinpay/wallet";

// Create a wallet with the full SDK's Solana derivation
const legacyWallet = await newWallet({ mode: "legacy-solana" });

// Or recover from an existing seed in that mode
const recovered = walletFromSeed(seedHex, { mode: "legacy-solana" });
```

### Programmatic CLI usage

```ts
import { createWalletCLI } from "@aifinpay/wallet";

// Encrypted keystore with the full SDK's Solana derivation
await createWalletCLI("new", ["node", "wallet", "--legacy-solana"]);

// Unencrypted keystore
await createWalletCLI("new", ["node", "wallet", "--plain"]);
```

`createWalletCLI` calls `process.exit` on its error paths (for example, when a
keystore already exists), as the CLI does.

## Recovery

The derivation is **not** BIP-39/BIP-44 — no standard wallet (MetaMask, Phantom)
can recover this from a phrase. The 32-byte seed is the backup. Keep
`~/.aifinpay/agent.json`, or `npx @aifinpay/wallet export` and store the seed.

## What it does not do

Sign or send anything. It returns addresses and raw keys. To pay, use
`@aifinpay/agent` — that is when the heavier install earns its size.

MIT.
