# Changelog

## 0.2.2

Documentation only; no API or behaviour change.

The pricing section stated the superseded economics — a 1% fee "charged on top
of the agent's payment — never deducted from you", with a worked example of a
merchant quoting $0.0005 and receiving $0.0005. The canonical model (CEO
decision, 2026-08-23) is the reverse for AIFP-1: the agent pays the published
price, 1% is withheld from it and the merchant receives 99%. AIFP-2/x402 is the
provider-preserving route — the provider receives 100% and any fee is on top;
that fee is 0% today.

The section now also states plainly what is true *during* the migration, since
the two differ for merchants integrating right now: Polygon mainnet still runs
the previous splitter (98.99/1.00/0.01 immutable) and the backend grosses up to
match it, so an AIFP-1 merchant is currently made whole and the agent pays a
little more than the displayed price. Nothing in this package's API changes
when that flips.

Also corrected a test comment that asserted the old model in prose while
asserting the right number.

## 0.2.1

`knownAiAgent` now treats un-disguised browser automation as an agent by
declaration: default headless Chromium announces itself as
`HeadlessChrome/…` (Playwright, Puppeteer), and PhantomJS likewise — both
now meet the 402 on `shouldCharge: knownAiAgent` content routes, same as
the self-identifying crawlers. Headed Chrome is unaffected; the marker
matches `headlesschrome`, never plain Chrome. Deliberately not
`electron` — Electron UAs are humans inside app webviews. A driver that
spoofs a human UA remains out of scope by design. Additive only: more
agents charged, no human newly charged; APIs without `shouldCharge` are
untouched.

## 0.2.0

Content sites. Until now the gate charged every request on a mounted
route — right for an API, wrong twice over on a page with human readers:
a browser cannot present a receipt and must never meet a 402.

### `shouldCharge` — who pays

A per-request predicate. Requests it returns true for are charged;
everything else is served exempt, unmetered, with `mode: "exempt"` and a
`serve` event flagged `exempt: true` (count serves ↔ count revenue
without ambiguity). Omitted, nothing changes: everyone pays.

A predicate that throws CHARGES. Of the two wrong answers a broken
detector can give, a 402 to one human is visible and reported; a crawler
served free is silent and forever.

### `knownAiAgent` — the shipped answer

True for self-identifying AI crawlers (GPTBot, ClaudeBot, PerplexityBot,
CCBot, Bytespider, Google-Extended, …) — the population Cloudflare's
classifier recognises, which is exactly the population with content
budgets — and for anything already speaking the protocol (AIFP-Receipt /
AIFP-Agent-Id), so a paying agent with a browser User-Agent is never
exempted out of metering. It is a curated list, not stealth detection;
extend it with your own signals, or move the decision to your edge
(a Cloudflare Transform Rule header) and check one header here.

### `ensureResources(inputs, { onExisting: "skip" })`

The other ownership model, made explicit. Default stays "replace"
(converge to the declaration — code owns the routes). "skip" creates
only what is missing and never touches what exists — the panel owns
routes after birth, and its edits survive deploys.

### The 402 now tells a walletless agent where a wallet comes from

`no_wallet` field in the challenge body: `npx @aifinpay/mcp init` and
the agent SDKs resolve the whole 402 automatically. "Settle from your
own wallet" was a dead end for an agent that had none, and the 402 is
the only documentation an agent is guaranteed to read.

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
