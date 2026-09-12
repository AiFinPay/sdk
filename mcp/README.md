# @aifinpay/mcp

MCP server exposing AiFinPay's autonomous x402 payment loop as
agent-callable tools. Drop it into Claude Desktop, MCP Inspector, or any
MCP-aware agent runtime — your agent can now buy services autonomously.

Canonical domain: **aifinpay.io** (the legacy `aifinpay.company` host is
retired — ignore any docs pointing there). SDK settlement runs on
**Polygon (default) and Solana**; the underlying Node SDK (≥ 1.3.0) also
supports direct splitter settlement on Base, Optimism, Unichain, BOT Chain
and XRPL EVM (native-token path), while the MCP `pay_with_split` /
`quote_split` tools stay Polygon + Solana (backend invoice flow). The
protocol itself is live across 13 networks — see
[aifinpay.io/llms.txt](https://aifinpay.io/llms.txt).

## Tools

| Tool | What it does |
|---|---|
| `payable_fetch(url, opts?)` | Fetch any URL. On 402, auto-detect facilitator, sign, retry. |
| `agent_address()` | Read the selected wallet's EVM, Solana and Casper addresses. |
| `agent_reload()` | Reload configured local wallet files in the current MCP connection. |
| `agent_quote(url)` | Inspect a 402 challenge without paying. Shows the merchant's quoted amount + facilitator flavor. |
| `agent_call(provider, …)` | Call a live provider from the AiFinPay directory (io.net, Exa, Venice, …) with automatic payment. |
| `pay_with_split(chain, merchant, amount, …)` | Direct fee-on-top payment to any merchant wallet — merchant receives 100% of the amount, AiFinPay adds 1% on top. |
| `quote_split(chain, amount)` | Preview the exact on-chain amounts of a `pay_with_split` before paying. |
| `agent_claim_self(magic_link_url)` | Link this agent to your dashboard account via a one-shot magic link from `aifinpay.io/login` — spend history shows up in the dashboard. |

## Install

```bash
# Globally — usable as `npx @aifinpay/mcp` from any client config
# (installs the latest stable — the old @alpha tag is retired, don't use it)
npm install -g @aifinpay/mcp
```

## Use with Claude Desktop

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["@aifinpay/mcp"],
      "env": {
        "AIFINPAY_MAX_USD": "0.50"
      }
    }
  }
}
```

Initialize the wallet as below, then connect the MCP server. Existing payment
tools remain available. After a wallet file update, call `agent_reload`; no new
conversation is required. Changes to shell environment variables require
reconnecting the MCP process.

## First run — initializing an agent

```bash
npx @aifinpay/mcp init
```

Use the maintenance release containing these changes, or build this checkout.
`init` prints the selected public addresses. It does not create a different
legacy wallet when a seed or project agent is already configured. With no
wallet it creates `~/.aifinpay/agent.json` with mode `600`; keep a private backup.
It never prints private keys to the MCP transcript. After `init`, an already
connected server can load the wallet with `agent_reload`.

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

`agent_reload` keeps the current wallet if validation fails. A successful reload
uses the same source priority and reapplies the operator's payment cap. Confirm
`agent_address` matches your intended wallet before funding or paying.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `SEED_HASH` | — | Highest-priority 32-byte hex seed. |
| `AIFINPAY_AGENTS_FILE` | `./aifinpay/agents.json` | Project wallet file. |
| `AIFINPAY_AGENT_ID` | — | Select one project agent by its `id`. |
| `AIFINPAY_AGENT_SECRET` | — | Legacy base58 secret, after project sources. |
| `AIFINPAY_HOME` | `~/.aifinpay` | Legacy keystore directory. |
| `AIFINPAY_WALLET_PASSPHRASE` | — | Opens an existing encrypted keystore; init creates a plaintext file. |
| `AIFINPAY_GATEWAY_ORIGINS` | SDK default | Comma-separated exact HTTPS origins for self-hosted AIFP-1 gateways. |
| `AIFINPAY_BASE_URL` | `https://aifinpay.io` | Backend URL for nonce + funding probes. |
| `AIFINPAY_TIMEOUT_MS` | `30000` | Request timeout. |
| `AIFINPAY_MAX_USD` | — | Hard cap per single payment. Strongly recommended. |

For the Raters self-hosted gateway, set this in the MCP client's environment:

```json
{
  "AIFINPAY_GATEWAY_ORIGINS": "https://dev.ratersapp.com,https://gateway.aifinpay.io",
  "AIFINPAY_BASE_URL": "https://api.aifinpay.io",
  "AIFINPAY_MAX_USD": "0.50"
}
```

Only those exact gateway origins are trusted for AIFP-1 payment handling. The
list rejects wildcards, paths, credentials and plaintext HTTP; DNS/private-address
protection still applies. Omit the setting to keep the SDK's default gateway.
Reconnect the MCP process after changing its environment, then inspect the paid
URL with `agent_quote` before invoking `payable_fetch`.

## Programmatic use

```ts
import { createServer, loadConfigFromEnv } from "@aifinpay/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const { server } = await createServer({
  ...loadConfigFromEnv(),
  maxAmountUsd: 0.10,
});
await server.connect(new StdioServerTransport());
```

## How `payable_fetch` works

1. Sends the request unauthenticated.
2. On `402`, the underlying [`@aifinpay/agent`](../node) SDK detects the
   facilitator flavor (AiFinPay native, Coinbase x402, …).
3. Signs a payment payload and retries.
4. Returns `{ status, ok, headers, body }` to the agent.

For an AIFP-1 gateway, the tool calls `AiFinPayAgent.fetchPaid`; other supported
x402 responses use the underlying `Agent.pay` facilitator flow. Neither path
changes which local wallet is selected. This maintenance update does not enable
the separate SDK v2 RC settlement routes.

## License

MIT.
