# MCP install — one config block per client

`@aifinpay/mcp` is the AiFinPay MCP server for wallet discovery, payment history, quotas, Agent Passport resolution, deployment/route inspection and **non-signing** settlement preparation — and, only when the owner enables it, `payable_fetch` for AIFP-1 purchases on Polygon v1.4.

Current source package version: **2.4.1**.

Without owner payment configuration the server signs no payment, and a quote or settlement invoice is not a completed payment. With it, `payable_fetch` signs and broadcasts locally within the owner's limits — see [Enabling payments](#enabling-payments).

## Claude Desktop

Edit `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["-y", "@aifinpay/mcp"]
    }
  }
}
```

Restart Claude Desktop.

## Cursor

Edit `~/.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["-y", "@aifinpay/mcp"]
    }
  }
}
```

Then open Cursor → Settings → MCP and enable `aifinpay`.

## Windsurf

Edit `~/.codeium/windsurf/mcp_config.json`:

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["-y", "@aifinpay/mcp"]
    }
  }
}
```

Restart Windsurf.

## Continue

In `~/.continue/config.json`, add:

```json
{
  "experimental": {
    "mcpServers": {
      "aifinpay": {
        "command": "npx",
        "args": ["-y", "@aifinpay/mcp"]
      }
    }
  }
}
```

## Cline

Open the Cline MCP Servers panel → Configure MCP Servers and add:

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["-y", "@aifinpay/mcp"]
    }
  }
}
```

## LobeChat

Settings → Plugins → Custom MCP:

- name: `aifinpay`
- command: `npx`
- args: `-y @aifinpay/mcp`

## Persistent identity

Do not paste a seed or private key into chat or shared config.

The simplest local setup is an encrypted keystore created by `init`. It refuses to create one without a passphrase unless you ask for a plaintext test wallet:

```bash
AIFINPAY_WALLET_PASSPHRASE='<a long passphrase>' npx @aifinpay/mcp init
# disposable test wallet only:
npx @aifinpay/mcp init --plaintext
```

The server needs the same `AIFINPAY_WALLET_PASSPHRASE` in its `env` to open an encrypted keystore; without it the server does not start.

The server uses this wallet-selection priority:

1. `SEED_HASH`
2. `./aifinpay/agents.json` (or `AIFINPAY_AGENTS_FILE`)
3. legacy `AIFINPAY_AGENT_SECRET`
4. `~/.aifinpay/agent.json` (or `AIFINPAY_HOME/agent.json`)

If no persistent wallet is configured, the MCP server creates an **ephemeral process identity**. Do not fund an ephemeral identity.

After init or a wallet-file update, call `agent_reload`, then `agent_address`.

### Project wallet example

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["-y", "@aifinpay/mcp"],
      "env": {
        "AIFINPAY_AGENTS_FILE": "/absolute/project/aifinpay/agents.json",
        "AIFINPAY_AGENT_ID": "research-agent"
      }
    }
  }
}
```

## Current tools

The current `main` source registers these tools:

| Tool | Purpose |
|---|---|
| `agent_address` | Read the current EVM, Solana and Casper public addresses. |
| `agent_reload` | Reload configured local wallet files in the current MCP connection. |
| `agent_claim_self` | Link the agent to its owner's dashboard with a one-time URL from dash.aifinpay.io. Signs only an AiFinPay claim challenge for the agent's own address; moves no funds. |
| `payable_fetch` | Registered only when payments are enabled (below). Fetch a GET resource from an owner-approved AIFP-1 merchant, buying a prepaid batch on Polygon v1.4 within the owner's limits. |
| `agent_quota` | Read the agent's quota. |
| `agent_history` | Read indexed AiFinPay settlement history or retained receipt history. |
| `agent_passport_resolve` | Resolve a public Agent Passport identity and verified wallet bindings. |
| `settlement_routes` | Read runtime-verified AIFP-1 / AIFP-2 routes. |
| `settlement_invoice` | Build and validate a non-signing EVM settlement invoice. |
| `settlement_solana` | Build and validate a non-signing Solana settlement invoice. |
| `settlement_casper` | Build and validate a non-signing Casper settlement invoice. |
| `deployment_info` | Read deployment addresses/program IDs and current settlement status. |

With `AIFINPAY_MODE=dev`, the server additionally exposes `dev_payment_quote`.

Legacy `agent_call`, `agent_quote`, `pay_with_split` and `quote_split` are not registered by the current server.

## Enabling payments

`payable_fetch` is registered only when the owner sets all of the following in the server's `env`. With `AIFINPAY_PAYMENTS_ENABLED=1` and any of them missing or invalid, the server refuses to start rather than run without a limit. Payments also need a persistent wallet (not the ephemeral identity) and cannot be combined with `AIFINPAY_MODE=dev`.

```json
{
  "AIFINPAY_PAYMENTS_ENABLED": "1",
  "AIFINPAY_GATEWAY_ORIGINS": "https://merchant.example",
  "AIFINPAY_MAX_USD": "0.50",
  "AIFINPAY_DAILY_USD": "5",
  "AIFINPAY_MAX_GAS_POL": "0.3"
}
```

The full payment guide, including stablecoin payments and network access, is in [mcp/README.md](./mcp/README.md).

## Useful environment variables

| Variable | Default | Effect |
|---|---|---|
| `SEED_HASH` | — | Existing 32-byte seed encoded as 64 hex characters, optionally `0x` prefixed. |
| `AIFINPAY_AGENTS_FILE` | `./aifinpay/agents.json` | Explicit project wallet file. |
| `AIFINPAY_AGENT_ID` | — | Select one record when the project file contains multiple agents. |
| `AIFINPAY_AGENT_SECRET` | — | Legacy base58 secret input. Keep private. |
| `AIFINPAY_HOME` | `~/.aifinpay` | Directory of the `agent.json` keystore written by `init`. |
| `AIFINPAY_WALLET_PASSPHRASE` | — | Encrypt/decrypt the `agent.json` keystore. |
| `AIFINPAY_BASE_URL` | `https://aifinpay.io` | Backend origin. When unset, `payable_fetch` uses `https://api.aifinpay.io` for quotes and receipts. |
| `AIFINPAY_TIMEOUT_MS` | `30000` | SDK/MCP request timeout. |
| `AIFINPAY_PAYMENTS_ENABLED` | `0` | `1` registers `payable_fetch` (requires the limits below). Only `0` or `1` is accepted. |
| `AIFINPAY_MAX_USD` | — | Per-payment cap for `payable_fetch`; required when payments are enabled. A tool argument can lower it, never raise it. |
| `AIFINPAY_DAILY_USD` | — | Rolling 24-hour cap; required when payments are enabled. |
| `AIFINPAY_GATEWAY_ORIGINS` | — | Comma-separated exact HTTPS origins the agent may pay; required when payments are enabled. No wildcards. |
| `AIFINPAY_GATEWAY_PATH_MODE` | `gateway` | `gateway` for merchant-slug identity or `direct` for full request-path identity. |
| `AIFINPAY_MAX_GAS_POL` | — | Gas cap per payment in POL, e.g. `0.3`; required when payments are enabled. |
| `AIFINPAY_PAY_ASSET` | `POL` | Pay in POL or a stablecoin the SDK pins for Polygon v1.4, e.g. `USDC`. Gas is POL either way. |
| `AIFINPAY_TRUSTED_HOSTS` | — | Exact hosts allowed to skip the SSRF DNS pre-check, for environments that resolve only through a proxy. |
| `AIFINPAY_CLAIM_ORIGINS` | aifinpay.io dashboard/API origins | Origins `agent_claim_self` may contact; override only for staging. |
| `AIFINPAY_ALLOW_PRIVATE_FETCH` | — | `1` allows private-network fetches for local development. Never on a public host. |
| `AIFINPAY_MODE` | `live` | `live` or `dev`. `dev` exposes `dev_payment_quote`, needs an explicit non-production `AIFINPAY_BASE_URL`, and cannot be combined with payments. |

## Verify installation

Ask the client:

> Use `agent_address` and show only the public wallet addresses.

Then:

> Use `deployment_info` and show the current settlement status.

And:

> Use `settlement_routes` to list currently runtime-verified AIFP-1 and AIFP-2 routes.

Do not treat `settlement_invoice`, `settlement_solana` or `settlement_casper` output as proof that funds moved.

## Troubleshooting

**`npx` hangs on first install.** The package may still be downloading. Subsequent starts use the local npm cache.

**No persistent wallet configured / ephemeral identity warning.** Run `AIFINPAY_WALLET_PASSPHRASE='<a long passphrase>' npx @aifinpay/mcp init` (or `--plaintext` for a disposable test wallet), then call `agent_reload`. Do not fund the ephemeral address.

**Wallet file changed but the model still shows the old address.** Call `agent_reload`. Environment-variable changes require the MCP process to reconnect.

**Node version error.** Current packages require Node.js `>=22`.

## Security

- Never print or paste seeds, private keys or keystore JSON into chat.
- Verify the public address with `agent_address` before funding.
- A settlement invoice is non-signing and does not prove a payment occurred.
