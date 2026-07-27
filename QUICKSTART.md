# QUICKSTART — first paid call in 60 seconds

This walks you from a clean machine to your first verified on-chain
payment via the AiFinPay SDK. No KYC, no API key, no custodian.

There are three paths. Pick whichever matches what you're building:

1. **Python or Node SDK** — programmatic use from your own agent code.
2. **Claude Desktop / Cursor (MCP)** — zero-code; the LLM gets payment
   tools automatically.
3. **Framework adapter** (LangChain, CrewAI, OpenAI Agents, AutoGPT…) —
   plug `agent.pay()` into your existing pipeline.

## Path 1 — Python SDK

```bash
pip install aifinpay-agent
```

```python
import secrets
from aifinpay import AiFinPayAgent

# ONE seed → both addresses, deterministically. Back up this seed and you can
# restore the same Solana AND EVM address on any machine.
#
# `AiFinPayAgent.new()` also works and is now equally recoverable — it derives
# both keys from a random seed. Starting from an explicit seed just makes the
# backup artifact obvious.
seed = secrets.token_hex(32)
print("BACK UP THIS SEED — it is the only way to recover the wallet:", seed)

agent = AiFinPayAgent.from_seed(seed)     # later: AiFinPayAgent.from_seed(seed)
print("Fund THIS address (USDC or POL on Polygon):", agent.evm_address)
print("Solana id (leaderboard / Seat PDA):        ", agent.solana_address)

# Once the EVM address is funded, this autonomously settles the 402 challenge
# on-chain and returns the gated body. `provider` is a registry slug — no
# hardcoded bridge URL.
resp = agent.call("io-net", {
    "model": "meta-llama/Llama-3.3-70B-Instruct",
    "messages": [{"role": "user", "content": "Hello"}],
})
print(resp.json()["choices"][0]["message"]["content"])
print("receipt:", resp.headers.get("x-payment-receipt"))
```

## Path 2 — Node / TypeScript SDK

```bash
npm install @aifinpay/agent
```

```ts
import { randomBytes } from "node:crypto";
import { AiFinPayAgent } from "@aifinpay/agent";

// ONE seed → both addresses, deterministically. Back up this seed and you can
// restore the same Solana AND EVM address on any machine.
//
// `AiFinPayAgent.new()` also works and is now equally recoverable — it derives
// both keys from a random seed. Starting from an explicit seed just makes the
// backup artifact obvious.
const seed = randomBytes(32).toString("hex");
console.log("BACK UP THIS SEED — it is the only way to recover the wallet:", seed);

const agent = await AiFinPayAgent.fromSeed(seed);   // later: fromSeed(seed)
console.log("Fund THIS address (USDC or POL on Polygon):", agent.evmAddress);
console.log("Solana id (leaderboard / Seat PDA):        ", agent.solanaAddress);

// `provider` is a registry slug — no hardcoded bridge URL. Returns null if a
// budget cap is hit before paying.
const res = await agent.call({
  provider: "io-net",
  body: { model: "meta-llama/Llama-3.3-70B-Instruct",
          messages: [{ role: "user", content: "Hello" }] },
});
if (!res) throw new Error("budget cap hit before paying");
const data = await res.json();
console.log(data.choices[0].message.content);
```

## Path 3 — MCP (Claude Desktop / Cursor / Windsurf)

Drop this into `claude_desktop_config.json` (or your client's MCP
config):

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

Restart the client and ask: *"What's your wallet address?"* — the
`agent_address` tool returns it. Fund it. Then ask: *"Pay the io.net
bridge for a one-line completion."* — the model handles the rest.

Full client matrix in [`MCP_CONFIG.md`](./MCP_CONFIG.md).

## Path 4 — agent frameworks

Working examples for each framework live under
[`./examples/`](./examples). Each is a single file, paste-and-run:

- [`examples/openai-agent`](./examples/openai-agent) — OpenAI Agents SDK
- [`examples/langchain`](./examples/langchain) — LangChain `BaseTool`
- [`examples/crewai`](./examples/crewai) — CrewAI crew that buys
  inference + search calls
- [`examples/flowise`](./examples/flowise) — Flowise custom node
- [`examples/autogpt`](./examples/autogpt) — headless self-funding loop

## How a payment actually settles

1. Your code calls `agent.call({ provider })` (or `agent.pay(url)` on the
   legacy `Agent`).
2. The server returns **HTTP 402** with a JSON `accepts[]` block (or our
   `pay_matic` block). It lists: chain, asset, payTo, amount,
   `nonce`.
3. The SDK signs an Ed25519 challenge (Solana-style identity) or
   submits a `payMatic`/`payStable` tx on Polygon, depending on what the
   server accepts.
4. The SDK retries the request with the proof header(s).
5. The server verifies on-chain (via the Polygon facilitator or our
   indexer), forwards to the upstream service, and returns the
   response.

You see one function call. Under the hood: one tx on mainnet, atomic
99/1 split (merchant 98.99% / treasury 1% / IP-creator 0.01%), no
custodian holds funds at any point.

## What this is for

- **AI agents that need to buy compute / data / inference**, e.g. an
  autonomous research crew that pays per call to Exa, io.net, Venice.
- **Anyone with an existing API** who wants to charge per call — wrap
  it once with the [`echo-x402-server`](./examples/echo-x402-server)
  recipe and you have an x402-payable endpoint.
- **MCP-aware LLM clients** (Claude Desktop, Cursor, Windsurf…) that
  should be able to buy paid services without a hardcoded API key.

## What this is not

- Not a custodian. We never hold your agent's funds.
- Not a chain. Settlement is on Polygon and Solana mainnet.
- Not an investment. mSECCO is a non-transferable internal accounting
  unit.

## Live proofs (Polygonscan)

- First Exa search via SDK:
  [`0xeb13c5ed…59c8700`](https://polygonscan.com/tx/0xeb13c5ed59c8700)
- Llama-3.3-70B inference via io.net, $0.025:
  [`0x7c6ca0ff…129f0a`](https://polygonscan.com/tx/0x7c6ca0ff129f0a)

## Next

- Full API surface: [`https://aifinpay.io/docs`](https://aifinpay.io/docs)
- x402 discovery doc: [`https://api.aifinpay.io/.well-known/x402.json`](https://api.aifinpay.io/.well-known/x402.json)
- Issues / questions: [GitHub Issues](https://github.com/AiFinPay/sdk/issues)
