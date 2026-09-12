# @aifinpay/mcp

AiFinPay MCP server for persistent agent identity, Agent Passport resolution,
route discovery and non-signing settlement invoices. Canonical domain:
**aifinpay.io**.

This 2.0 release candidate does not expose payment-signing tools. Returning a
wallet address or preparing an invoice does not authorize or execute a payment.
Signing remains gated on the verified SDK v2 executor and its release evidence.
Local MCP tools for wallet discovery, payment history, quotas and non-signing
payment preparation. Read the bundled [skill](skills/SKILL.md), also exposed
as the MCP resource `aifinpay://skill`.

## Tools

| Tool | Purpose |
|---|---|
| `agent_address` | Read the current Solana, EVM and Casper addresses. |
| `agent_reload` | Reload local wallet files in the current MCP connection. |
| `agent_quota` | Read the agent's quota. |
| `agent_passport_resolve` | Resolve the global Agent Passport identity. |
| `settlement_routes` | Read the available verified settlement routes. |
| `settlement_invoice` | Prepare a non-signing settlement invoice. |

Legacy `payable_fetch`, `agent_call`, `agent_quote`, `pay_with_split`,
`quote_split` and `agent_claim_self` tools are not registered by this RC.

## Persistent wallet selection

The CLI (`init` and stdio), programmatic server and `agent_reload` use the same
priority:

1. `SEED_HASH`: an existing 32-byte seed encoded as 64 hex characters, optionally
   prefixed with `0x`. It is passed directly to `AiFinPayAgent.fromSeed`; do not
   hash it again or supply a mnemonic.
2. `./aifinpay/agents.json`, relative to the MCP process's working directory.
   Set an absolute `AIFINPAY_AGENTS_FILE` when a desktop client's working
   directory differs from the project directory. The file contains an `agents`
   array of records with `id` and private `seed_hash` fields. If there is more
   than one record, select exactly one with `AIFINPAY_AGENT_ID`.
3. `AIFINPAY_AGENT_SECRET`: a legacy base58 Solana secret.
4. `~/.aifinpay/agent.json`, or `AIFINPAY_HOME/agent.json`: the legacy CLI
   keystore. Encrypted files require `AIFINPAY_WALLET_PASSPHRASE`.

Keep seeds and wallet files private and out of chat, source control and logs.
Invalid or ambiguous configured inputs fail; they never generate a replacement
wallet. With no configured wallet at all the server has an ephemeral identity:
**do not fund it**.

## Initialize and connect
This RC does not register payment-signing tools. Its legacy SDK dependency
supplies wallet derivation only; installing this MCP does not enable v2
settlement. An invoice or quote is not a completed payment.

## Local configuration
```bash
npx @aifinpay/mcp@next init
```

Select the wallet in this order: `SEED_HASH` → `./aifinpay/agents.json` →
legacy `AIFINPAY_AGENT_SECRET` → `~/.aifinpay/agent.json`.
SEED_HASH means a 32-byte hex seed, passed directly to SDK `fromSeed`.
See the skill for the exact project-file schema and multi-agent selection.
`init` prints the selected wallet's public addresses. If a seed or project wallet
is already configured, it does not create a second legacy wallet. With no
wallet, it creates the legacy keystore with mode `600`; existing keystores are
retained. Back up that file privately. The `@next` tag selects the 2.0 RC lane;
use the release containing these changes, or build this source checkout.

Use an absolute `AIFINPAY_AGENTS_FILE` path when the host's working directory
is not your project directory. Do not put the seed itself in a shared config.
A client configuration can use the keystore without embedding its secret:

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
Connect the MCP server once. After `init` or a wallet file update, call
`agent_reload` in that same connection; no new conversation is required. A
failed reload keeps the previous wallet. Changed shell environment variables
require reconnecting the MCP process, since its environment is a startup
snapshot. Verify `agent_address` against the wallet you intend to use.

## Other environment variables

| Variable | Default | Purpose |
|---|---|---|
| `AIFINPAY_BASE_URL` | `https://aifinpay.io` | Backend URL. |
| `AIFINPAY_TIMEOUT_MS` | `30000` | Request timeout. |
| `AIFINPAY_MAX_USD` | — | Configures the underlying agent's per-call cap; it does not enable signing. |

`agent_history({address, source:"transactions"})` reads indexed Polygon
settlements; `source:"receipts"` reads retained batches, including test-mode
payments. Pass `passport` instead of, or alongside, `address` to resolve a
public passport first. A backend without the passport resolver cannot satisfy
passport-only queries. No secret API key is needed for public metadata.

Responses do not include bearer receipts. Limits are 1..100; follow
`next_offset`. History source/coverage is explicit: it is not a full wallet
explorer. Dev networks currently use receipt history, not the Polygon ledger.

```
const { server } = await createServer(loadConfigFromEnv());
await server.connect(new StdioServerTransport());
```

The programmatic equivalents of identity environment options are `seedHash`,
`agentsFile`, `agentId`, `agentSecretB58`, `walletHome` and `walletPassphrase`.


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

## License

MIT.
