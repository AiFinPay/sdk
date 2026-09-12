# @aifinpay/mcp

AiFinPay MCP server for persistent agent identity, Agent Passport resolution,
route discovery and non-signing settlement invoices. Canonical domain:
**aifinpay.io**.

This 2.0 release candidate does not expose payment-signing tools. Returning a
wallet address or preparing an invoice does not authorize or execute a payment.
Signing remains gated on the verified SDK v2 executor and its release evidence.

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

```bash
npx @aifinpay/mcp@next init
```

`init` prints the selected wallet's public addresses. If a seed or project wallet
is already configured, it does not create a second legacy wallet. With no
wallet, it creates the legacy keystore with mode `600`; existing keystores are
retained. Back up that file privately. The `@next` tag selects the 2.0 RC lane;
use the release containing these changes, or build this source checkout.

A client configuration can use the keystore without embedding its secret:

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["-y", "@aifinpay/mcp@next"],
      "env": { "AIFINPAY_MAX_USD": "0.50" }
    }
  }
}
```

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

## Programmatic use

```ts
import { createServer, loadConfigFromEnv } from "@aifinpay/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const { server } = await createServer(loadConfigFromEnv());
await server.connect(new StdioServerTransport());
```

The programmatic equivalents of identity environment options are `seedHash`,
`agentsFile`, `agentId`, `agentSecretB58`, `walletHome` and `walletPassphrase`.

## License

MIT.
