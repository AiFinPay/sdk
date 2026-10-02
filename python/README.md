# aifinpay-agent (Python)

Version `2.3.2`: agent identity (EVM and Solana addresses from one seed), native
request authentication, linking an agent to its owner's dashboard, and paying
AiFinPay merchants (`fetch_paid`, AIFP-1 on Polygon v1.4 in POL or USDC,
or explicitly selected Base v1.4 in ETH or USDC).

Canonical domain **aifinpay.io**. A
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

For a merchant configured to settle on Base, select the chain explicitly:

```python
agent = AiFinPayAgent.from_seed(SEED_HEX, base_rpc="https://mainnet.base.org")
r = agent.fetch_paid(
    "https://api.example.com/articles/2026/x",
    allowed_origins=["https://api.example.com"],
    max_amount_usd=0.20,
    daily_amount_usd=2.00,
    chain="base",
    asset="USDC",                  # omit for native ETH on Base
    max_gas_wei=10**15,             # explicit 0.001 ETH fee budget
)
```

Base requires `max_gas_wei`; the legacy Polygon `max_gas_pol=0.5` default never
becomes an ETH allowance. This budget covers approval plus settlement, with
the L2 maximum gas fee and current Base oracle L1 data/operator estimates plus
20% headroom. An unavailable estimate or insufficient budget/balance refuses
before sending. It is a preflight estimate, not an on-chain cap on future L1
fees. Fees are separate from the USD payment limits. Configure the Base RPC
via `base_rpc` or `AIFINPAY_BASE_RPC`; the SDK checks chain ID 8453 before signing.

ETH uses independent ETH/USD prices from Coinbase, falling back to a fresh
CoinGecko quote. The SDK rejects a quote with another chain, native asset,
token address or receipt chain. It uses Base's pinned USDC address; a token
named USDC on another chain does not authorize a Base payment. Omitting `chain`
keeps Polygon behavior, even if a merchant advertises Base. Other EVM chains
are not enabled by this change.

Every settlement is journaled to `journal_dir` (default `~/.aifinpay/journal`,
mode 600) before it is sent. If the outcome is unknown, `Aifp1PayError` carries
`recovery["journal_path"]`; call `agent.recover_paid(path)` — do not pay again.
New journals preserve the explicitly selected chain; older journals without
it remain Polygon-only. Recovery can fetch a receipt after the original quote
expires when the existing transaction settled in time.

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
import os
from aifinpay import Agent

# from solana-keygen JSON file (open() does not expand "~")
agent = Agent.from_keypair_file(os.path.expanduser("~/agent-wallet.json"))

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
   - AiFinPay (auth version 2) → reads the one-time `x-nonce`, its expiry and
     the request-body SHA-256 from the 402 body; refuses unless the request and
     the response are on the origin configured as the agent's `base_url` and
     the body digest matches; signs, with Ed25519, the SHA-256 of the JSON
     array `["AiFinPay-x402", "v2", nonce, pubkey, origin, METHOD, path+query,
     bodySha256, expiresAt]`; sets `x-agent-pubkey`, `x-nonce`, `x-signature`
     and `x-aifinpay-auth-version: 2`. The retired v1 format is refused and
     `auth_headers()` raises.
   - Coinbase x402 → detected and parsed (a price above
     `options.max_amount_usd` raises `PaymentTooExpensiveError`), then
     `FacilitatorNotImplementedError`: Python does not pay this flavor
4. Retries the original request with the auth attached.

The server verifies the signature and serves the resource if the agent is
entitled to it. Paying for access is `fetch_paid` (above).

## Privacy

- **The server never sees your private key.** Period.
- Nonces are consumed on use; replay-resistant.
- All payments are public and on-chain (Polygon or explicitly selected Base).

## License

MIT.
