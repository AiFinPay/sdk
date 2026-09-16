# AiFinPay examples

Reference integrations you can copy and adapt. All examples work with the
stable **2.0.0** release.

## Agent framework integrations

| Example | What it shows | Stack |
|---|---|---|
| [`openai-agent`](./openai-agent) | OpenAI Agents SDK `Tool` that pays x402 endpoints | Node 22+, `@openai/agents` |
| [`langchain`](./langchain) | LangChain `BaseTool` wrapping `agent.call()` | Node 22+, LangChain |
| [`crewai`](./crewai) | CrewAI crew that buys inference + search calls | Node 22+, CrewAI |
| [`flowise`](./flowise) | Flowise custom node JSON + import instructions | Node 22+, Flowise |
| [`autogpt`](./autogpt) | Headless self-funding agent loop | Node 22+, AutoGPT |
| [`claude-mcp`](./claude-mcp) | Claude Desktop MCP config + walkthrough | MCP client |

## Live bridge templates

| Example | What it shows | Stack |
|---|---|---|
| [`echo-x402-server`](./echo-x402-server) | Smallest possible **AiFinPay-gated API** in prepaid access mode. ~70 lines of Express. | Node 22+, Express |
| [`exa-x402-bridge`](./exa-x402-bridge) | **Per-call paid bridge** for [Exa AI](https://exa.ai/) `/search`. Default template for any pay-per-call API. | Node 22+, Express, viem |
| [`venice-x402-bridge`](./venice-x402-bridge) | Same template applied to [Venice AI](https://venice.ai) `/chat/completions`. | Node 22+, Express, viem |
| [`io-net-x402-bridge`](./io-net-x402-bridge) | Production bridge for io.net inference API | Node 22+, Express, viem |
| [`gcore-x402-bridge`](./gcore-x402-bridge) | Production bridge for GCore inference API | Node 22+, Express, viem |
| [`_generic-x402-bridge`](./_generic-x402-bridge) | Minimal template to fork for a new service | Node 22+, Express, viem |

## Utilities

| Example | What it shows | Stack |
|---|---|---|
| [`agent-snippets`](./agent-snippets) | **Payer-side copy-paste snippets**: wallet create/load → `setBudget` → paid call | Node 22+ / Python 3.9+ |
| [`new-wallet`](./new-wallet) | Wallet creation and backup workflow | Node 22+ |

PRs welcome — open one against `main`.

## Quick start (echo-x402-server — prepaid access gate)

```bash
cd echo-x402-server && npm ci --no-audit --no-fund && node server.js
# → x402-gated API on port 3000

node test-client.js  # in another shell
```

## Quick start (exa-x402-bridge — per-call Polygon settlement)

```bash
cd exa-x402-bridge && npm ci --no-audit --no-fund
EXA_API_KEY=...  BRIDGE_MERCHANT_WALLET=0x...  node server.js
# → paid proxy on port 3001

# Demo client — submits a real Polygon tx
AGENT_PRIVATE_KEY=0x...  node test-client.js "autonomous AI commerce"
```

See each example's README for detailed setup and environment variables.
All examples require Node 22+ unless noted.
