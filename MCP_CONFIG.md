# MCP install — one config block per client

`@aifinpay/mcp` is an MCP server that gives an LLM payment tools for
wallet discovery, payment history, quotas and non-signing settlement
preparation. Stable **2.0.0** release.

The install is the same everywhere: register `npx @aifinpay/mcp` as an
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
      "args": ["@aifinpay/mcp"]
    }
  }
}
```

Restart Claude Desktop. The tools (`agent_address`, `agent_reload`,
`agent_quota`, `agent_passport_resolve`, `settlement_routes`,
`settlement_invoice`) show up in the hammer menu.

## Cursor

Edit `~/.cursor/mcp.json` (create it if missing):

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["@aifinpay/mcp"]
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
      "args": ["@aifinpay/mcp"]
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
        "args": ["@aifinpay/mcp"]
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
      "args": ["@aifinpay/mcp"]
    }
  }
}
```

## LobeChat

Settings → Plugins → Custom MCP → add server with:

- name: `aifinpay`
- command: `npx`
- args: `@aifinpay/mcp`

## Configuration (optional)

The MCP server reads environment variables for wallet selection and
optional limits. Wallet priority: `SEED_HASH` → `./aifinpay/agents.json` →
`AIFINPAY_AGENT_SECRET` → `~/.aifinpay/agent.json`.

| Var | Default | Effect |
|---|---|---|
| `SEED_HASH` | — | 32-byte hex seed (optionally `0x`-prefixed) for deterministic wallet derivation. |
| `AIFINPAY_AGENTS_FILE` | `./aifinpay/agents.json` | Path to project wallet file with `agents` array. |
| `AIFINPAY_AGENT_ID` | — | Select agent by id when `agents.json` has multiple records. |
| `AIFINPAY_AGENT_SECRET` | random (per-process) | Legacy base58-encoded Ed25519 secret. |
| `AIFINPAY_MAX_USD` | — | Configures per-call cap; does not enable signing in 2.0.0. |
| `AIFINPAY_WALLET_PASSPHRASE` | — | Encrypts legacy keystore at `~/.aifinpay/agent.json`. |

Example with persistent project wallet:

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["@aifinpay/mcp@2.0.0"],
      "env": {
        "AIFINPAY_AGENTS_FILE": "/absolute/project/aifinpay/agents.json",
        "AIFINPAY_AGENT_ID": "research-agent"
      }
    }
  }
}
```

## Verifying the install

In any MCP-aware client, ask the model:

> Use the `agent_address` tool to show me your wallet address.

The agent returns EVM, Solana and Casper addresses. Fund the EVM address
with POL or USDC on Polygon for future settlement routes.

## Tools exposed by the server

| Tool | Purpose |
|---|---|
| `agent_address` | Read the current Solana, EVM and Casper addresses. |
| `agent_reload` | Reload local wallet files in the current MCP connection. |
| `agent_quota` | Read the agent's quota. |
| `agent_passport_resolve` | Resolve the global Agent Passport identity. |
| `settlement_routes` | Read the available verified settlement routes. |
| `settlement_invoice` | Prepare a non-signing settlement invoice. |

Legacy `payable_fetch`, `agent_call`, `agent_quote`, `pay_with_split`,
`quote_split` and `agent_claim_self` tools are not registered in 2.0.0.

## Troubleshooting

**`npx` hangs on first install.** That's the package downloading.
Subsequent calls are instant (cached in `~/.npm/_npx`).

**`Error: no configured wallet` or `EPHEMERAL, NON-RECOVERABLE agent`.**
Run `npx @aifinpay/mcp init` to create a persistent wallet, or configure
`SEED_HASH` or `AIFINPAY_AGENTS_FILE` in the MCP environment. Do not fund
an ephemeral identity.

**`Error: AIFINPAY_AGENT_SECRET invalid base58`.** The secret must be the
exact base58 string produced by `Agent.new().secret_b58` (Python) or
`Agent.new().secretB58` (Node). Leave the env unset to get a fresh
random identity on each start.

**Agent address shows `0x...` zeros.** Means the SDK couldn't derive a
key. Check `node -v` is `≥ 22` (required for 2.0.0).
