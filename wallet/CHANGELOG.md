# @aifinpay/wallet — changelog

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
