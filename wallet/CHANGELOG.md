# @aifinpay/wallet — changelog

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
