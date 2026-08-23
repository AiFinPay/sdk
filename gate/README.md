# @aifinpay/gate

Put your own API behind AIFP-1, in your own process. No proxy, no traffic
through us, no round-trip per request.

An AI agent calls your endpoint. It has no account with you and no API key. It
gets a `402` that tells it exactly what the call costs and how to buy a batch,
pays on-chain from its own wallet, and retries with a signed receipt. Your gate
verifies that receipt locally and counts the prepaid units down.

```
npm install @aifinpay/gate
```

Requires Node 18+. Express is an optional peer (4 or 5); the core has no
framework dependency at all.

---

## 1. Sixty seconds

```js
import express from "express";
import { aifpGate } from "@aifinpay/gate";

const app = express();

app.get("/api/search", aifpGate({
  merchantId: process.env.AIFP_MERCHANT_ID,   // "mrch_…"
  resource: "/api/search",
  tier: "complex",                             // standard | complex | premium
}), (req, res) => {
  res.json({ results: [], billed_units: req.aifp.weight });
});

app.listen(3000);
```

That is a working paywall. Before you ship it, read §3 — the default quota
store is per-process, and that is the one thing in this package that quietly
costs money if you get it wrong.

---

## 2. Register your endpoints with your API key

Your routes live in code and change in pull requests. Their prices should too.

```js
import { AifpMerchant, ResourceRegistry, aifpGate } from "@aifinpay/gate";

// reads AIFP_MERCHANT_ID and AIFP_MERCHANT_SECRET from the environment
const merchant = new AifpMerchant();

await merchant.ensureResources([
  { route_pattern: "/api/search",    type: "api", tier: "complex" },
  { route_pattern: "/api/lookup/*",  type: "api", tier: "standard" },
  { route_pattern: "/api/report",    type: "api", tier: "premium", name: "Generate report" },
  { route_pattern: "/api/health",    type: "api", paywall_enabled: false },
]);

const registry = new ResourceRegistry({ merchant });
registry.start();                              // refreshes every 60s

app.use(aifpGate({ merchantId: merchant.merchantId, registry }));
```

`ensureResources` is idempotent by `route_pattern`, so this belongs in your boot
script and is safe on every deploy. Re-running it converges instead of piling up
duplicates — which matters, because two records for the same path with different
weights would charge unpredictably.

**These endpoints appear in your AiFinPay dashboard immediately.** Not through a
sync job — there is nothing to sync. The SDK writes the same endpoint registry
the dashboard's Paywall Builder writes and the dashboard reads, so a route
registered from a deploy script and a route registered by clicking are the same
record, in the same table, on the same Insights charts. Register from code,
tune prices in the panel, or both.

One prerequisite: **the merchant must be linked to a dashboard account.** The
simplest path is to create the merchant in the dashboard, copy the secret from
there, and give it to the SDK. A merchant created purely over the API has no
owner, and the panel will not show you what your key registered under it.

The rest of the management surface, for scripts and internal tooling:

```js
await merchant.listResources();
await merchant.getResource("res_…");
await merchant.createResource({ route_pattern: "/api/new", type: "api" });   // 409 if it exists
await merchant.updateResource("res_…", { tier: "premium" });
await merchant.deleteResource("res_…");
await merchant.merchant();                     // name, payout wallets — log this on boot so
await merchant.stats();                        //   you can see WHICH merchant you configured
await merchant.activity(50);
await merchant.setWebhook("https://you.example/aifp-webhook");
```

Errors are typed, so a deploy script can tell a mistake from an outage:
`AifpValidationError` (your input, with the server's own hint), `AifpAuthError`
(wrong or rotated secret), `AifpConflictError` (duplicate `route_pattern`, and
it carries the existing `resource_id`). The secret is stored non-enumerably and
never appears in an error message, a stack, or `JSON.stringify(merchant)`.

---

## 3. Choose a store

The gate meters a prepaid batch by counting billing units against the receipt.
The store is where that count lives, and it has exactly two rules:

1. **`incrBy` is atomic and returns the value AFTER the add.** The gate never
   reads a counter and writes it back — it adds the call's weight and compares
   what comes back. That is what makes overspend arithmetically impossible under
   concurrency: whichever request receives the value that crosses the limit is
   the one refused, exactly once.
2. **The TTL is set on the first write only.** The counter must expire *with*
   the receipt. A counter that outlives its receipt refuses paid calls; one that
   expires early makes the whole batch spendable a second time.

**Default — `MemoryStore`.** Correct on one process, and only on one process.
It is genuinely atomic there (the read-add-write runs with no `await` in the
middle, so the event loop serializes it), it is capped so a flood of receipt ids
cannot exhaust memory, and it needs no infrastructure.

> Its two hard limits: counters are lost on restart, and **every process gets
> its own copy**. Under `pm2 -i 4`, `node:cluster`, or two pods behind a load
> balancer, a 200-unit batch will serve up to 800 calls, and nothing in the
> request path can detect it. If you run more than one process, use a shared
> store.

**Shared — `redisStore`.** Pass your own client; this package declares no redis
dependency and will not touch your connection policy.

```js
import Redis from "ioredis";
import { redisStore } from "@aifinpay/gate";

const store = redisStore(new Redis(process.env.REDIS_URL));
app.use(aifpGate({ merchantId, registry, store }));
```

It is one `EVAL` per call — increment and TTL in a single atomic script, and the
script repairs a counter that somehow lost its expiry. Redis errors **propagate**
rather than falling back to local memory: a silent downgrade would reopen the
overspend race the counter exists to close. `onStoreError` decides what happens
(`"closed"` → `503`, the default; `"open"` → serve and flag), and whatever it
decides is visible.

**Anything else.** DynamoDB, Postgres, Cloudflare KV — implement `incrBy` and
prove it before it meters real money:

```js
import { assertStoreContract } from "@aifinpay/gate/testing";
await assertStoreContract(() => myStore(), { equal: assert.equal, ok: assert.ok });
```

Six cases, each of which maps to a way a merchant loses revenue. Adapter
skeletons for DynamoDB and Postgres are in the source of
`@aifinpay/gate/stores`.

---

## 4. What the gate does per request

| # | Condition | Answer |
|---|---|---|
| 1 | Resolve the resource and its weight — the registry record for this path, or the mount's `resource`/`tier`. An unregistered path stays **paywalled**, never free. | — |
| 2 | The resource is registered with `paywall_enabled: false` | `200`, header `AIFP-Paywall: off`, no units spent |
| 3 | No `AIFP-Receipt` header | `402` + the full challenge |
| 4 | Receipt expired | `402` — `receipt expired — prepay a new batch` |
| 4 | Bad signature, issuer, or audience | `403` — `receipt verification failed (signature/issuer/audience)` |
| 4 | Our JWKS is unreachable and nothing is cached | `503 AIFP-503-METER` — fails **closed** |
| 5 | Receipt is scoped to another path | `403` — names both the receipt's scope and the path |
| 6 | Single-use receipt replayed | `403` — `receipt already spent (single-use)` |
| 7 | `used + weight > unit_quota` | `402` — `quota exhausted — prepay the next batch` |
| 8 | Otherwise | `200`, header `AIFP-Quota-Remaining`, `req.aifp` populated |

Verification is local and stateless: an Ed25519 signature checked against our
published JWKS, in your process, pinned to `EdDSA`. Your latency never depends
on ours. Pass `jwks: { keys: [...] }` to remove even the JWKS fetch (at the cost
of a redeploy when we rotate keys).

**The 402 an agent sees:**

```json
{
  "error": "AIFP-402",
  "detail": "Payment Required — prepay a batch of requests and retry with the AIFP-Receipt header",
  "protocol": "AIFP-1",
  "merchant_id": "mrch_acme",
  "resource": "/api/search",
  "tier": "complex",
  "unit_weight": 4,
  "unit_price_usd": "0.002",
  "min_requests": 50,
  "protocol_fee_bps": 100,
  "no_minimum_fee": true,
  "how_to_pay": [
    "POST https://api.aifinpay.io/v1/quote {\"merchant_id\":\"mrch_acme\",\"resource\":\"/api/search\",\"tier\":\"complex\"}",
    "settle the quoted batch on-chain from your own wallet (order_id = quote_id)",
    "POST https://api.aifinpay.io/v1/pay {quote_id, chain, asset, tx_ref} -> quota receipt",
    "retry this request with header: AIFP-Receipt: <receipt JWT>"
  ]
}
```

**And what your handler gets on a paid call:**

```js
req.aifp
// { agent: "agt_…", receipt_id: "rcpt_…", resource: "/api/search",
//   weight: 4, unit_quota: 200, used: 8, remaining: 192, mode: "paid" }
```

### Pricing

Three fixed settings, per call. The displayed/quoted AIFP-1 price is the
**gross amount paid by the agent**. AiFinPay receives **1% of that gross amount**
and the merchant receives **99% of gross** before external network or settlement
costs. The 1% fee is **not added on top** of the displayed AIFP-1 price.

| Tier | Gross price paid by agent | Merchant 99% | AiFinPay 1% | Billing units per call |
|---|---:|---:|---:|---:|
| `standard` | $0.0005 | $0.000495 | $0.000005 | 1 |
| `complex` | $0.002 | $0.00198 | $0.00002 | 4 |
| `premium` | $0.005 | $0.00495 | $0.00005 | 10 |

AIFP-2/x402 is a separate route: the provider receives 100% of its
provider-defined price, while any AiFinPay AIFP-2 fee is payer-side/on-top. The
current AIFP-2 fee is 0%; a future non-zero fee requires a versioned AIFP-2
settlement profile and must not reduce the provider amount.

Weight is always price ÷ base price. That equality is what lets one prepaid
batch be spent across endpoints of different tiers and still drain at each
endpoint's real rate. Override per route with `unit_weight` when a call is
genuinely more expensive than its tier.

### Options worth knowing

| Option | Default | Why you would change it |
|---|---|---|
| `store` | `MemoryStore` | Anything beyond one process. See §3. |
| `registry` | — | Path-matched pricing from your registered endpoints. |
| `onStoreError` | `"closed"` | `"open"` trades metering for availability, visibly. |
| `onEvent` | — | `402` / `serve` / `403` / `meter_error` for your own metrics. |
| `allow` | — | Your own veto, evaluated **before** any unit is metered, so a refused call costs the agent nothing. |
| `jwks` | fetched | Pin the key set; removes all runtime network dependency on us. |
| `requireAgentMatch` | `false` | Compares `AIFP-Agent-Id` to the receipt subject. Anti-accident, not anti-theft — the header is not authenticated. |
| `refundOnError` | `false` | Give a unit back on a 5xx. Read the warning below first. |

`refundOnError` fires after your response has already gone out. If the agent
received a body, the refunded unit is a unit it got served for free — a slow
double-spend. Enable it only when your upstream fails *before* doing any work,
and understand that you are trading exact metering for generosity.

---

## 5. What this package does **not** do

- **It does not hold money or keys.** No custody, no funds movement. Agents
  settle on-chain to your own wallet; this package verifies a receipt and counts.
- **It does not enforce merchant policies.** Free-unit allowances, per-agent
  daily caps, blocklists and unlimited-access rules are evaluated by the hosted
  AiFinPay gateway. A second implementation of a rule you edit in our dashboard
  would be a second source of truth, and the two would disagree on the day it
  mattered. Use `allow` for rules that are genuinely yours.
- **Self-hosted traffic does not populate the panel's funnel, geo and AI-client
  charts.** Those are written by the hosted gateway from traffic that passes
  through it. Your registered endpoints still appear; the per-request analytics
  do not. Use `onEvent` to feed your own metrics.
- **It cannot bind a receipt to a caller.** A receipt is a bearer token. Anyone
  who obtains the JWT can spend the batch. The honest guarantee is **bounded
  loss**: a stolen receipt can spend at most the units the payer prepaid, and
  the post-increment counter makes overspending impossible. It is not
  non-repudiation, and `requireAgentMatch` does not make it so.

---

## Related

- [`@aifinpay/agent`](https://www.npmjs.com/package/@aifinpay/agent) — the other
  side: an SDK for the agent that pays your paywall.
- [`@aifinpay/mcp`](https://www.npmjs.com/package/@aifinpay/mcp) — MCP server
  for agents that pay through an MCP host.

MIT © CoinSecurities (SECCO)
