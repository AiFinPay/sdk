# AiFinPay examples

Reference integrations you can copy and adapt. Each example pins its own
dependencies in its own folder. CI only parses the bridges' `server.js` and
`store.js` files; it does not install or run any example, and the Python
examples are not checked. Read the known issues below before you rely on one.

The Python framework examples pay through `AiFinPayAgent.fetch_paid`. They
need the owner's wallet as `SEED_HASH` and the owner's limits as
`AIFINPAY_GATEWAY_ORIGINS`, `AIFINPAY_MAX_USD` and `AIFINPAY_DAILY_USD` (the
names `@aifinpay/mcp` uses), and refuse to start without them.

## Agent framework integrations

| Example | What it shows | Stack |
|---|---|---|
| [`openai-agent`](./openai-agent) | OpenAI tool-calling loop with a `payable_fetch(url)` tool built on `AiFinPayAgent.fetch_paid` (AIFP-1, Polygon v1.4, owner limits from the environment) | Python 3.9+, `openai` |
| [`langchain`](./langchain) | The same `payable_fetch` tool as a LangChain `BaseTool` | Python 3.9+, LangChain |
| [`crewai`](./crewai) | Two-agent crew whose Researcher reads paid sources with `payable_fetch` | Python 3.10+, CrewAI |
| [`flowise`](./flowise) | Flowise custom tool JSON + import instructions | Flowise (Node), `@aifinpay/agent` |
| [`autogpt`](./autogpt) | Headless loop that reads a paid resource on a schedule and stops at the owner's 24-hour limit | Python 3.9+, `openai` |
| [`claude-mcp`](./claude-mcp) | Claude Desktop MCP config + walkthrough | MCP client |

## Bridge templates (legacy splitter)

These bridges sell per-call access by having the agent pay the legacy
Polygon B2BSplitter (`0xbD1fa545…`, or the older `0xE34Fc0E6…` in
`_generic-x402-bridge`), which splits 98.99% / 1.00% / 0.01% (merchant /
treasury / creator). That is not the AIFP-1 v1.4 model (merchant 99% /
AiFinPay 1% of the gross), and the released agent clients do not pay it. To
put a new API behind AIFP-1, use [`@aifinpay/gate`](../gate) (Node) or
[`aifinpay-gate`](../python-gate) (Python) instead.

| Example | What it shows | Stack |
|---|---|---|
| [`echo-x402-server`](./echo-x402-server) | Seat-gated echo API using the retired v1 native-auth message (`AiFinPay-x402:{nonce}:{pubkey}`) and `GET /api/seat/:pubkey`. ~170 lines of Express. | Node 22+, Express |
| [`exa-x402-bridge`](./exa-x402-bridge) | Per-call paid bridge for [Exa AI](https://exa.ai/) `/search`. | Node 22+, Express, viem |
| [`venice-x402-bridge`](./venice-x402-bridge) | Same template applied to [Venice AI](https://venice.ai) `/chat/completions`. | Node 22+, Express, viem |
| [`io-net-x402-bridge`](./io-net-x402-bridge) | Bridge for the io.net inference API | Node 22+, Express, viem |
| [`gcore-x402-bridge`](./gcore-x402-bridge) | Bridge for the GCore inference API | Node 22+, Express, viem |
| [`_generic-x402-bridge`](./_generic-x402-bridge) | Minimal template to fork for a new service | Node 22+, Express, viem |

## Utilities

| Example | What it shows | Stack |
|---|---|---|
| [`agent-snippets`](./agent-snippets) | **Payer-side copy-paste snippets**: wallet create/load → `setBudget` (Node) → paid call | Node 22+ / Python 3.9+ |
| [`new-wallet`](./new-wallet) | One-shot EVM wallet generator (viem) and backup workflow | Node 22+ |

PRs welcome — open one against `main`.

## Known issues

These are problems in the example code, not in the SDKs.

- `echo-x402-server` and `gcore-x402-bridge` have no `package-lock.json`, so
  `npm ci` refuses to install them; use `npm install` in those two folders.
- `_generic-x402-bridge` is written against the retired v1.1 splitter
  (`0xE34Fc0E6…`): its 402 asks for `payMatic(address,address,string)` and its
  verifier decodes a `Payment` event without `paymentId`. Pointing it at the
  v1.2 splitter the other bridges use takes porting those too (see
  `exa-x402-bridge`); changing the address alone makes every payment fail
  verification.

## Quick start (echo-x402-server — seat-gated echo)

```bash
cd echo-x402-server && npm install --no-audit --no-fund && node server.js
# → x402-gated API on port 3000

node test-client.js  # in another shell
```

## Quick start (exa-x402-bridge — per-call Polygon settlement, legacy splitter)

```bash
cd exa-x402-bridge && npm ci --no-audit --no-fund
# The bridge refuses to start without shared Redis; ALLOW_MEMORY_STORE=1 is for a local dev run only.
EXA_API_KEY=...  BRIDGE_MERCHANT_WALLET=0x...  ALLOW_MEMORY_STORE=1  node server.js
# → paid proxy on port 3001

# Demo client — submits a real Polygon tx
AGENT_PRIVATE_KEY=0x...  node test-client.js "autonomous AI commerce"
```

See each example's README for detailed setup and environment variables.
