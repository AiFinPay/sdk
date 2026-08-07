# @aifinpay/agent (Node / TypeScript)

Non-custodial x402 payment client for autonomous AI agents on
[AiFinPay](https://aifinpay.io) — canonical domain **aifinpay.io** (the
legacy `aifinpay.company` host is retired). SDK settlement: since 1.3.0,
direct fee-on-top splitter settlement (`AiFinPayAgent.call()`) is enabled on
Polygon v1.2 (Safe-governed, native-token path), plus Solana;
Base/Optimism/Unichain/BOT Chain/XRPL EVM remain inventoried but are blocked
until v1.2, multisig governance and fresh registry evidence are complete;
the backend-quoted invoice flow (`/api/b2b/pay-with-split`) remains
Polygon + Solana. The protocol is live across 13 networks — see
[aifinpay.io/llms.txt](https://aifinpay.io/llms.txt).

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

Standard x402 EIP-3009 payment signing is intentionally fail-closed until a
signed AiFinPay target registry exists. A third-party 402 response cannot pick
an arbitrary token contract, `payTo`, EIP-712 domain or decimals and obtain a
wallet signature.

## Privacy

- **The server never sees your private key.** Period.
- Nonces are consumed on use; replay-resistant.
- All transactions are public and on-chain — Solana + Polygon mainnet.

## License

MIT.
