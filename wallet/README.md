# @aifinpay/wallet

Derive an AiFinPay agent wallet — Solana, EVM, NEAR, Aptos and Tron addresses from
one seed — with four tiny crypto dependencies and nothing else.

```
npx @aifinpay/wallet new
```

```
Generated strong passphrase and saved to ~/.aifinpay/.env

Your agent's addresses — the EVM one is the same on every EVM chain:

  EVM     0x…
  Solana  …
  Tron    T…
```

With `--plain` the first line reads `Created ~/.aifinpay/agent.json (mode 600).`
instead.

> **Using the wallet with `@aifinpay/mcp` or `@aifinpay/agent`?** Create it with
> `--index 0` (or any index). Indexed keystores keep the recovery seed and
> index, and the wallet CLI, MCP and the full SDK derive the same addresses
> from them. An unindexed keystore stores only the Solana key for MCP, which
> MCP reads as if it were the seed, so it runs at **different addresses** from
> the ones this CLI prints.

## Why this exists

`@aifinpay/agent` is the full SDK — it derives keys **and** signs transactions,
so installing it pulls `viem` and `@solana/web3.js`: ~142 packages, ~157 MB. In a
constrained agent sandbox that install does not merely bloat, it **fails**.

Making a wallet needs none of that. This package has **four dependencies
(~4.5 MB)** — `@noble/curves`, `@noble/hashes`, `bs58`, `tweetnacl` — and
installs in seconds. Indexed wallets match the full SDK's addresses exactly;
unindexed wallets share its EVM address. The division of labour:

|                                     | install | use for                                          |
| ----------------------------------- | ------- | ------------------------------------------------ |
| `@aifinpay/wallet`                  | ~4.5 MB | **create** a wallet, anywhere                    |
| `@aifinpay/agent` / `@aifinpay/mcp` | ~157 MB | **pay** — only when you actually settle on-chain |

The keystore this writes is `~/.aifinpay/agent.json` (or
`$AIFINPAY_HOME/agent.json`), the file `@aifinpay/mcp` reads. See the note
above about which wallets MCP runs at the same addresses.

## CLI

```
npx @aifinpay/wallet new                    create an encrypted keystore (refuses to overwrite an existing one)
npx @aifinpay/wallet new --plain            create an unencrypted keystore (not recommended)
npx @aifinpay/wallet new --index 0         create indexed wallet 0
npx @aifinpay/wallet show                   print the addresses
npx @aifinpay/wallet show --index 1         show child wallet 1 without changing the keystore
npx @aifinpay/wallet export                 print the seed to back up
npx @aifinpay/wallet --help                 usage
```

A command is required: `npx @aifinpay/wallet` on its own exits with
"command required".

### Indexed wallets

Pass the same 32-byte recovery seed with an index to derive deterministic
siblings. Index `0` is the first wallet; `1`, `2`, and so on derive distinct
children. Each chain derives from its own versioned domain: for example,
`EVM = SHA-256("aifinpay:evm:v1\0" || decimalIndex || recoverySeed)` and
`Solana = Ed25519(SHA-256("aifinpay:solana:v1\0" || decimalIndex || recoverySeed))`.
The index is decimal UTF-8 text immediately after the domain's NUL separator.
Indices are integers from 0 through 4294967295. Omitting the index preserves
the existing derivation exactly.

```ts
import { walletFromSeed } from "@aifinpay/wallet";

const wallet0 = walletFromSeed(recoverySeed, { index: 0 });
const wallet1 = walletFromSeed(recoverySeed, { index: 1 });
```

The CLI stores the recovery seed and selected index as keystore metadata. `show --index N` derives another child from that
same stored recovery seed without changing the keystore. MCP reads the stored
index by default, or `AIFINPAY_WALLET_INDEX` can select another child from the
same seed. Back up both the recovery seed and its index; `export` prints the
seed only.

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

Tests cover encrypted seed storage, passphrase requirements for export,
generated passphrase validation, and the keystore fields MCP reads. An
unindexed wallet's addresses are not the ones MCP would derive (see the note at
the top).

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

// One account per chain: address + public key, paired with its own private key.
w.evm.address; // 0x… (same on every EVM chain)
w.solana.address; // base58
w.near.address; // hex Ed25519 public key
w.aptos.address; // 0x… authentication key
w.tron.address; // T… base58check
w.aptos.publicKey; // raw public key, hex (secp256k1 chains: 33-byte compressed)

// Key material lives in a private field: JSON.stringify(w), console.log(w)
// and {...w} show addresses and public keys only. Export what you sign with.
w.evm.exportPrivateKey(); // 0x… — exposes the EVM key and nothing else
w.solana.exportPrivateKey(); // tweetnacl 64-byte secret, base58
w.tron.exportPrivateKey(); // secp256k1 key, hex
const seedHex = w.exportSeed(); // 32-byte seed — THE thing to back up

deriveWallet(seedHex); // same seed → same wallet, deterministic

w.dispose(); // zero the in-memory seed; every export then throws
{
  using tmp = deriveWallet(seedHex); // disposed at end of scope
}
```

Only the root seed is held. Each chain's key is derived when you export it and
its byte buffer is zeroed afterwards; exported strings cannot be wiped, so keep
them short-lived.

### Upgrading from 1.x

2.0.0 removes the API deprecated in 1.x:

| 1.x                                                                                                          | 2.0.0                                                                         |
| ------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------- |
| `w.evmAddress`, `w.solanaAddress`, `w.nearAddress`, `w.aptosAddress`, `w.tronAddress`                        | `w.evm.address`, `w.solana.address`, …                                        |
| `w.keys.seedHex`                                                                                             | `w.exportSeed()`                                                              |
| `w.keys.evmPrivateKey`, `solanaSecretKeyB58`, `nearSecretSeedHex`, `aptosSecretSeedHex`, `tronPrivateKeyHex` | `w.evm.exportPrivateKey()`, `w.solana.exportPrivateKey()`, … (same encodings) |
| `LEGACY_SOLANA_DERIVATION`                                                                                   | — (unused constant)                                                           |
| `{ mode: "legacy-solana" }`, `--legacy-solana`, `derivationMode`, `DerivationMode`                           | removed — throws if passed                                                    |
| `walletFromSolanaSecret`                                                                                     | removed                                                                       |
| Casper: `w.casper`, `casperAddress`, `casperPublicKey`, `DerivationDomain.CASPER`                            | removed                                                                       |

The only Solana derivation is `Ed25519(SHA-256("aifinpay:solana:v1\0" || seed))`
(plus the decimal index for indexed wallets). Standard and indexed addresses are
unchanged from 1.x, and keystores written by 1.x in the default mode, or with
any `--index`, open as before.

**Legacy-solana keystores no longer open unindexed.** 1.x `--legacy-solana`
keystores and bare `npx @aifinpay/mcp init` keystores used the raw seed as the
Solana key. `show` and `export` refuse them instead of printing a different
Solana address; open them with `npx @aifinpay/wallet@1`. Their indexed
siblings (`show --index N`) are unaffected.

**Casper.** To recover a key for funds left on a Casper address, use
`@aifinpay/wallet@1` with the same seed; its derivation was
`Ed25519(SHA-256("aifinpay:casper:v1\0" || seed))`.

### Programmatic CLI usage

```ts
import { createWalletCLI } from "@aifinpay/wallet";

// Encrypted indexed keystore — the addresses MCP and the full SDK use
await createWalletCLI("new", ["node", "wallet", "--index", "0"]);

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
