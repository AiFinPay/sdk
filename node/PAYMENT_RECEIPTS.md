# Solana payment authorization (2.5.0 source candidate)

High-level execution still requires an accepted enabled canonical registry record.
Both real Solana records remain disabled. This configuration describes the
conditional source implementation; do not override availability in an application.

```ts
import { AiFinPayAgent, Aifp1FinalizedFailureError } from "@aifinpay/agent";

const agent = await AiFinPayAgent.fromEnvironment({ solanaRpc: ownerSolanaRpc });
agent.setBudget({ daily_usd: ownerDailyUsdLimit, per_call_usd: ownerBatchUsdLimit });
await agent.fetchPaid(
  url,
  {},
  {
    gatewayOrigins: ["https://merchant.example"],
    resourcePathMode: "direct",
    maxAmountUsd: ownerBatchUsdLimit,
    nativeUsdPrice: readFreshIndependentSolPrice,
    solanaV14: {
      environment: "prod",
      network: "mainnet",
      asset: "SOL", // USDC or USDT on mainnet; only reviewed USDC on devnet
      maxFeeLamports: ownerFeeAndRentLimitLamports, // bigint, independently chosen
      onPrepared: persistPrivatePaymentJournal,
    },
  }
);
```

Use `environment:"dev",network:"devnet"` together for devnet; never infer a
cluster from the payer's address. `nativeUsdPrice` is required even for SPL to
value fee/rent costs, and must be independent and fresh within 60 seconds. Keys
remain local. Quotes use request-bound Ed25519 ownership authorization before
backend signing; the payer verifies the backend's secp256k1 quote signature
against freshly read Config. This is separate from Ed25519 receipt authorization.

Before the quote POST, the shared private ledger persists the exact owner-signed
request, nonce, statement and RPC/limits/cluster/program/IDL context. A timeout or
restart replays those same bytes, even after authorization expiry; the server may
return only its already-issued original quote. The response is adopted durably,
then its zero-debit phase converts atomically into the monetary reservation.
Unknown, malformed, policy or preflight failures keep the original admission;
changing owner context refuses replay. Custom Solana ledgers require the additive
quote-admission hooks as well as the existing bound recovery hooks.

Only an exact authenticated expired `410 not_admitted` from the owner API can
close an absent zero-debit admission. An expired original quote can become a
local nonbroadcast terminal only if no monetary reservation/signing occurred,
its exact stored signed deadline and current Config signer are verified, and
its original ID/time/evidence survive the atomic transition. That invocation
returns failure and never asks for a replacement quote. A later explicit fetch
may request a fresh admission; the backend still counts the old issued quote,
so its policy allowance can remain constrained. This is no backend refund.
Never clear state, rotate an unknown nonce, or downgrade while unresolved.

`maxFeeLamports` bounds transaction fees plus missing payer-nonce/consumed-nonce
PDA and destination ATA rent. Payer SPL ATA must already exist and be funded.
Destination ATA creation is idempotent within the **same** settlement transaction,
never a preparatory payment. Only classic Tokenkeg and independently pinned
mint/decimal identities are accepted. Token-2022 and unreviewed mints refuse.

The saved `Aifp1SolanaPaymentRecovery` includes `family:"solana"`, exact signature,
base64 signed bytes, network/program/IDL, blockhash, nonce, owner-approved fee caps
and independently sourced admission SOL/USD rate. The private ledger binds that
context and the common factory wallet identity before the callback resolves.
A failed fsync callback prevents broadcast. Never put journal bytes or JWTs in logs.

```ts
try {
  const paid = await agent.recoverPaidPayment(savedRecovery, {
    solanaEnvironment: "prod",
    solanaNetwork: "mainnet",
  });
  // Store the verified receipt privately; no transaction was resent.
} catch (error) {
  if (error instanceof Aifp1FinalizedFailureError) {
    // No paid access: original failure reconciled once to feeAmountUsd.
    // actualFeeLamports and recovery identify the immutable original purchase.
  }
  throw error;
}
```

Recovery validates the original signed transaction and owner-selected cluster;
quote expiry, changed current admin profiles and expired recent blockhash never
permit a second payment. A finalized failure requires the original raw bytes,
valid error/slot, pinned genesis, canonical finalized block inclusion and safe
actual fee within the original caps. The local fee-only transition is atomic and
idempotent, survives restart/day rollover and cannot overwrite confirmed payment.
An unavailable/malformed proof or local journal error keeps the original guard.
The backend's outstanding signed-quote policy reservation remains separate.
Older SDKs must not operate on unreconciled 2.5 journals; retain IDs while recovery
is possible, and reconcile before downgrade. Never clear state to retry payment.

Public reads need no passport binding or payer signature:

```ts
await agent.getPaymentHistory({ network: "solana", solanaNetwork: "mainnet", source: "transactions" });
await agent.getQuota({ network: "solana", solanaNetwork: "mainnet" });
```

`balance({ solanaNetwork: "mainnet" })` independently verifies the owner RPC's
genesis and uses that cluster's pinned USDC mint. Failed or malformed explicit
cluster balance reads throw; they never become a verified zero balance.
Devnet raw balances have test
context, no SOL USD price and no contribution to the aggregate fiat value.
Omitted legacy balance context is explicitly unverified owner RPC/mainnet mint;
it does not establish payment availability. No devnet USDT pin is provided.

These query independently pinned cluster/program and preserve base58 case. They
return retained partial-history coverage and explicitly unallocated costs, validate
exact wallet identity and conserved integer billing units, exclude arbitrary wallet transfers, may lag the
chain and redact bearer JWTs.

---

# v1.4 payment authorization (2.4.0 source candidate)

The existing v1.3 documentation below remains applicable to explicitly pinned
v1.3 callers. The v1.4 path uses the original backend-signed quote:

```ts
const response = await agent.fetchPaid(
  url,
  {},
  {
    gatewayOrigins: ["https://merchant.example"],
    resourcePathMode: "direct",
    scope: "exact",
    maxAmountUsd: ownerLimitUsd,
    nativeUsdPrice: readFreshIndependentPolPrice,
    v14: {
      maxGasWei: ownerGasLimitWei,
      onPrepared: persistPrivatePaymentJournal,
    },
  }
);
```

`nativeUsdPrice` may return `{ usd, observedAtMs }` asynchronously and is called
only when buying, not when reusing a receipt. `onPrepared` receives the original
quote, selected chain, API/issuer, transaction hash and serialized signed transaction. It MUST
atomically persist and fsync private state before resolving. A failed callback
prevents broadcast. Keep a per-wallet operation lock and refuse another purchase
while a prepared payment is unresolved. Never log the raw transaction or receipt.

After a transport error, call `agent.recoverPaidPayment(recovery)` with the saved
recovery object. It only retries receipt issuance, verifies the issuer's Ed25519
signature and purchase bindings, and returns the existing receipt. It never sends
a new transaction. Persist the receipt and restore `agent.aifp1Receipts` before
another `fetchPaid`. A prepared-but-unbroadcast or reverted transaction requires
owner reconciliation; receipt recovery is not a replacement broadcast.

The public MCP candidate implements this private journal/cache/lock integration.
Applications using the SDK directly own persistence and process coordination.
`fetchPaid` supports the current nine EVM mainnets in live mode, with the
selected native currency or a stablecoin pinned for that chain. Every non-Polygon
rail requires explicit owner selection. It never changes routes or assets after
a refusal. Amoy remains a low-level test executor, separate from live receipts.

A successful executor result requires a mined success receipt with the matching
Payment event. Unknown broadcast/confirmation yields the original hash. Profile
fees/treasury remain administratively mutable under the existing v1.4 contract
model. Separate funded acceptance and release approval are still required.

## Base ETH or USDC

Configure `evmRpcUrls.base` on `AiFinPayAgent` for an independent Base RPC. The
SDK verifies its `eth_chainId` is 8453 before signing. `polygonRpc` remains the
Polygon transport and is never reused for Base.

```ts
await agent.fetchPaid(
  url,
  {},
  {
    gatewayOrigins: ["https://merchant.example"],
    resourcePathMode: "direct",
    maxAmountUsd: ownerLimitUsd,
    nativeUsdPrice: readFreshIndependentEthPrice,
    v14: {
      chain: "base", // trusted caller choice, never copied from a quote
      asset: "ETH", // or "USDC"; omit nativeUsdPrice for a USDC purchase
      maxGasWei: ownerFeeBudgetWei,
      onPrepared: persistPrivatePaymentJournal,
    },
  }
);
```

`asset` defaults to ETH on Base and POL on Polygon. `nativeUsdPrice` must report
the chosen native asset's USD price and observation time; there is no automatic
POL fallback on Base. A valid merchant receipt already cached for the same
resource can still be reused after changing this payment preference.

For Base, fee preflight counts L2 `gas × maxFeePerGas`, plus a conservative
`GasPriceOracle.getL1FeeUpperBound` and `getOperatorFee` estimate with 20% headroom.
Both approval and settlement are included before approval signing. The estimates
are rechecked before settlement. Missing or malformed oracle answers block payment.
The gas cap and balance checks use this total, but L1/operator fees may change
before inclusion and are not capped by the signed EIP-1559 transaction.

New recovery records include `chain`. The low-level legacy default without it
remains Polygon. MCP may migrate a missing-chain journal only from independent
owner configuration after actual signed transaction bytes prove the chain ID,
payer, pinned target, exact calldata/value and token/approval. Insufficient
evidence requires owner reconciliation; no rail is guessed. The stored chain,
asset and original quote must agree before the SDK signs a receipt claim.
Recovery works after quote expiry when the existing transaction already settled;
it never signs a replacement payment. Receipt JWT format is unchanged.

## Durable USD reservations

The built-in file ledger shares one daily cap across processes on one local
filesystem. It reserves before approval/signing, reloads state under a private
exclusive lock, and writes through a mode-600 temporary file with atomic rename
and file/directory fsync. Corrupt or unreadable state refuses payment. A held lock
times out without being stolen; after a crash the owner must stop all users and
reconcile outstanding transactions before recovering that lock.

Unknown broadcasts retain their debit reservation indefinitely. Confirmed debits
count for 24 hours, while the unresolved purchase guard remains until a verified
receipt completes reconciliation. API/issuer, payer, merchant/scope/resource/mode,
chain/asset/token/gross/quote ID and signed-byte hash bind the reservation to the
journal. Changing rails cannot repurchase unresolved access. A confirmed debit is
never refunded for a receipt or HTTP failure. Recovery commits it once, and keeps
its reconciliation identity after the budget window expires without counting
that old debit. Bound history therefore grows; never truncate unresolved state.

Old custom capped v1.4 adapters must implement `prepare`, `assertRecovery` and
`complete`; absence fails before payment. The uncapped/legacy source API remains
compatible. `MemorySpendLedger` coordinates one shared instance only. These are
local filesystem guarantees, not a distributed cap across hosts. Do not downgrade
to an older SDK while a 2.4 reservation is pending: old code can expire/reset it.
Preserve the journal and reconcile first. Recovery never accepts a ledger path,
USD valuation or increased cap from a quote or journal.

---

# Authorize and recover payment receipts

AIFP-1 receipt issuance uses a signature from the wallet that sent the payment.
The SDK signs a fixed, domain-separated receipt authorization automatically.
A custom `agentId` is a display identifier; it does not replace the paying
wallet. Keep the complete quote and transaction reference until you receive
the receipt.

New payments require an independently reviewed `settlementPin` for Polygon
AIFP-1 v1.3 and a `nativeUsdPrice` observation from a trusted source, at most
60 seconds old. Do not construct either from the payment server's response.
The SDK checks the quote's target/version/calldata, invoice, RPC and wallet
chain, deployed bytecode and fee profile before signing. It waits for a
successful mined receipt before requesting access.

`maxAmountUsd` caps the next batch using the greater of quoted USD and native
debit converted at that independent price. It must be positive and finite,
and can only tighten the agent's limits. Gas is additional. A cached receipt
does not buy another batch. Mainnet activation flags have not been enabled
by this SDK update; unavailable or legacy quotes are refused before payment.

For a direct merchant endpoint such as `/api/agent/genres`, explicitly select
the full-path format as well as the trusted origin:

```ts
await agent.fetchPaid(
  "https://merchant.example/api/agent/genres",
  {},
  {
    settlementPin: reviewedDeploymentPin,
    nativeUsdPrice: { usd: trustedPolUsd, observedAtMs: priceObservedAtMs },
    gatewayOrigins: ["https://merchant.example"],
    resourcePathMode: "direct",
    maxAmountUsd: 0.1,
  }
);
```

The pin and price variables above come from your independently reviewed
configuration and price source. This is a configuration example, not an
instruction to substitute addresses or rates from an HTTP 402 response.
`apiTimeoutMs` bounds each API request, including reading its body; default
15 seconds. Redirects are refused. For a backend with a different configured
receipt issuer, set `paymentIssuer` independently to its `AIFP_ISSUER_URL`;
changing only `apiBaseUrl` does not change the trusted issuer.

Direct mode probes the resource without a receipt before each call, then
reuses only a receipt for the same origin, merchant and covered full path.
The challenge's resource must equal the URL pathname. This extra unpaid
probe prevents a merchant-wide receipt from being sent to another merchant
on the same host. The default `gateway` mode keeps hosted URLs in the
`/{merchant-slug}/{resource}` format. An origin is never trusted merely
because it returns an AIFP-1 challenge. Direct probes return redirects to the
caller without following them, so another origin cannot supply the payment
challenge through a redirect. This path-mapping option does not enable a
disabled settlement route or change its deployment verification requirements.

After settlement, the SDK retries HTTP 425, HTTP 503 and connection failures
within `settlementConfirmMs`. These retries request the receipt; they never
send another on-chain transaction. If retries are exhausted,
`Aifp1PayError.recovery` contains serializable quote and payment context, with
no private key or authorization signature. Save it for a later retry.
Concurrent callers waiting for that batch receive the same failure and
recovery context. After this error, retry `recoverAifp1Payment` with that
context instead of calling `fetchPaid` again: a new `fetchPaid` request can
buy another batch when no receipt has been cached.

```ts
import { recoverAifp1Payment } from "@aifinpay/agent";

// savedRecovery is Aifp1PayError.recovery from the earlier payment.
// account is the same local viem account that sent that payment.
const paid = await recoverAifp1Payment(savedRecovery, {
  payerAddress: account.address,
  signPaymentAuthorization: (message) => account.signMessage({ message }),
});

// Reuse this receipt for the resource/scope it covers.
const response = await fetch(resourceUrl, {
  headers: { "AIFP-Receipt": paid.receipt },
});
```

This helper recovers Polygon AIFP-1 receipts and has no settlement callback.
It cannot send funds. Keep the returned receipt in your application's receipt
store; recovery itself does not populate a separate AiFinPayAgent instance's
cache. Recover within the quote's advertised recovery window. An expired price
cannot be used for a new payment.

For manual integrations, `paymentAuthorizationMessage` constructs the exact
message from the saved quote, chain, transaction reference, asset, idempotency
key, payer and expiration. Sign its result with the paying EVM account and
send `payment_authorization: { payer, expires_at, signature }` in `/v1/pay`.
Use a lowercase EVM address and an expiry about 240 seconds in the future.
The backend accepts `wallet-signature-v1` as announced in the quote. It derives
the receipt subject from the proven payer. Re-sign a retry when the signature
expires and keep the same transaction reference; paying again is unnecessary.

If confirmation is unavailable after broadcast, recovery keeps the transaction
hash and quote. A mined payment followed by a ledger error also retains that
context; reconcile the budget before another purchase. Once `/v1/pay` returns
a receipt, it is cached before fetching content, so a dropped content request
does not discard paid access. The cache is local to this agent instance;
applications must persist recovery/receipts for restart recovery.

The API retains its legacy `settlement.fee_on_top` object during client upgrades.
The RC client accepts that object only alongside explicit `gross-inclusive`
metadata, with provider, treasury and creator amounts matching the canonical
payer/recipient amounts. An inconsistent quote is rejected before settlement.
Native `valid_until` may be a JSON integer or an integer string. These wire
compatibility changes do not activate a disabled deployment. v1.4 execution
and legacy `call()` payment submission remain disabled in this RC. Current
v1.4 quotes omit mutable fees/treasury from the signed commitment; a new
contract/SDK release is required. There is no automatic version fallback.

## Nine-network v1.4 source capability (2.4.0)

`v14.chain` accepts polygon (default), base, optimism, arbitrum, avalanche, bnb,
unichain, xrplevm and robinhood. Quotes cannot choose or expand that setting.
`evmRpcUrls` keys use those canonical names (BNB uses bnb, not the legacy bridge
bsc name). The backend must independently authorize the requested settlement_chain
for the merchant. Native/USD prices must match POL/ETH/AVAX/BNB/XRP. Gas budgets
are in the selected native asset's18-decimal wei; approval and settlement share
the budget. OP models include oracle data/operator estimates, Nitro estimates
include parent data already. Unknown or unavailable fee estimates refuse signing.

The quote amount and existing settlement aliases still contain USD micro-units.
`token_settlement` contains asset, token, decimals, total_units, merchant_units,
protocol_fee_units, creator_units and settlement_semantics=gross-inclusive. Client
address/decimal pins, signed gross and exact approval bind its total to USDmicro
multiplied by10^(decimals-6). Legs split the token gross, not rounded USD legs.
Metadata is checked whenever present;18dp requires it and old6dp can omit it.
Signer/runtime/current-profile/TokenList checks are still performed before broadcast.
Profiles remain administratively mutable under the accepted v1.4 trust model;
these quote-time checks do not create immutable fee guarantees. Recovery never
re-sends a payment and retains its original chain even after quote expiry.

Source capability does not activate a production network. Per-chain deployment,
backend/indexing and actual paid acceptance gates are recorded in the release evidence.
