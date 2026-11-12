## gcore-x402-bridge

x402 paid-proxy bridge in front of
[Gcore Everywhere Inference](https://gcore.com/cloud/ai-ml) —
edge-deployed LLM inference across 180+ PoPs, OpenAI-compatible API.
Same Polygon settlement flow as `io-net-x402-bridge`: agent calls
`B2BSplitter.payMatic(merchant, address(0), orderId)`, bridge verifies
the receipt + `Payment` event via viem, forwards to Gcore using the
bridge operator's pooled API key.

### Why Everywhere Inference (and not Cloud VMs)

For per-call autonomous-agent workloads the right Gcore product is
**Everywhere Inference** — the managed deployment API (pay per token /
request, no GPU to manage). Cloud Bare-Metal / GPU Virtual is for
multi-hour reserved capacity; doesn't fit per-HTTP-request billing.

### Pre-flight: provision a deployment

Gcore Inference uses per-deployment endpoints, not a single global URL.
Before the bridge can route traffic, the operator pre-provisions ONE
model deployment via:

```bash
# 1. List the model catalog
curl -H "Authorization: APIKey $GCORE_API_KEY" \
  https://api.gcore.com/cloud/v3/inference/catalog/models

# 2. Pick a model and create a deployment
curl -X POST -H "Authorization: APIKey $GCORE_API_KEY" \
  -H 'content-type: application/json' \
  -d '{
    "name": "aifinpay-pilot",
    "image": "meta-llama/Llama-3.3-70B-Instruct",
    "flavor_name": "inference-1xL40s-24vcpu-180gb",
    "region_id": <pick from /v3/inference/regions>,
    "auth_enabled": true,
    "containers": [{ "scale": { "min": 1, "max": 1 } }]
  }' \
  https://api.gcore.com/cloud/v3/inference/deployments

# 3. Grab the deployment's endpoint_url from the response
```

The deployment's URL looks like:
`https://aifinpay-pilot.inference.<region>.gcore.cloud/v1/chat/completions`

### Setup

The bridge has two modes — pick one:

**Single-model.** One deployment, fixed price for every call:

```bash
npm install
cp .env.example .env
# edit .env:
#   GCORE_API_URL=https://<your-deployment>.inference.<region>.gcore.cloud/v1/chat/completions
#   GCORE_API_KEY=<your Gcore API token>
#   BRIDGE_MERCHANT_WALLET=0x<your Polygon address>
```

**Multi-model (recommended).** Operator pre-provisions N deployments
(one per model), agent picks via the OpenAI `model` field in body, the
bridge routes + prices per-deployment:

```bash
# In .env:
#   GCORE_API_URL=          # leave blank
#   GCORE_DEPLOYMENTS=[{"model":"meta-llama/Llama-3.3-70B-Instruct","url":"https://...gcore.cloud/v1/chat/completions","price_wei":"250000000000000000","price_usdc_units":"25000"},{"model":"meta-llama/Llama-3.1-8B-Instruct","url":"https://...gcore.cloud/v1/chat/completions","price_wei":"100000000000000000","price_usdc_units":"10000"}]
```

In multi-model mode, requests with a `model` not in the config get 404
with the list of `available_models`. `GET /models` returns an
OpenAI-style catalog. `GET /` shows the bridge's current routing table.

### Run

```bash
node server.js
# → port 3004 by default (io-net uses 3003, exa 3001, venice 3002)
```

### Call it

```bash
# Initial — gets a 402 challenge with payment instructions
curl -X POST http://localhost:3004/chat/completions \
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
  provider: "gcore",
  body: {
    model: "meta-llama/Llama-3.3-70B-Instruct",
    messages: [{ role: "user", content: "Summarize x402 in 2 sentences" }],
  },
});

console.log(out.choices[0].message.content);
console.log("Tx:", out._receipt?.txHash);
```

### Pricing

Default `PRICE_WEI` is 0.25 POL (≈ $0.025) per call. Gcore Everywhere
Inference per-token pricing on Llama-3-70B class models is
~$0.001-0.005 per typical agent request, leaving 5-20× margin to cover
bridge ops and the protocol fee.

For dynamic per-request pricing, hit Gcore's
`POST /v3/inference/deployment-price-preview` before each call and pass
the result through the 402 challenge — see `../exa-x402-bridge` for the
matching pattern.

### Operator notes

The bridge holds Gcore's `GCORE_API_KEY` locally in env — it never
crosses the wire to the agent. Agents only see HTTP 402 challenges
and Polygon settlement instructions. AiFinPay never holds the key
either; the bridge runs on the partner's (or AiFinPay's) own
infrastructure.

If you also need to bill agents in USDC instead of POL, swap the
Splitter integration for `payStable` and update the 402 challenge
schema (one extra field). See `../io-net-x402-bridge` for the matching
pattern — it already does both flows.

### Auth scheme

Gcore default: `Authorization: APIKey <token>`. If your specific
deployment exposes OpenAI-style Bearer or `x-api-key` instead, override:

```bash
GCORE_AUTH_SCHEME=bearer    # uses Authorization: Bearer <token>
GCORE_AUTH_SCHEME=x-api-key # uses X-Api-Key: <token>
```
