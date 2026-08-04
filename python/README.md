# aifinpay-agent (Python)

Non-custodial **multi-facilitator** x402 payment client for autonomous
AI agents on [AiFinPay](https://aifinpay.io) — canonical domain
**aifinpay.io** (the legacy `aifinpay.company` host is retired). SDK

Python 1.3.1 validates Polygon payment targets against the same canonical
address/codehash/governance/fee/merchant registry as the Node SDK. Missing or
stale registry data, RPC failures, empty code and server-selected legacy v1.1
routes fail before transaction signing.
settlement: Polygon (default) + Solana; the protocol is live across 13
networks — see [aifinpay.io/llms.txt](https://aifinpay.io/llms.txt).

`agent.pay(url)` works against:
- **AiFinPay** native flow (Solana Seat PDA + Ed25519)
- **Coinbase x402** spec — detection + parsing today; on-chain
  settlement coming in 0.3.x

The Ed25519 keypair is generated locally and never leaves your process.
The SDK auto-detects the facilitator flavor on a 402 response and builds
the right auth payload (three-headers for AiFinPay, base64
`PAYMENT-SIGNATURE` for Coinbase x402).

## Install

```bash
# install (latest)
pip install aifinpay-agent

# stable (when 1.0 ships)
pip install aifinpay-agent
```

## Quick start

```python
from aifinpay import Agent, PayOptions

# Generate a fresh keypair locally — never transmitted
agent = Agent.new()
print("Fund this address:", agent.address)
print("Save this secret:", agent.secret_b58)  # store securely!

# Wait until the wallet has at least $0.01 worth on-chain
agent.wait_for_funding(min_usd_cents=1)

# Request an invoice for a Seat (USDC on Solana)
invoice = agent.reserve_seat_invoice(amount_usd=1.00, asset="USDC")
print("Invoice:", invoice.raw)
# Build + sign + submit the Solana transaction with @solana/web3.js, anchorpy,
# or solana-py — the invoice contains program_id, treasury_vault, mints, etc.

# Generic x402 — auto-detects facilitator, signs, retries
resp = agent.pay("https://aifinpay.io/api/stats")
print(resp.json())

# Pay any third-party x402 endpoint (e.g. Coinbase x402-protected API)
resp = agent.pay(
    "https://api.example.com/v1/data",
    method="POST",
    json={"q": "hello"},
    options=PayOptions(max_amount_usd=0.10),  # refuse if cost > $0.10
)
```

## Loading an existing keypair

```python
# from solana-keygen JSON file
agent = Agent.from_keypair_file("~/agent-wallet.json")

# from base58 secret string
agent = Agent.from_secret_b58("3RvZm7Gw...")
```

## How x402 auth works under the hood

`agent.pay(url)`:

1. Sends the request unauthenticated.
2. On `402`, inspects the response and picks a facilitator adapter:
   - **AiFinPay** — `protocol: "AiFinPay vX"` field in JSON body, or
     `agreement_hash` + `treasury_vault` fingerprint
   - **Coinbase x402** — `PAYMENT-REQUIRED` HTTP header
3. Builds the right auth payload:
   - AiFinPay → reads `x-nonce` from the 402 body (no extra round-trip),
     computes `SHA-256("AiFinPay-x402:{nonce}:{pubkey}")`, signs with
     Ed25519, sets `x-agent-pubkey`, `x-nonce`, `x-signature` headers
   - Coinbase x402 → builds a `PaymentPayload`, base64-encodes, sets
     `PAYMENT-SIGNATURE` (settlement coming in 0.3)
4. Retries the original request with the auth attached.

The server verifies the signature, checks the agent's on-chain payment
proof (Seat PDA for AiFinPay, settled tx for Coinbase x402), and serves
the resource.

## Privacy

- **The server never sees your private key.** Period.
- Nonces are consumed on use; replay-resistant.
- All transactions are public and on-chain — Solana + Polygon mainnet.

## License

MIT.
