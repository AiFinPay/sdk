# @aifinpay/mcp

Local MCP tools for wallet discovery, payment history, quotas and non-signing
payment preparation. Read the bundled [skill](skills/SKILL.md), also exposed
as the MCP resource `aifinpay://skill`.

## Tools

| Tool | Purpose |
|---|---|
| agent_address | Current public wallet addresses |
| agent_reload | Reload configured local wallet files in this connection |
| agent_history | History by address, public passport, or both |
| agent_quota | Remaining retained prepaid batches |
| agent_passport_resolve | Public verified passport wallet bindings |
| settlement_routes | Read configured settlement routes |
| settlement_invoice | Build a non-signing invoice |
| dev_payment_quote | Dev-only Amoy batch quote; checks contract version |

This RC does not register payment-signing tools. Its legacy SDK dependency
supplies wallet derivation only; installing this MCP does not enable v2
settlement. An invoice or quote is not a completed payment.

## Local configuration

Select the wallet in this order: `SEED_HASH` → `./aifinpay/agents.json` →
legacy `AIFINPAY_AGENT_SECRET` → `~/.aifinpay/agent.json`.
SEED_HASH means a 32-byte hex seed, passed directly to SDK `fromSeed`.
See the skill for the exact project-file schema and multi-agent selection.

Use an absolute `AIFINPAY_AGENTS_FILE` path when the host's working directory
is not your project directory. Do not put the seed itself in a shared config.

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["-y", "@aifinpay/mcp@2.0.0-rc.6"],
      "env": {
        "AIFINPAY_AGENTS_FILE": "/absolute/project/aifinpay/agents.json",
        "AIFINPAY_AGENT_ID": "research-agent"
      }
    }
  }
}
```

The release above must be published before this npx command can install it.
For a source checkout, run `npm ci && npm run build` in mcp/ and configure
`node /absolute/path/to/mcp/bin/aifinpay-mcp.js` instead.

If using the legacy keystore, run `npx @aifinpay/mcp init` once and omit the
project-file variables. Optional `AIFINPAY_WALLET_PASSPHRASE` encrypts that
legacy file at creation. An already connected server can load it with
`agent_reload`; it does not need a new conversation. A changed package or
launch environment requires a server reconnect, subject to host support.

## History

`agent_history({address, source:"transactions"})` reads indexed Polygon
settlements; `source:"receipts"` reads retained batches, including test-mode
payments. Pass `passport` instead of, or alongside, `address` to resolve a
public passport first. A backend without the passport resolver cannot satisfy
passport-only queries. No secret API key is needed for public metadata.

Responses do not include bearer receipts. Limits are 1..100; follow
`next_offset`. History source/coverage is explicit: it is not a full wallet
explorer. Dev networks currently use receipt history, not the Polygon ledger.

## Other environment variables

- AIFINPAY_BASE_URL: backend origin; default https://aifinpay.io.
- AIFINPAY_HOME: directory of the legacy agent.json keystore.
- AIFINPAY_MODE=dev: expose dev_payment_quote; requires a separate dev base URL.
- AIFINPAY_TIMEOUT_MS: SDK request timeout.
- AIFINPAY_MAX_USD: legacy per-call budget; does not enable signing.
- AIFINPAY_TRUSTED_HOSTS: exact hosts allowed to bypass the DNS pre-check.
- AIFINPAY_ALLOW_PRIVATE_FETCH=1: explicit local-development network access.
  Never enable this on the public hosted MCP.

Dev quoting does not bypass wallet signatures, issuer verification or
receipt metering. See the bundled skill for backend prerequisites and the
remaining Amoy executor requirement.
