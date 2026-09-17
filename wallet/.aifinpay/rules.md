# AiFinPay Agent Rules

## Security Rules

1. **Never log or print secrets** — seed, passphrase, private keys
2. **Never commit keystore** — `agent.json` is gitignored
3. **Always verify permissions** — keystore must be mode 600, directory mode 700
4. **Fail closed** — refuse to operate if security checks fail

## Wallet Rules

1. **Never overwrite existing keystore** — `new` refuses if `agent.json` exists
2. **Always back up** — remind user to back up `~/.aifinpay/agent.json`
3. **Use encryption by default** — `--plain` only for legacy compatibility
4. **Standard derivation preferred** — `--legacy-solana` only for existing wallets

## Passphrase Rules

1. **Minimum 16 characters**
2. **Must contain**: lowercase (a-z), uppercase (A-Z), digits (0-9), special chars (!@$.^*_+=-)
3. **No # or other special characters** — may break shell parsing
4. **Store in `~/.aifinpay/secrets/passphrase`** for persistence

## Agent Behavior

1. **Auto-decrypt** — use `AIFINPAY_WALLET_PASSPHRASE` from environment
2. **No interactive prompts in non-TTY** — fail with clear error message
3. **Shared keystore** — `@aifinpay/mcp` reads the same `agent.json`
