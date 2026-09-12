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
await agent.fetchPaid('https://merchant.example/api/agent/genres', {}, {
  settlementPin: reviewedDeploymentPin,
  nativeUsdPrice: { usd: trustedPolUsd, observedAtMs: priceObservedAtMs },
  gatewayOrigins: ['https://merchant.example'],
  resourcePathMode: 'direct',
  maxAmountUsd: 0.10,
});
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
import { recoverAifp1Payment } from '@aifinpay/agent';

// savedRecovery is Aifp1PayError.recovery from the earlier payment.
// account is the same local viem account that sent that payment.
const paid = await recoverAifp1Payment(savedRecovery, {
  payerAddress: account.address,
  signPaymentAuthorization: message => account.signMessage({ message }),
});

// Reuse this receipt for the resource/scope it covers.
const response = await fetch(resourceUrl, {
  headers: { 'AIFP-Receipt': paid.receipt },
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
