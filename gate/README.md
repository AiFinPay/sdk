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
  merchantId: process.env.AIFP_MERCHANT_ID,
  resource: "/api/search",
  tier: "complex",
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

const merchant = new AifpMerchant();

await merchant.ensureResources([
  { route_pattern: "/api/search",    type: "api", tier: "complex" },
  { route_pattern: "/api/lookup/*",  type: "api", tier: "standard" },
  { route_pattern: "/api/report",    type: "api", tier: "premium", name: "Generate report" },
  { route_pattern: "/api/health",    type: "api", paywall_enabled: false },
]);

const registry = new ResourceRegistry({ merchant });
registry.start();

app.use(aifpGate({ merchantId: merchant.merchantId, registry }));
```

`ensureResources` is idempotent by `route_pattern`, so this belongs in your boot
script and is safe on every deploy. Re-running it converges instead of piling up
duplicates.

**These endpoints appear in your AiFinPay dashboard immediately.** The SDK writes
the same endpoint registry the dashboard's Paywall Builder writes and the
dashboard reads.

One prerequisite: **the merchant must be linked to a dashboard account.** The
simplest path is to create the merchant in the dashboard, copy the secret from
there, and give it to the SDK.

The rest of the management surface:

```js
await merchant.listResources();
await merchant.getResource("res_…");
await merchant.createResource({ route_pattern: "/api/new", type: "api" });
await merchant.updateResource("res_…", { tier: "premium" });
await merchant.deleteResource("res_…");
await merchant.merchant();
await merchant.stats();
await merchant.activity(50);
await merchant.setWebhook("https://you.example/aifp-webhook");
```

Errors are typed: `AifpValidationError`, `AifpAuthError`, and
`AifpConflictError`. The merchant secret is stored non-enumerably and never
appears in `JSON.stringify(merchant)`.

---

## 3. Choose a store

The gate meters a prepaid batch by counting billing units against the receipt.
The store has two rules:

1. **`incrBy` is atomic and returns the value AFTER the add.**
2. **The TTL is set on the first write only.** The counter must expire with the receipt.

**Default — `MemoryStore`.** Correct on one process only. Counters are lost on
restart, and every process gets its own copy. If you run more than one process,
use a shared store.

**Shared — `redisStore`.** Pass your own client:

```js
import Redis from "ioredis";
import { redisStore } from "@aifinpay/gate";

const store = redisStore(new Redis(process.env.REDIS_URL));
app.use(aifpGate({ merchantId, registry, store }));
```

Redis errors propagate rather than falling back to local memory. `onStoreError`
decides what happens (`"closed"` → `503`, the default; `"open"` → serve and flag).

For another datastore, implement `incrBy` and prove the contract:

```js
import { assertStoreContract } from "@aifinpay/gate/testing";
await assertStoreContract(() => myStore(), { equal: assert.equal, ok: assert.ok });
```

---

## 4. What the gate does per request

| # | Condition | Answer |
|---|---|---|
| 1 | Resolve the resource and its weight | — |
| 2 | The resource is registered with `paywall_enabled: false` | `200`, no units spent |
| 3 | No `AIFP-Receipt` header | `402` + the full challenge |
| 4 | Receipt expired | `402` — prepay a new batch |
| 4 | Bad signature, issuer, or audience | `403` |
| 4 | JWKS unreachable and nothing is cached | `503` — fails closed |
| 5 | Receipt is scoped to another path | `403` |
| 6 | Single-use receipt replayed | `403` |
| 7 | `used + weight > unit_quota` | `402` — quota exhausted |
| 8 | Otherwise | `200`, `AIFP-Quota-Remaining`, `req.aifp` populated |

Verification is local and stateless: an Ed25519 signature checked against the
published JWKS. Pass `jwks: { keys: [...] }` to pin the key set.

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

### Pricing

Three fixed AIFP-1 gross prices per call. The displayed/quoted price is the
**gross amount paid by the agent**. AiFinPay receives **1% of that gross amount**
and the merchant receives **99% of gross** before external network or settlement
costs. The 1% fee is **not added on top** of the displayed AIFP-1 price.

| Tier | Gross price paid by agent | Merchant 99% | AiFinPay 1% | Billing units per call |
|---|---:|---:|---:|---:|
| `standard` | $0.0005 | $0.000495 | $0.000005 | 1 |
| `complex` | $0.002 | $0.00198 | $0.00002 | 4 |
| `premium` | $0.005 | $0.00495 | $0.00005 | 10 |

This is AIFP-1 economics. AIFP-2/x402 is a separate payment route: the provider
receives 100% of its provider-defined price, and the current AiFinPay AIFP-2 fee
is 0%. Any future AIFP-2 fee is a separate payer-side fee-on-top profile and must
not be substituted into AIFP-1.

Weight is always price ÷ base price. Override per route with `unit_weight` when
a call is genuinely more expensive than its tier.

### Options worth knowing

| Option | Default | Why you would change it |
|---|---|---|
| `store` | `MemoryStore` | Anything beyond one process. |
| `registry` | — | Path-matched pricing from your registered endpoints. |
| `onStoreError` | `"closed"` | `"open"` trades metering for availability, visibly. |
| `onEvent` | — | `402` / `serve` / `403` / `meter_error` for your own metrics. |
| `allow` | — | Your own veto before a unit is metered. |
| `jwks` | fetched | Pin the key set. |
| `requireAgentMatch` | `false` | Compares `AIFP-Agent-Id` to the receipt subject. |
| `refundOnError` | `false` | Give a unit back on a 5xx; use only when upstream work did not complete. |

---

## 5. What this package does not do

- **It does not hold money or keys.** Agents settle on-chain from their own wallets.
- **It does not enforce hosted merchant policies.** Use `allow` for rules that are genuinely yours.
- **Self-hosted traffic does not populate hosted funnel/geo/AI-client analytics.** Use `onEvent` for your own metrics.
- **It cannot turn a bearer receipt into non-repudiation.** Keep batch sizes bounded.

---

## Related

- [`@aifinpay/agent`](https://www.npmjs.com/package/@aifinpay/agent) — agent-side payment SDK.
- [`@aifinpay/mcp`](https://www.npmjs.com/package/@aifinpay/mcp) — MCP server for agent payments.

MIT © CoinSecurities (SECCO)
