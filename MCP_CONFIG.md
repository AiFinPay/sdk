# MCP install — one config block per client

`@aifinpay/mcp` is the AiFinPay MCP server for wallet discovery, payment history, quotas, Agent Passport resolution, deployment/route inspection and **non-signing** settlement preparation.

Current source package version: **2.1.0**.

The production MCP surface does not sign or broadcast payments. A quote or settlement invoice is not a completed payment.

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

The simplest local setup is:

```bash
npx @aifinpay/mcp init
```

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

## Current production tools

The current `main` source registers these production tools:

| Tool | Purpose |
|---|---|
| `agent_address` | Read the current EVM, Solana and Casper public addresses. |
| `agent_reload` | Reload configured local wallet files in the current MCP connection. |
| `agent_quota` | Read the agent's quota. |
| `agent_history` | Read indexed AiFinPay settlement history or retained receipt history. |
| `agent_passport_resolve` | Resolve a public Agent Passport identity and verified wallet bindings. |
| `settlement_routes` | Read runtime-verified AIFP-1 / AIFP-2 routes. |
| `settlement_invoice` | Build and validate a non-signing EVM settlement invoice. |
| `settlement_solana` | Build and validate a non-signing Solana settlement invoice. |
| `settlement_casper` | Build and validate a non-signing Casper settlement invoice. |
| `deployment_info` | Read deployment addresses/program IDs and current settlement status. |

With `AIFINPAY_MODE=dev`, the server additionally exposes `dev_payment_quote`.

Legacy `payable_fetch`, `agent_call`, `agent_quote`, `pay_with_split`, `quote_split` and `agent_claim_self` are not registered by the current production server.

## Useful environment variables

| Variable | Default | Effect |
|---|---|---|
| `SEED_HASH` | — | Existing 32-byte seed encoded as 64 hex characters, optionally `0x` prefixed. |
| `AIFINPAY_AGENTS_FILE` | `./aifinpay/agents.json` | Explicit project wallet file. |
| `AIFINPAY_AGENT_ID` | — | Select one record when the project file contains multiple agents. |
| `AIFINPAY_AGENT_SECRET` | — | Legacy base58 secret input. Keep private. |
| `AIFINPAY_HOME` | `~/.aifinpay` | Legacy keystore directory. |
| `AIFINPAY_WALLET_PASSPHRASE` | — | Encrypt/decrypt the legacy keystore. |
| `AIFINPAY_BASE_URL` | `https://aifinpay.io` | Backend origin. |
| `AIFINPAY_TIMEOUT_MS` | `30000` | SDK/MCP request timeout. |
| `AIFINPAY_MAX_USD` | — | Per-call budget cap for underlying SDK/private integrations; it does not enable signing in the production MCP. |
| `AIFINPAY_MODE` | — | Set to `dev` only for dev-only quote inspection. |

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

**No persistent wallet configured / ephemeral identity warning.** Run `npx @aifinpay/mcp init`, then call `agent_reload`. Do not fund the ephemeral address.

**Wallet file changed but the model still shows the old address.** Call `agent_reload`. Environment-variable changes require the MCP process to reconnect.

**Node version error.** Current packages require Node.js `>=22`.

## Security

- Never print or paste seeds, private keys or keystore JSON into chat.
- Verify the public address with `agent_address` before funding.
- A settlement invoice is non-signing and does not prove a payment occurred.
