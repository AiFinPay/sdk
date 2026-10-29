# exa-x402-bridge

Reference paid-proxy bridge in front of [Exa AI](https://exa.ai/) `/search` —
the canonical example of how to plug a pay-per-call API into AiFinPay.

The bridge gates upstream calls behind an on-chain settlement to the
`B2BSplitter` contract selected in [server.js](server.js): the agent's payment is split atomically — 98.99% to the
bridge's merchant wallet, 1.00% to the AiFinPay treasury, 0.01% to a
creator/referral slot — in a single transaction. The bridge then
forwards the request to Exa using its own pooled API key and returns
the result.

The same pattern works for **any** paid third-party API — Venice AI,
Nansen, Cloudflare AI, anything with a price-per-call model. Copy this
folder, change `EXA_API_URL`, the API-key header, and `PRICE_WEI`.

> **Where the chain comes in**: inspect the bridge configuration and
> [deployment registry](../../deployments/registry/splitter/INDEX.md) for the
> selected network and deployment. Verify runtime and receipt support before
> sending funds; this example does not establish production readiness or
> availability of another chain.

## Wire flow

```
agent                               bridge                       exa.ai
  │  POST /search {query}             │                              │
  ├──────────────────────────────────►│                              │
  │  402  pay_with_split + order_id   │                              │
  │◄──────────────────────────────────┤                              │
  │                                   │                              │
  │  AiFinPaySplitter.b2bPayWithSplit │                              │
  │  (Polygon mainnet)                │                              │
  │  merchantAmount + 1.01% fee       │                              │
  ├──── tx ──────────────────────────►│ B2BPaymentWithSplit event    │
  │   tx hash                         │                              │
  │◄──── confirmation                 │                              │
  │                                   │                              │
  │  POST /search {query}             │                              │
  │  x-tx-hash + x-order-id           │                              │
  ├──────────────────────────────────►│  viem getTransactionReceipt  │
  │                                   │  parse + verify event        │
  │                                   │  ──── x-api-key ────────────►│
  │                                   │◄──── results ────────────────┤
  │  200 + Exa results                │                              │
  │◄──────────────────────────────────┤                              │
```

## Setup

```bash
npm install

# Required env
export EXA_API_KEY="exa_live_..."          # your Exa API key (free tier ok)
export BRIDGE_MERCHANT_WALLET="0x..."      # Polygon EOA the bridge collects to
export AGENT_PRIVATE_KEY="0x..."           # Polygon EOA the demo agent pays from

# Optional
export PRICE_WEI="5000000000000000"        # 0.005 MATIC merchant amount (default)
export POLYGON_RPC="https://polygon.drpc.org"
export PORT="3001"
```

The agent EOA needs ≥ ~0.01 MATIC: `merchantAmount + 1.01% + gas`.
At 0.005 MATIC merchant + 1.01% on top + ~0.001 MATIC gas, ≈ 0.006-0.007
MATIC per search call.

## Run the bridge

```bash
node server.js
# [exa-x402-bridge] x402 paid-proxy bridge on port 3001
#   Upstream:    https://api.exa.ai/search
#   Splitter:    <address from the running bridge configuration>
#   Merchant:    0x...
#   Price:       5000000000000000 wei (~0.005000 MATIC) merchant amount, +1.01% fee on top
```

## Run the demo client

```bash
node test-client.js "autonomous AI commerce on Polygon"
```

Expected:

```
[client] agent EOA: 0x...
[client] POST http://localhost:3001/search { query: "autonomous AI commerce on Polygon" }
[client] received 402 — order_id=exa-... merchant=0x...
[client] merchant_amount=5000000000000000 wei  total=5050500000000000 wei (0.0050505 MATIC)
[client] submitting AiFinPaySplitter.b2bPayWithSplit(...) on Polygon...
[client] tx submitted: 0xabc...
[client] explorer: https://polygonscan.com/tx/0xabc...
[client] tx success in block 12345678, gas 89000
[client] retrying /search with x-tx-hash + x-order-id...
[client] x-payment-receipt: {"paid_by":"0x...","merchant_amount_wei":"5000000000000000",...}

=== Exa results ===
{ "results": [ ... ] }
```

## How verification works

On the retry, the bridge:

1. Looks up `x-order-id` in its in-memory pending-orders table; if absent or
   expired, returns 409.
2. Fetches the tx receipt via viem and checks `receipt.status === "success"`
   and `receipt.to === SPLITTER_ADDRESS`.
3. Parses `B2BPaymentWithSplit` event from the logs (
   `agent`, `merchant`, `merchantAmount`, `treasuryFee`, `ipCreatorFee`,
   `feeRecipient`, `orderId`).
4. Verifies `event.merchant === BRIDGE_MERCHANT_WALLET`,
   `event.merchantAmount >= PRICE_WEI`, and `event.orderId` matches.
5. Records the tx hash in a replay-protection set so the same tx can't be
   reused.
6. Forwards the request to upstream Exa with the bridge's `x-api-key` and
   relays the response, attaching an `x-payment-receipt` header.

## Adapting for other services

This bridge is the template. To stand up Venice AI / Nansen / etc:

| Knob              | Where           | Example for Venice AI              |
|-------------------|-----------------|-----------------------------------|
| `EXA_API_URL`     | env             | `https://api.venice.ai/api/v1/...` |
| Auth header       | `server.js`     | `authorization: Bearer ${KEY}`     |
| `PRICE_WEI`       | env             | adjust to per-call cost            |
| Endpoint path     | `app.post(...)` | `/inference`, `/analytics`, etc.   |

Everything else (402 challenge, Splitter verification, replay cache, fee math)
stays identical.

## Production checklist (deferred for the pilot)

- Replace in-memory `pendingOrders` and `consumedTxs` with Redis (so the
  bridge survives restarts and scales horizontally).
- Bind `query` to `order_id` so an agent can't pay for `weather` and use
  the receipt for `bitcoin price`.
- Confirm tx finality (`waitForTransactionReceipt({ confirmations: 5 })`)
  before forwarding — the demo accepts inclusion only, which is fine for
  Polygon's 2s blocks but not for high-value flows.
- Rate-limit `/search` per agent EOA at the bridge layer so a buggy client
  can't burn its MATIC in a tight retry loop.
- Move `EXA_API_KEY` to a secret manager (Doppler / 1Password CLI / etc.)
  rather than env file.
