# MCP install — one config block per client

`@aifinpay/mcp` is an MCP server that gives an LLM seven payment tools.
The install is the same everywhere: register `npx -y @aifinpay/mcp` as an
MCP server in your client's config. The client downloads the package on
first run via `npx`.

If your client is not listed, the pattern is universal — any MCP-aware
runtime that accepts a `command + args` server entry will work.

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

Restart Claude Desktop. The seven tools (`agent_call`, `agent_claim_self`,
`payable_fetch`, `agent_address`, `agent_quote`, `pay_with_split`,
`quote_split`) show up in the hammer menu.

## Cursor

Edit `~/.cursor/mcp.json` (create it if missing):

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

Then open Cursor → Settings → MCP and toggle `aifinpay` on.

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

## Continue (`continue.dev`)

In `~/.continue/config.json`, add to `experimental.mcpServers`:

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

## Cline (VS Code extension)

Open the Cline MCP Servers panel → Configure MCP Servers → paste:

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

Settings → Plugins → Custom MCP → add server with:

- name: `aifinpay`
- command: `npx`
- args: `-y @aifinpay/mcp`

## Configuration (optional)

The MCP server reads two environment variables:

| Var | Default | Effect |
|---|---|---|
| `AIFINPAY_AGENT_SECRET` | random (per-process) | base58-encoded Ed25519 secret to reuse across sessions. Persist this if you want the same agent identity / funded address across restarts. |
| `AIFINPAY_MAX_USD` | unset | Hard cap per `agent_call` or `payable_fetch`. Set this explicitly before paid use. |

Example with persistent identity and a higher cap:

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["-y", "@aifinpay/mcp"],
      "env": {
        "AIFINPAY_AGENT_SECRET": "<base58 secret from Agent.new()>",
        "AIFINPAY_MAX_USD": "0.50"
      }
    }
  }
}
```

## Verifying the install

In any MCP-aware client, ask the model:

> Use the `agent_address` tool to show me your wallet address.

A fresh agent returns a Polygon EVM address. Fund it with a few cents of
MATIC + USDC, then ask:

> Use `payable_fetch` on `https://bridge.aifinpay.io/io-net/chat/completions` with body `{"model":"meta-llama/Llama-3.3-70B-Instruct","messages":[{"role":"user","content":"Hello"}]}`.

The model autonomously pays the 402, fetches the inference, and returns
the assistant message. The tx hash is in the tool result.

## Tools exposed by the server

| Tool | Purpose |
|---|---|
| `agent_call(provider, ...)` | Call a provider from the AiFinPay directory with automatic payment. |
| `agent_claim_self(magic_link_url)` | Link the agent to an AiFinPay dashboard account. |
| `payable_fetch(url, ...)` | Fetch any URL; auto-pay on 402. |
| `agent_address()` | Show the agent's EVM/Solana address (for funding). |
| `agent_quote(url)` | Preview the cost before paying. |
| `pay_with_split(merchant, amount, order_id, chain)` | Prepare a direct on-chain split payment. Confirm the quoted total before paying. |
| `quote_split(chain, merchant_amount)` | Pure-view fee breakdown. |

## Troubleshooting

**`npx` hangs on first install.** That's the package downloading.
Subsequent calls are instant (cached in `~/.npm/_npx`).

**`Error: AIFINPAY_AGENT_SECRET invalid base58`.** The secret must be the
exact base58 string produced by `Agent.new().secret_b58` (Python) or
`Agent.new().secretB58` (Node). Leave the env unset to get a fresh
random identity on each start.

**Tool refuses to settle (`max_usd_exceeded`).** Raise
`AIFINPAY_MAX_USD`. It is unset by default, so set it explicitly before
allowing paid calls.

**Agent address shows `0x...` zeros.** Means the SDK couldn't derive a
key. Check `node -v` is `≥ 18`.
