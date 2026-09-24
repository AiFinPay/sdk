# aifinpay-agent (Python)

Version `2.2.0`: agent identity (EVM and Solana addresses from one seed), native
request authentication, linking an agent to its owner's dashboard, and paying
AiFinPay merchants (`fetch_paid`, AIFP-1 on Polygon v1.4 in POL or USDC).

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
print("EVM address:", agent.evm_address)   # fund on Polygon: POL, or USDC + a little POL for gas
```

## Pay for a paywalled resource

```python
r = agent.fetch_paid(
    "https://api.example.com/articles/2026/x",
    allowed_origins=["https://api.example.com"],  # the only origins it will pay
    max_amount_usd=0.20,                           # per batch
    daily_amount_usd=2.00,                         # rolling 24 h, persisted
    asset="USDC",                                  # or "POL" (default)
)
print(r.status_code, r.json())
```

On an AIFP-1 `402` it buys one batch (from $0.10) scoped to the path's section
(`/articles/`), settles it on the Polygon v1.4 splitter, exchanges it for a
receipt and retries. Later requests the receipt covers cost no transaction.
Nothing is signed unless the origin is allowed, the signed quote matches the
challenge and the SDK's pinned deployment, and the batch fits both limits. POL
is priced against an independent POL/USD source (Chainlink on Polygon, then
Coinbase, then CoinGecko), never the quote; USDC approves exactly the batch.

Every settlement is journaled to `journal_dir` (default `~/.aifinpay/journal`,
mode 600) before it is sent. If the outcome is unknown, `Aifp1PayError` carries
`recovery["journal_path"]`; call `agent.recover_paid(path)` — do not pay again.

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
entitled to it. Paying for access is `fetch_paid` (above).

## Privacy

- **The server never sees your private key.** Period.
- Nonces are consumed on use; replay-resistant.
- All payments are public and on-chain (Polygon mainnet).

## License

MIT.
