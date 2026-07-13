# AiFinPay examples

Reference integrations you can copy and adapt.

| Example | What it shows | Stack |
|---|---|---|
| [`echo-x402-server`](./echo-x402-server) | Smallest possible **AiFinPay-gated API** in the pre-paid access mode (agent stakes once, gets unlimited gated calls). ~70 lines of Express. | Node 18+, Express |
| [`exa-x402-bridge`](./exa-x402-bridge) | **Per-call paid bridge** in front of [Exa AI](https://exa.ai/) `/search`. Default integration template — verifies an on-chain splitter payment before forwarding. The same code is reusable for any pay-per-call API. | Node 18+, Express, viem |
| [`venice-x402-bridge`](./venice-x402-bridge) | Same template applied to [Venice AI](https://venice.ai) `/chat/completions`. Demonstrates how to fork the bridge for a new service in ~5 minutes (three knob changes). | Node 18+, Express, viem |
| [`gateway-merchant`](./gateway-merchant) | Merchant API **behind the AiFinPay hosted gateway** — emits the `AIFP-Billing` response header per named action (`search` = 1 unit, `deep_research` = 10) so the gateway can sign per-action Billing Receipts. No wallet, no x402 handshake merchant-side. | Node 18+, Express |

More coming as we build them. PRs welcome — open one against `main`.

## Quick start (echo-x402-server — Seat-PDA gate)

```bash
cd echo-x402-server && npm install && node server.js
# → x402-gated API on port 3000

node test-client.js  # in another shell
```

## Quick start (exa-x402-bridge — per-call Polygon settlement)

```bash
cd exa-x402-bridge && npm install
EXA_API_KEY=...  BRIDGE_MERCHANT_WALLET=0x...  node server.js
# → paid proxy on port 3001

# Demo client — submits a real Polygon tx
AGENT_PRIVATE_KEY=0x...  node test-client.js "autonomous AI commerce"
```
