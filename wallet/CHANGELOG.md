# @aifinpay/wallet — changelog

## 2.0.0 — deprecated API removed

Breaking. Addresses, derivation and the keystore format are unchanged.

- Removed the flat `evmAddress`, `solanaAddress`, `nearAddress`,
  `aptosAddress` and `tronAddress` fields: use `w.<chain>.address`.
- Removed the `keys` getter and the `WalletKeys` type: use `exportSeed()` and
  `w.<chain>.exportPrivateKey()` (same encodings).
- Removed Casper: `w.casper`, `casperAddress`, `casperPublicKey`,
  `DerivationDomain.CASPER` and `"casper"` in `ChainName`. Recover a Casper
  key with `@aifinpay/wallet@1` and the same seed.
- Removed the unused `LEGACY_SOLANA_DERIVATION` constant. The
  `legacy-solana` derivation mode is unchanged.
- `walletFromSolanaSecret` requires `{ mode: "legacy-solana" }` (it never
  supported anything else; the old default always threw), accepts only a
  64-byte tweetnacl secret key, and refuses one whose public-key half does not
  match its seed. `export` from a bare MCP keystore goes through the same
  check instead of slicing the secret unchecked.

## 1.8.0 — per-chain accounts

- One `ChainAccount` per chain on `DerivedWallet`: `evm`, `solana`, `near`,
  `aptos`, `tron` (and deprecated `casper`), each with `address`, `publicKey`
  and `exportPrivateKey()`, which exports that chain's key only.
  `exportSeed()` returns the recovery seed.
- `exportKeys()` from 1.7.0 is removed: it exported every key to sign on one
  chain. 1.7.0 was not published, so no released API breaks.
- Deprecated, still working: the flat `*Address` fields and the
  non-enumerable `keys` getter, now built from the per-chain exports.
- `dispose()` revokes every account's export. Addresses, derivation and the
  keystore format are unchanged.

## 1.7.0 — key material behind a private field

- `DerivedWallet` is now a class. Addresses stay plain readonly fields; the
  recovery seed is an ECMAScript `#private` field, so `JSON.stringify`,
  `util.inspect`, object spread and `structuredClone` no longer expose keys.
- New `exportKeys()` returns the key material (new `WalletKeys` type). `keys`
  remains as a deprecated non-enumerable getter that calls it.
- Only the root seed is held; per-chain keys are derived on export and their
  buffers zeroed. `dispose()` / `Symbol.dispose` zero the seed; exports then
  throw.
- Addresses, derivation and the keystore format are unchanged.

## 1.6.0 — Tron address

- Derive a Tron address from the same seed:
  `secp256k1(SHA-256("aifinpay:tron:v1\0" || seed))`, encoded as base58check
  of `0x41 || keccak256(pubkey)[-20:]`. Indexed wallets append the index after
  the domain separator, as for the other chains. New fields: `tronAddress`,
  `keys.tronPrivateKeyHex`, `DerivationDomain.TRON`. `new` and `show` print the
  Tron address. Existing addresses and the keystore format are unchanged.
- The full SDK and MCP do not derive Tron keys; this package only creates the
  address and key material.

## 1.5.1 — documentation refresh

- Remove a historical issue-reference snapshot from the README; describe the
  covered behavior without tying it to a transient issue state.

## 1.5.0 — unreleased

- Derive optional indexed child wallets from a 32-byte recovery seed without
  changing derivation for existing callers. Append the decimal index after
  each chain's domain NUL separator. Persist the seed and index as
  backward-compatible keystore metadata; CLI `show --index` and MCP
  `AIFINPAY_WALLET_INDEX` select sibling wallets.
- Complete the AiFinPay/sdk#96 fixes the tests pinned: refuse to overwrite an
  unreadable `agent.json`, reject unknown keystore schemes with "is not a
  keystore this version can read", generate only passphrases the CLI itself
  accepts (no `$`), stop duplicating existing `.env` lines when saving a
  generated passphrase, verify a 1.1.0 keystore's plaintext seed against its
  sealed key before trusting it, require the passphrase to `export` it, read
  bare `mcp init` keystores as legacy-solana, and never exit a host process
  that imports the library with `--help` in its argv.

## 1.3.0 — unreleased

- Deprecate Casper without removing or changing its domain, address, public
  key or secret seed. Preserve the existing derivation and keystore format.
- Remove Casper from `new`/`show` output and supported-chain descriptions.
  Keep the current architecture; this is a compatibility-preserving change.

## 1.2.0 — unreleased

Fixes for bugs found by the coverage pass (AiFinPay/sdk#96).

- **The encrypted keystore no longer stores the seed in plaintext.** A
  standard-mode seed is sealed next to the Solana secret under the same
  passphrase-derived key (`seedIv`/`seedTag`/`seedCt`). `ct` is unchanged, so
  `@aifinpay/mcp` reads the file as before. `export` of an encrypted keystore
  now needs `AIFINPAY_WALLET_PASSPHRASE`.
- Keystores written by 1.1.0 still open. `show` and `export` warn that their
  seed is stored in the clear, and refuse one whose plaintext seed does not
  derive the sealed key. 1.1.0 cannot read an encrypted standard-mode keystore
  written by this version.
- `new` refuses whenever `agent.json` exists, including a file it cannot read;
  it used to overwrite one. `show` and `export` say such a file is not a
  keystore this version understands, instead of "no wallet yet".
- A keystore without `derivationMode` — what `npx @aifinpay/mcp init` writes —
  is read as `legacy-solana`, its Solana key being the seed. `show` used to
  refuse it.
- Generated passphrases always pass the CLI's own rule; about 3–4% did not, and
  `show` then refused the owner's wallet. They no longer contain `$`, which a
  shell expands when it sources `~/.aifinpay/.env`.
- Saving a generated passphrase no longer duplicates every other line of
  `~/.aifinpay/.env`.
- Importing `@aifinpay/wallet` no longer prints help and exits when the host
  program was started with `--help`; help is handled by the CLI only.
- A default-mode (`standard`) wallet's output no longer says `@aifinpay/mcp`
  uses it with no config. MCP would run it at different EVM and Casper
  addresses; the output says to create the wallet with `--legacy-solana` for
  MCP. The derivation itself is unchanged.

## 1.1.1

- Security: encrypted keystores no longer store `seedHex` in plaintext. The
  seed is stored AES-GCM-encrypted (`seedEnc`); the Solana-secret ciphertext
  (`ct`) format is unchanged, so `@aifinpay/mcp` reads new keystores without
  an update. Pre-1.1.1 encrypted keystores and `--plain` keystores keep
  working unchanged — rotate old ones with a fresh `npx @aifinpay/wallet new`
  to drop the plaintext copy.

## 1.1.0

- Stable release: remove `keytar`/libsecret OS-keyring dependency, add encrypted
  default keystore (scrypt-aes-256-gcm) with strong generated passphrase stored in
  `~/.aifinpay/.env`, preserve `--plain` legacy format, keep keystore mode 600.
- Version aligned with the rest of the v2 stable SDK packages.

## 0.1.2

- Minimum Node engine is now 22 (`engines: >=22`). Node 18/20 are no
  longer supported. No runtime changes.

## 0.1.1

- Publish readiness: `main`/`types` entry points, `LICENSE` in `files`,
  `prepublishOnly` build, `publishConfig.access: public`, `author` field.
  No runtime changes.
