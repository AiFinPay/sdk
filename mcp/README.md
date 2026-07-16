# @aifinpay/mcp

MCP server exposing AiFinPay's autonomous x402 payment loop as
agent-callable tools. Drop it into Claude Desktop, MCP Inspector, or any
MCP-aware agent runtime — your agent can now buy services autonomously.

Canonical domain: **aifinpay.io** (the legacy `aifinpay.company` host is
retired — ignore any docs pointing there). SDK settlement runs on
**Polygon (default) and Solana**; the protocol itself is live across 12
networks — see [aifinpay.io/llms.txt](https://aifinpay.io/llms.txt).

## Tools

| Tool | What it does |
|---|---|
| `payable_fetch(url, opts?)` | Fetch any URL. On 402, auto-detect facilitator, sign, retry. |
| `agent_address()` | Return the agent's funding addresses on **both** chains — Polygon `0x…` (default settlement: io.net, Exa, Venice bridges) and Solana base58 (Seat PDA / leaderboard). One seed, two chains — fund either. |
| `agent_quote(url)` | Inspect a 402 challenge without paying. Shows the merchant's quoted amount + facilitator flavor. |

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
        "AIFINPAY_AGENT_SECRET": "<base58 secret — see below>",
        "AIFINPAY_MAX_USD": "0.50"
      }
    }
  }
}
```

Restart Claude Desktop. Now Claude can call `payable_fetch`, `agent_address`,
and `agent_quote` like any other tool.

## First run — generating an agent

If `AIFINPAY_AGENT_SECRET` is not set, the server generates an ephemeral
keypair and **prints it to stderr** at startup:

```
[warn] no AIFINPAY_AGENT_SECRET set — generated EPHEMERAL agent.
  address: 9HucVaL5yinJ4MfBKCFnz5QJBGwK33bfSQKw15pSe3Ch
  secret:  2vfeWAYfkpTNGSgDpBonzmjkckrTKa5GTnhhztY141YcSKYrqCvtojVukQAQiJbbRLgdcfEdyqHbRMsUft6Pb7nD
  >> Save this secret to AIFINPAY_AGENT_SECRET to keep the agent across restarts.
```

Save the secret to `AIFINPAY_AGENT_SECRET` in your client config so the
agent identity (and any funded Seat) persists across restarts.

## Environment variables

| Var | Default | Purpose |
|---|---|---|
| `AIFINPAY_AGENT_SECRET` | — | Base58 secret. If absent → ephemeral agent printed to stderr. |
| `AIFINPAY_BASE_URL` | `https://aifinpay.io` | Backend URL for nonce + funding probes. |
| `AIFINPAY_TIMEOUT_MS` | `30000` | Request timeout. |
| `AIFINPAY_MAX_USD` | — | Hard cap per single payment. Strongly recommended. |

## Programmatic use

```ts
import { createServer, loadConfigFromEnv } from "@aifinpay/mcp";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const { server } = await createServer({
  ...loadConfigFromEnv(),
  agentSecretB58: "your-secret-here",
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

The flow is identical to calling `agent.pay(url)` directly — this
package just wraps it as an MCP tool surface so LLM agents can call it
without writing payment code.

## License

MIT.
