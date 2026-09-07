# Authorize and recover payment receipts

AIFP-1 receipt issuance uses a signature from the wallet that sent the payment.
The SDK signs a fixed, domain-separated receipt authorization automatically.
A custom `agentId` is a display identifier; it does not replace the paying
wallet. Keep the complete quote and transaction reference until you receive
the receipt.

After settlement, the SDK retries HTTP 425, HTTP 503 and connection failures
within `settlementConfirmMs`. These retries request the receipt; they never
send another on-chain transaction. If retries are exhausted,
`Aifp1PayError.recovery` contains serializable quote and payment context, with
no private key or authorization signature. Save it for a later retry.

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
settlement route or replace independent route verification.
