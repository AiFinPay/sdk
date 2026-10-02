# Partner onboarding — run a paid x402 bridge for AI agents

Stand up a paid bridge for your API and let autonomous AI agents buy your
service per call. AiFinPay is payment infrastructure for AI agents: it
handles the payment rail, the agent identity, and the SDK on the buyer
side; you keep the API key and the upstream relationship.

The protocol fee is collected automatically by an on-chain splitter — no
revenue-share bookkeeping, no contracts to sign, no custodial arrangement.

> **Status — read first.** This guide describes the reference **bridge**
> examples in [`examples/`](./examples) (`exa-x402-bridge` and its
> siblings). They settle on Polygon through the **legacy v1.2
> `B2BSplitter`** with the older 98.99% / 1.00% / 0.01% split shown below.
> Current AIFP-1 economics are gross-inclusive: merchant **99%**, AiFinPay
> **1%**, creator **0%**, settled on v1.4. To monetize your own site or API
> under those terms, use the merchant gate instead —
> [`@aifinpay/gate`](./gate/README.md) (Node) or
> [`aifinpay-gate`](./python-gate/README.md) (Python). Solana settlement is
> disabled in the current deployment registry.

## What you need from your side

| Item | Why |
|------|-----|
| 0x Polygon address (EOA or Safe) | Where your per-call revenue lands. Use a Safe for production — once funded, you own that wallet, not us. |
| Your API key for the upstream service | The bridge uses **your** key when forwarding paid requests. AiFinPay never sees it again — set it as an env var on your bridge host. |
| A box to run the bridge on | One Node service (`examples/exa-x402-bridge/server.js`) plus Redis; runs on a small VPS or any container platform. We can host for the pilot if you don't want to. |
| A unit price | What you charge agents per call, in USD (`PRICE_USD`). The bridge converts it to POL at quote time from the AiFinPay price feed. |

## What you do not need

- Crypto integration in your existing stack — the bridge is in front of your unchanged API.
- A wallet for your end users — your customers are AI agents, not humans, and they bring their own keypair via the AiFinPay SDK.
- Compliance / KYC — non-custodial. Funds settle on-chain in the splitter contract.
- A subscription contract or revenue-share agreement — protocol fee is hard-coded in the splitter, automatically routed.

## Step-by-step

### 1. Fork the example

```bash
git clone https://github.com/AiFinPay/sdk.git
cd sdk/examples
cp -r exa-x402-bridge mybrand-x402-bridge
cd mybrand-x402-bridge
```

### 2. Change three knobs in `server.js`

| Knob | Default | Your value |
|------|---------|-----------|
| `EXA_API_URL` env | `https://api.exa.ai/search` | Your upstream API endpoint |
| Auth header in upstream `fetch` call | `"x-api-key": EXA_API_KEY` | Whatever your service expects (`Authorization: Bearer …`, etc.) |
| `PRICE_USD` env | `0.0105` | Your per-call price in USD. `PRICE_WEI` pins an exact POL amount and is meant for tests only. |

That's it. The 402 challenge, on-chain verification, replay protection,
request binding, rate limiting, and Polygon-side splitter integration are
unchanged.

### 3. Configure env

```bash
cp .env.example .env
# fill in:
#   EXA_API_KEY=...            (rename to your upstream's key variable)
#   BRIDGE_MERCHANT_WALLET=0xYourWallet
#   PRICE_USD=...
#   POLYGON_RPC=...
#   REDIS_URL=redis://...      (required; see below)
```

### 4. Run

```bash
npm ci
node server.js
```

The bridge refuses to start without `REDIS_URL`: orders and spent
transactions must survive a restart. `ALLOW_MEMORY_STORE=1` runs it with an
in-memory store for a local, single-process test only.

Behind nginx / Caddy / fly.io / Railway / wherever. The bridge is a
plain HTTP service, no special infra.

### 5. Tell us your service

Ask the AiFinPay team to add your service to the provider registry
(`backend/services.json` in the AiFinPay backend). Entries are keyed by a
slug:

```json
"yourservice": {
  "name": "yourservice",
  "display_name": "Your Service",
  "url": "https://yourservice.com",
  "logo": "yourservice",
  "service_type": "search | inference | compute | analytics | tools | data",
  "tagline": "One-line value proposition",
  "modes": {
    "bridge": {
      "bridge_url": "https://your-bridge.example",
      "chain": "polygon",
      "merchant_wallet": "0xYourWallet",
      "price_usd": 0.0105
    }
  }
}
```

Once merged and redeployed, your service shows up on the AiFinPay public
dashboard. Agents discover you via:

- The on-chain `Payment` events (canonical source)
- The public dashboard data at `/api/dashboard/public`
- The merchant lookup at `/api/partner/:wallet`

## What the on-chain split looks like

Every successful call generates exactly one `Payment` event on the
legacy v1.2 `B2BSplitter` the reference bridges use, at
[`0xbD1fa5453f212F096c0213788a645eC597FB4DDe`](https://polygonscan.com/address/0xbD1fa5453f212F096c0213788a645eC597FB4DDe)
(`SPLITTER_ADDRESS_POLYGON`). The earlier `0xE34Fc0E6…8440` splitter is
retired.

```
agent  ──msg.value──▶  B2BSplitter.payNative(paymentId, merchant, ipCreator, orderId)
                          │
                          ├──── 98.99% ────▶  YOUR merchant wallet
                          ├──── 1.00%  ────▶  AiFinPay treasury Safe
                          └──── 0.01%  ────▶  ipCreator (or treasury if 0x0)

emit Payment(payer, merchant, address(0), totalAmount,
             merchantAmount, treasuryAmount, ipCreatorAmount, orderId)
```

You don't deploy or upgrade any contract. You don't sign a partner
agreement on-chain. The protocol fee is structural — it exists because
every `payNative` call goes through the splitter, whose fee BPS are set
on-chain by the AiFinPay Safe.

## What you get for the 1% protocol fee

- Pre-built x402 SDKs in Python (`aifinpay-agent`) and Node
  (`@aifinpay/agent`), and an MCP server (`@aifinpay/mcp`).
- Discovery: appearance on the public dashboard and `aifinpay.io`
  marketplace pages.
- Identity: agents can carry an AiFinPay Agent Passport — an
  issuer-signed identity record with verified wallet bindings — that you
  can check without doing your own KYC.
- Webhooks for downstream events.
- Client-side x402 support in the SDKs: the AiFinPay-native flow in both,
  and the standard x402 `exact` (EIP-3009) flow in the Node SDK. The
  Coinbase-specific flavor is detected but not yet paid by either SDK.

## What the partner does NOT pay for

- Agents' onboarding — that's done in the `@aifinpay/agent` SDK.
- Network fees — paid by the agent submitting the tx.
- Refunds for upstream-service failures — the bridge already handles
  this: if your service returns 5xx, the bridge returns 502 to the
  agent and **does not consume** their payment, so they can retry with
  the same `x-tx-hash` for free.

## Production checklist

Before driving real volume through the bridge:

- [ ] Run against Redis (`REDIS_URL`). The bridge refuses to start
      without it unless `ALLOW_MEMORY_STORE=1`, which is for a local,
      single-process test only.
- [ ] Use a hardware-secured wallet or a Safe for `BRIDGE_MERCHANT_WALLET`.
      Don't reuse a CI/CD secret-rotated EOA.
- [ ] Move your upstream API key to a secret manager (1Password,
      Doppler, Vault) — the `.env` file is for development only.
- [ ] Rate-limit by Polygon EOA at the application layer (the bundled
      `express-rate-limit` is per-IP only, intended as anti-spam for the
      402 challenge step).
- [ ] Wait for ≥3 confirmations before forwarding to upstream if the
      service is high-value or the quote is volatile. The current
      bridge accepts inclusion only, which is fine for Polygon's 2s
      blocks but tighten if you need to.
- [ ] Monitor the bridge's `Payment` events (or our dashboard) — if you
      see your merchant wallet missing receipts, an agent paid but the
      bridge didn't deliver. That's a refund case.

## Questions / changes

- Architecture or pilot scoping: open an issue at
  `github.com/AiFinPay/sdk/issues`.
- Direct conversation with the team: telegram, x.com/aifinpay,
  linkedin/aifinpay.
