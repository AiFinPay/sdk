## io-net-x402-bridge

x402 paid-proxy bridge in front of [io.net IO Intelligence](https://io.net)
(managed LLM inference on io.net's GPU pool). OpenAI-compatible body —
drop in any client that already speaks `chat/completions`.

Same architecture as [`../venice-x402-bridge`](../venice-x402-bridge):
agent calls `B2BSplitter.payMatic(merchant, address(0), orderId)` on
Polygon, bridge verifies the receipt and `Payment` event via viem,
then forwards to io.net using the bridge operator's pooled API key.

### Why io.intelligence (and not io.cloud)

For per-call autonomous-agent workloads the right io.net product is
**IO Intelligence** — the managed inference API (pay per token, no GPU
to manage). `io.cloud` is raw VM rental; it doesn't fit the x402-per-call
model because there's no per-HTTP-request billing surface.

### Setup

```bash
npm install
cp .env.example .env
# edit .env — set IONET_API_KEY + BRIDGE_MERCHANT_WALLET
```

### Run

```bash
node server.js
# → port 3003 by default
```

### Call it

```bash
# Initial — gets a 402 challenge with payment instructions
curl -X POST http://localhost:3003/chat/completions \
  -H 'content-type: application/json' \
  -d '{"model":"meta-llama/Llama-3.3-70B-Instruct","messages":[{"role":"user","content":"hi"}]}'

# Then pay via Splitter on Polygon and retry with x-tx-hash + x-order-id
# (use ../exa-x402-bridge/test-client.js as a template — change endpoint
#  and body, the payment flow is identical)
```

### From `@aifinpay/agent` SDK

Once the bridge is registered in the central provider catalog
(`services.json` on the operator's backend), agents call it with one
line:

```ts
import { AiFinPayAgent } from "@aifinpay/agent";

const agent = new AiFinPayAgent({ privateKey: process.env.AGENT_PK });

const out = await agent.call({
  provider: "io-net",
  body: {
    model: "meta-llama/Llama-3.3-70B-Instruct",
    messages: [{ role: "user", content: "Summarize x402 in 2 sentences" }],
  },
});

console.log(out.choices[0].message.content);
console.log("Tx:", out._receipt?.txHash);
```

### Pricing

Default `PRICE_WEI` is 0.25 POL (≈ $0.025) per call. IO Intelligence
per-token pricing on Llama-3-70B class models is ~$0.001-0.005 per
typical agent request, leaving 5-20× margin to cover bridge ops and
the protocol fee.

Adjust `PRICE_WEI` for heavier models (Llama-3.1-405B, Mixtral-8x22B)
or higher-token contexts.

### Operator notes

The bridge holds io.net's `IONET_API_KEY` locally in env — it never
crosses the wire to the agent. Agents only see HTTP 402 challenges
and Polygon settlement instructions. AiFinPay never holds the key
either; the bridge runs on the partner's (or AiFinPay's) own
infrastructure.

If you also need to bill agents in USDC instead of POL, swap the
Splitter integration for `payErc20` and update the 402 challenge
schema (one extra field). See `../exa-x402-bridge` for the matching
pattern.
