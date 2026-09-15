# AiFinPay Agent Instructions

## Quick Start

1. **Create wallet**: `npx @aifinpay/wallet new`
2. **View addresses**: `npx @aifinpay/wallet show`
3. **Export seed**: `npx @aifinpay/wallet export`

## Keystore Location

- Path: `~/.aifinpay/agent.json`
- Permissions: mode 600 (owner read/write only)
- Directory: `~/.aifinpay/` mode 700

## Environment Variables

- `AIFINPAY_HOME` — override keystore directory (default: `~/.aifinpay`)
- `AIFINPAY_WALLET_PASSPHRASE` — passphrase for encrypted keystore

## Security Notes

- Back up `~/.aifinpay/agent.json` — it is the only copy
- Derivation is NOT BIP-39 — standard wallets cannot recover it
- Never commit `agent.json` to version control
- Keep passphrase secure and never log it

## Commands

```bash
npx @aifinpay/wallet new                    # create encrypted keystore
npx @aifinpay/wallet new --plain            # create unencrypted keystore (legacy)
npx @aifinpay/wallet new --legacy-solana    # create with legacy Solana derivation
npx @aifinpay/wallet show                   # print addresses
npx @aifinpay/wallet export                 # print seed hex
```

## Integration

The keystore is shared with `@aifinpay/mcp` — no additional config needed.
