# AiFinPay × Claude Desktop (MCP)

Zero-code integration. Drop one config block, restart Claude, done.

## Setup

1. Find your config file:
   - macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
   - Windows: `%APPDATA%\Claude\claude_desktop_config.json`

2. Add this server entry (or merge with your existing `mcpServers`):

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

## Verify it loaded

Click the hammer icon in the chat input. You should see seven tools:
`agent_call`, `agent_claim_self`, `payable_fetch`, `agent_address`,
`agent_quote`, `pay_with_split`, `quote_split`.

## First conversation

> **You:** Use `agent_address` to show me your wallet address.
>
> **Claude:** *(tool call)* The address is `0xAbC123…`. Fund it with a
> few cents of MATIC + USDC on Polygon.

After funding:

> **You:** Use `payable_fetch` on `https://bridge.aifinpay.io/io-net/chat/completions`
> with body `{"model":"meta-llama/Llama-3.3-70B-Instruct","messages":[{"role":"user","content":"Hello"}]}`.
>
> **Claude:** *(tool call, settles 402 on-chain, retries, returns response)*

Claude pays the bridge, receives the inference, and shows you the
result. The on-chain tx hash is in the tool result.

## Persistent identity

By default the MCP server generates a fresh keypair every restart —
fine for testing, painful in real use because the new agent has no
funds. To persist:

1. Generate a keypair once:
   ```bash
   node -e "const {Agent}=require('@aifinpay/agent'); const a=Agent.new(); console.log({address:a.address, secret:a.secretB58})"
   ```
2. Fund the address.
3. Paste the secret into your MCP config:

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["-y", "@aifinpay/mcp"],
      "env": {
        "AIFINPAY_AGENT_SECRET": "<base58 secret>",
        "AIFINPAY_MAX_USD": "0.50"
      }
    }
  }
}
```

## Configs for other clients

Same recipe for Cursor, Windsurf, Continue, Cline, LobeChat — see
[`../../MCP_CONFIG.md`](../../MCP_CONFIG.md).
