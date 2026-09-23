# aifinpay-agent (Python)

Version `2.1.1`: agent identity (EVM and Solana addresses from one seed), native
request authentication, and linking an agent to its owner's dashboard.

> **Python cannot pay AiFinPay merchants yet.** Live AIFP-1 payments settle on
> the Polygon v1.4 splitter, and that executor exists only in the Node SDK
> (`@aifinpay/agent`, `fetchPaid`) and the MCP server (`@aifinpay/mcp`,
> `payable_fetch`). To pay from a Python agent, run the MCP server or call the
> Node SDK. Legacy paid `call()` is disabled.

Canonical domain **aifinpay.io** (`aifinpay.company` only redirects there). A
wallet address alone does not mean a payment route is enabled. The keypair is
generated locally and never leaves your process.

## Install

```bash
pip install aifinpay-agent
```

## Development setup

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt -e .
```

## Quick start

```python
from aifinpay.unified_agent import AiFinPayAgent

agent = AiFinPayAgent.from_seed(SEED_HEX)  # 32-byte seed you keep private
print("EVM address:", agent.evm_address)   # fund with POL on Polygon to pay (via MCP/Node)
```

## Link the agent to its owner's dashboard

At https://dash.aifinpay.io → My Agents → Add agent by address the owner gets a
challenge. Sign it and hand back the signature:

```python
signature = agent.sign_dashboard_claim(challenge)
```

`sign_dashboard_claim` signs only `AiFinPay-claim:polygon:<this address>:<nonce>`
and refuses any other text. The owner then sees the agent's balance, payments
and receipts.

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
     `PAYMENT-SIGNATURE` (detection and parsing only; Python does not settle)
4. Retries the original request with the auth attached.

The server verifies the signature and serves the resource if the agent is
entitled to it. Paying for access is a separate step (see the note at the top).

## Privacy

- **The server never sees your private key.** Period.
- Nonces are consumed on use; replay-resistant.
- All payments are public and on-chain (Polygon mainnet).

## License

MIT.
