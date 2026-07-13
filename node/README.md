# @aifinpay/agent (Node / TypeScript)

Non-custodial x402 payment client for autonomous AI agents on
[AiFinPay](https://aifinpay.io).

The Ed25519 keypair is generated locally with `tweetnacl` and never leaves
your process. The SDK only sends a one-time SHA-256 + Ed25519 signature in
the `x-signature` header to authenticate against AiFinPay-protected endpoints.

## Install

```bash
# install (latest)
npm install @aifinpay/agent
# or pnpm add @aifinpay/agent
# or yarn add @aifinpay/agent

# stable (when 1.0 ships)
npm install @aifinpay/agent
```

## Quick start

```ts
import { Agent } from "@aifinpay/agent";

// Generate a fresh keypair locally — never transmitted
const agent = Agent.new();
console.log("Fund this address:", agent.address);
console.log("Save this secret:", agent.secretB58); // store securely!

// Wait until the wallet has at least $0.01 worth on-chain
await agent.waitForFunding({ minUsdCents: 1 });

// Request an invoice for a Seat (USDC on Solana)
const invoice = await agent.reserveSeatInvoice({
  amountUsd: 1.0,
  asset: "USDC",
});
// Build + sign + submit the on-chain tx with @solana/web3.js or viem.
// `invoice.raw` has program_id, treasury_vault, mints, nonce, etc.

// Once the Seat is on-chain, gated endpoints just work:
const res = await agent.get("https://aifinpay.io/api/stats");
console.log(await res.json());
```

## Loading an existing keypair

```ts
// from solana-keygen JSON file (Node only)
const agent = await Agent.fromKeypairFile("./agent-wallet.json");

// from base58 secret string (works in browser too)
const agent2 = Agent.fromSecretB58("3RvZm7Gw...");
```

## Client attribution (AIFP-1)

Optionally self-declare which framework the agent runs under. When set,
every HTTP request the SDK makes — the x402 flow (initial request + paid
retry) and AiFinPay API calls (quote/pay/invoice/…) — carries the header
`AIFP-Agent-Framework: <value>`.

```ts
const agent = Agent.new({ framework: "claude" });
```

| Option | Type | Default | Notes |
|---|---|---|---|
| `framework` | `string?` | *(unset — header absent)* | Well-known values: `chatgpt`, `claude`, `perplexity`, `gemini`, `cursor`, `openai-agents`, `windsurf`, `custom`. Any token matching `[a-z0-9-]{1,32}` is accepted; input is lowercased. |

There is **no default** — the header is only sent when you declare it
(honest self-declaration, not fingerprinting).

## How x402 auth works under the hood

For every gated request the SDK:

1. `GET /nonce` → receives a one-time UUID with 60s TTL.
2. computes `SHA-256("AiFinPay-x402:{nonce}:{pubkey}")`.
3. signs with Ed25519, base58-encodes the signature.
4. retries the original request with headers:
   - `x-agent-pubkey: <base58 pubkey>`
   - `x-nonce: <uuid>`
   - `x-signature: <base58 sig>`

The server verifies the signature, checks the agent has a live Seat PDA
on-chain, and serves the resource.

## Behind the AiFinPay gateway — emitting `AIFP-Billing`

If you're a **merchant** whose API runs behind the hosted gateway
(`gateway.aifinpay.io/{slug}/…`), the gateway meters billing units and signs
a per-action Billing Receipt for the agent. Describe each action with one
response header:

```js
import { withBilling } from "@aifinpay/agent";

app.use(withBilling()); // attaches res.setAifpBilling(meta)
app.post("/deep-research", (req, res) => {
  res.setAifpBilling({ action: "deep_research", cost_units: 10 });
  res.json(report);
});
```

`action` is required; `cost_units` is an informational hint (the gateway's
action registry weight is the billing authority); `category`,
`execution_time_ms`, `bytes`, `tokens`, `status` are optional telemetry.
Outside Express, use `billingHeader(meta)` to build the raw header value.
Full reference: [`examples/gateway-merchant`](../examples/gateway-merchant).

## Privacy

- **The server never sees your private key.** Period.
- Nonces are consumed on use; replay-resistant.
- All transactions are public and on-chain — Solana + Polygon mainnet.

## License

MIT.
