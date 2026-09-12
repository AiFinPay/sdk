# Authorize and recover payment receipts

AIFP-1 receipt issuance uses a signature from the wallet that sent the payment.
The SDK signs a fixed, domain-separated receipt authorization automatically.
A custom `agentId` is a display identifier; it does not replace the paying
wallet. Keep the complete quote and transaction reference until you receive
the receipt.

Before settlement, `fetchPaid` requires the quote to advertise
`wallet-signature-v1` receipt authorization and verifies its expiry and any
bound payer address. A server that cannot issue a supported signed receipt
is rejected before a payment is sent.

Set `fetchPaid(url, {}, { maxAmountUsd: 0.10 })` to cap the next quoted batch
at $0.10. This must be a positive finite amount; it can only tighten the
agent's existing per-call and daily limits. Gas is additional. Requests
covered by a cached receipt do not buy another batch.

For a direct merchant endpoint such as `/api/agent/genres`, explicitly select
the full-path format as well as the trusted origin:

```ts
await agent.fetchPaid('https://merchant.example/api/agent/genres', {}, {
  gatewayOrigins: ['https://merchant.example'],
  resourcePathMode: 'direct',
  maxAmountUsd: 0.10,
});
```

Direct mode probes the resource without a receipt before each call, then
reuses only a receipt for the same origin, merchant and covered full path.
The challenge's resource must equal the URL pathname. This extra unpaid
probe prevents a merchant-wide receipt from being sent to another merchant
on the same host. The default `gateway` mode keeps hosted URLs in the
`/{merchant-slug}/{resource}` format. An origin is never trusted merely
because it returns an AIFP-1 challenge. Direct probes return redirects to the
caller without following them, so another origin cannot supply the payment
challenge through a redirect.

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

The `fetchPaid` settlement route and its existing deployment verification
requirements are unchanged. Receipt authorization does not enable a disabled
settlement route or replace independent route verification. This maintenance
release preserves the existing legacy Polygon native-POL executor; it does
not enable v1.4 settlement or guarded RC routes.
