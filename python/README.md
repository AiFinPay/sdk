# aifinpay-agent (Python)

Version `2.5.0` (source candidate): agent identity (EVM and Solana addresses from one seed), native
request authentication, linking an agent to its owner's dashboard, and paying
AiFinPay merchants (`fetch_paid`, AIFP-1 on Polygon v1.4 in POL or USDC,
or explicitly selected EVM v1.4 networks).

Canonical domain **aifinpay.io**. A
wallet address alone does not mean a payment route is enabled. The keypair is
generated locally and never leaves your process.

## Solana paid access candidate

Canonical Solana records remain disabled. The following owner configuration
is implemented conditionally in 2.5 source; it refuses before any quote/signature
when canonical availability is false. It is not a published or enabled route.

```python
from aifinpay import AiFinPayAgent, Aifp1FinalizedFailureError

agent = AiFinPayAgent.from_seed(SEED_HEX, solana_rpc=OWNER_SOLANA_RPC)
r = agent.fetch_paid(
    URL,
    allowed_origins=["https://merchant.example"],
    max_amount_usd=OWNER_BATCH_USD_LIMIT,
    daily_amount_usd=OWNER_DAILY_USD_LIMIT,
    chain="solana",
    environment="prod",
    solana_network="mainnet",
    asset="SOL",  # mainnet also USDC/USDT; devnet only reviewed USDC
    max_fee_lamports=OWNER_FEE_AND_RENT_LIMIT_LAMPORTS,
    journal_dir=PRIVATE_JOURNAL_DIRECTORY,
)
```

Cluster/mode are independent owner choices: `dev` + `devnet`, or `prod` +
`mainnet`. The durable shared ledger persists the exact Ed25519-authorized quote request
before POST. Unknown transport outcomes retain that nonce/body across restart,
and retry the same admission after authorization expiry. The original response
is durably adopted, then converted atomically into the monetary reservation;
owner RPC/limits/cluster/program changes refuse replay. Policy, preflight and
ambiguous responses never automatically rotate the nonce.

Only an exact bound expired `410 not_admitted` from the owner API can close the
zero-debit phase. An exact expired issued quote can become a local nonbroadcast
terminal only before any monetary/signing transition and after validating its
original signed deadline and Config signer. Original ID/time/evidence persist,
and the same invocation returns failure without a new POST. A later explicit
fetch may request another quote; the backend continues counting its old issued
quote, so its policy allowance can remain constrained. This grants no refund.
The version 3 ledger migrates every exact v2 debit/reservation unchanged. Older
SDKs refuse v3; reconcile before downgrade and never reset state to retry.

`max_fee_lamports` is a positive integer covering transaction fees and
all missing nonce/ATA rent. EVM `max_gas_wei` is refused for Solana. Classic
Tokenkeg mints/decimals, live Config/profile/nonce/allowlist and final-message
simulation are checked before the local Ed25519 transaction signature. The
independent fresh SOL/USD source values both gross and fees/rent even for SPL.
No additional dependencies are introduced.

One private shared ledger binds both derived wallet families, exact purchase,
program/cluster, signed bytes, admission rate and fee caps. Signed bytes are
fsynced before one send; timeout/blockhash expiry never permits replacement.
`Aifp1PayError.recovery["journal_path"]` identifies the original journal. Restore
it with `agent.recover_paid(path,environment="prod",solana_network="mainnet")`.
Recovery uses the original signature and verifies issuer JWKS/EdDSA JWT plus exact
payer, cluster/program and quote bindings; it does not send a transaction.

A canonical finalized failure raises `Aifp1FinalizedFailureError` after atomic
fee-only reconciliation. It exposes `fee_amount_usd`, `actual_fee_lamports` and
original `recovery`, never a paid receipt. Missing/invalid/pruned final block or
fee evidence keeps the full reservation. Identical restart recovery is
idempotent; successful spending cannot be refunded through this path. Backend
signed-quote reservations are separate. Reconcile 2.5 state before downgrade; do
not delete a journal or spending file to retry an unresolved purchase.

`agent.get_payment_history(chain="solana",solana_network="mainnet")` and
`agent.get_quota(chain="solana",solana_network="mainnet")` read public metadata
without a passport or signature, preserve case, and redact bearer receipts.
Indexed history may lag and excludes unrelated wallet transfers. See
[architecture decision](../docs/adr/0004-solana-payment-flow.md).

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
keeps Polygon behavior, even if a merchant advertises another network.

The same `chain` option accepts polygon, base, optimism, arbitrum, avalanche, bnb,
unichain, xrplevm and robinhood. Every non-Polygon network requires an explicit
`max_gas_wei` in that network's native units. Configure other RPCs with constructor
`evm_rpc_urls={"bnb": "https://..."}`; existing polygon_rpc/base_rpc options remain.
Native prices use POL/ETH/AVAX/BNB/XRP. OP oracle fees are budgeted separately;
Nitro gas estimates already include parent-data costs. Address/decimal-pinned
stablecoins bind USD micro-units to exact6/18-decimal token units through additive
`token_settlement` (required for18dp); every leg and the exact approval are checked.
XRPL EVM currently supports native XRP only. These are client capabilities;
merchant authorization, backend readiness and per-chain paid acceptance are required
before production activation. Admin fee profiles remain mutable; preflight checks
current profiles and the existing receipt/recovery policy is preserved.

Every settlement is journaled to `journal_dir` (default `~/.aifinpay/journal`,
mode 600) before it is sent. If the outcome is unknown, `Aifp1PayError` carries
`recovery["journal_path"]`; call `agent.recover_paid(path)` — do not pay again.
New journals preserve the explicitly selected chain; older journals without
it remain Polygon-only. Recovery can fetch a receipt after the original quote
expires when the existing transaction settled in time.

Processes using the same local journal directory share one atomic USD budget.
The SDK reserves the validated debit under an operating-system file lock before
approval or settlement signing, then replaces and fsyncs the ledger atomically.
Unknown broadcasts retain their reservation beyond24hours. Once the chain confirms
the payment, the debit follows the24-hour window; the purchase remains blocked
until its receipt is verified. A receipt or HTTP failure never refunds a confirmed
debit. A proven prebroadcast failure or reverted settlement releases the gross
reservation; transaction gas remains subject to its separate native-wei budget.
The purchase guard covers the same issuer/API, payer, merchant and resource scope
across payment rails, so changing chain or token cannot buy unresolved access again.

`recover_paid` binds the adjacent `spend.json` reservation to the payer, original
purchase, chain/token/gross and hash derived from the signed transaction bytes.
It commits the debit once and unlocks only that purchase after a verified receipt.
Legacy confirmed-spend files and Polygon journals migrate without losing entries.
**Do not downgrade to an older SDK with pending 2.4 reservations**: older releases
ignore the new reservation state. Reconcile outstanding transactions first.
Malformed/unknown ledgers and unavailable OS file locking refuse payment; no empty
budget fallback is used. These locks cover processes on one local filesystem;
they do not establish a budget shared across separate hosts. The in-memory ledger
used by lower-level callers is shared only within that ledger instance.

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
- All payments are public and on-chain (the explicitly selected EVM network).

## License

MIT.
