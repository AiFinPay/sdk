# AiFinPay × Claude Desktop (MCP)

Zero-code local MCP integration for AiFinPay identity, history, route/deployment inspection and non-signing settlement preparation.

The current production MCP server does **not** sign or broadcast payments.

## Setup

1. Find your Claude Desktop config file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

2. Add:

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

3. Restart Claude Desktop.

## Persistent identity

Do not generate a wallet by printing a private key or paste a secret into the MCP config.

Initialize the local keystore once:

```bash
npx @aifinpay/mcp init
```

Then, in Claude, ask it to call `agent_reload` and `agent_address`.

If no persistent wallet is configured, the MCP server uses an ephemeral process identity. **Do not fund an ephemeral identity.**

## Verify it loaded

The current production source exposes:

- `agent_address`
- `agent_reload`
- `agent_quota`
- `agent_history`
- `agent_passport_resolve`
- `settlement_routes`
- `settlement_invoice`
- `settlement_solana`
- `settlement_casper`
- `deployment_info`

With `AIFINPAY_MODE=dev`, `dev_payment_quote` is also available.

Legacy `payable_fetch`, `agent_call`, `agent_quote`, `pay_with_split`, `quote_split` and `agent_claim_self` are not registered by the current production MCP server.

## First conversation

> **You:** Use `agent_address` to show only the public EVM, Solana and Casper addresses.

Then:

> **You:** Use `deployment_info` to show which deployments are currently enabled for settlement.

Then:

> **You:** Use `settlement_routes` to list currently runtime-verified AIFP-1 and AIFP-2 routes.

A result from `settlement_invoice`, `settlement_solana` or `settlement_casper` is a **non-signing invoice**, not evidence that funds moved.

## Other clients

The same command/args pattern works for MCP-aware clients that support local stdio servers.

See [../../MCP_CONFIG.md](../../MCP_CONFIG.md).
