# Changelog

## 0.1.1

Two security fixes. Both were found by an independent review of 0.1.0 after it
was published, and both let a merchant serve a paid call for nothing. Upgrade.

### A signed token is no longer treated as a spendable one

The issuer signs more than one kind of JWT with the same Ed25519 key and the
same audience. A **quota receipt** buys calls. A **per-action billing receipt**
(`typ_aifp: "action"`) is the opposite — proof that a call was already served
and already charged. 0.1.0 verified the signature and spent whatever it got.

Presented to a 0.1.0 gate, an action receipt was **served**. It carries no
`quota`, so the batch limit fell back to 1; no `scope`, which degrades to
`"exact"` and matches its own `resource`; and no `receipt_id`, so the meter
counted it at the literal key `used:undefined` — one counter shared by every
agent that presented one. Agents are handed one of these on **every call they
pay for**, and they live 30 days, so the supply was effectively unlimited.

The gate now checks the token's *kind* before its quota, as an allow-list: only
a receipt with no `typ_aifp`, or `typ_aifp: "quota"`, is spendable. Anything
else is `403`. A receipt with no `receipt_id`, or a single-use receipt with no
`nonce`, is refused for the same reason — the meter has exactly one key and
will not invent one.

### MemoryStore no longer deletes live counters

At `maxKeys` with nothing expired, 0.1.0 deleted the 10% of counters closest to
expiry. A counter **is** the record of how much of a prepaid batch has been
spent: delete it and metering restarts at zero, so an exhausted 200-unit batch
becomes 200 fresh units. The victims chosen were the batches nearest their end,
which is exactly the set where a reset is worth most. Keys derive from receipt
ids, so anyone able to present distinct receipts could push the map to the cap
and pick the moment their own spent batch was forgotten.

It now sweeps expired entries and, if that frees nothing, **throws**
`StoreCapacityError`. Your `onStoreError` decides what happens next (default
`"closed"` → 503) and the event is visible in your logs instead of in your
revenue. This restores the store contract this package has always documented:
*a backend failure must reject; never resolve with a guessed number.*

**Who is affected:** only processes that actually reach `maxKeys` (default
100,000 concurrently live counters). If you set a low `maxKeys`, raise it, or
move to `redisStore` — which was always the right answer for more than one
process.

**Note for adapter authors:** a test in 0.1.0 asserted the old eviction
behaviour — the bug written down as the specification. If you copied it, it now
fails, and that failure is correct.

## 0.1.0

Initial release. Merchant-side x402 paywall: 402 challenge, local EdDSA receipt
verification against our JWKS, quota metering by weight, pluggable store,
Express middleware, and the management/registry clients.
