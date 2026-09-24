# aifinpay-gate (Python)

Accept payments from AI agents in a Python API. When an agent calls a paid
route without paying, the gate answers **HTTP 402** with everything it needs to
buy a batch of calls; the agent settles on-chain from its own wallet (you
receive 99%, AiFinPay 1%, non-custodial) and retries with an `AIFP-Receipt`.
The gate verifies that receipt **locally** — an Ed25519 signature against the
AiFinPay JWKS, no call to AiFinPay per request — and meters the batch.

A port of [`@aifinpay/gate`](https://www.npmjs.com/package/@aifinpay/gate): the
same 402 body, the same checks and the same refusal sentences, held to the Node
package by recorded fixtures (`tests/test_parity.py`).

```bash
pip install aifinpay-gate            # PyNaCl is the only dependency
pip install "aifinpay-gate[redis]"   # shared counters across processes
```

## Register

```bash
curl -s -X POST https://api.aifinpay.io/v1/merchants -H 'content-type: application/json' \
  -d '{"name":"My API","pay_to":{"evm":"0xYourPayoutWallet"},"settlement_version":"1.4"}'
```

Keep `merchant_id` and the one-time `merchant_secret`, then claim the merchant
at https://dash.aifinpay.io with the secret to see payments. One `pay_to.evm`
receives on every EVM network.

## FastAPI / Starlette (ASGI)

```python
from fastapi import FastAPI, Request
from aifinpay_gate import AifpGateMiddleware, Gate, Route

gate = Gate("mrch_…", routes=[
    Route("/create", "premium", methods={"POST"}),   # $0.005 per call
    Route("/api/*"),                                  # the section and everything under it
])
app = FastAPI()
app.add_middleware(AifpGateMiddleware, gate=gate)

@app.post("/create")
async def create(request: Request):
    paid = request.state.aifp      # {"agent", "receipt_id", "used", "remaining", ...}
    return {"ok": True, "remaining": paid["remaining"]}
```

## Flask / Django (WSGI)

```python
from aifinpay_gate import AifpGateWSGI, Gate, Route

app.wsgi_app = AifpGateWSGI(app.wsgi_app, Gate("mrch_…", routes=[Route("/api/*")]))
# in a view: request.environ["aifp"]
```

Both adapters also serve `/.well-known/x402.json` so agents discover the paid
routes before they hit one (`serve_discovery=False` to turn it off).

## Any other framework

```python
from aifinpay_gate import Gate, SimpleRequest

result = gate.decide(SimpleRequest(path, headers, method))
if result is None:        # not a paid route
    ...
elif not result.ok:       # 402 / 403 / 503 — send result.status, result.headers, result.body as JSON
    ...
else:                     # paid: add result.headers to your response; result.aifp is the metering context
    ...
```

## Routes

`Route(pattern, tier="standard", weight=None, methods=None, paywall=True)`

- `pattern` is exact, or ends in `/*` — `/api/*` covers `/api` and everything
  under `/api/`. The longest matching pattern wins. This is the hosted
  gateway's matcher; wildcards in the middle (`/backtest/*/bid`) are refused.
- `tier`: `standard` $0.0005, `complex` $0.002, `premium` $0.005 per call
  (weights 1, 4, 10 billing units). `weight` overrides the units per call.
- `paywall=False` serves the route free and meters nothing.
- Paths no route matches pass through untouched.

`Gate(merchant_id, resource="/api/search", tier="complex")` is the single-mount
form: every request handed to it is charged against that one resource.

## Production: share the counters

The default `MemoryStore` meters per process. Under gunicorn/uvicorn with
several workers, or several pods, each gets a full copy of every batch — a
200-unit batch serves up to 200 × workers calls. Use Redis:

```python
import redis
from aifinpay_gate import Gate, RedisStore

gate = Gate("mrch_…", routes=[...], store=RedisStore(redis.Redis.from_url(REDIS_URL)))
```

The store increments atomically and compares **after** the increment, so
concurrent requests can never overspend a batch; the counter's TTL is set once
and expires with the receipt.

## Options

| Option | Default | |
|---|---|---|
| `should_charge` | everyone pays | `known_ai_agent` for content sites: human browsers read free and never see a 402; self-identifying AI crawlers and anything speaking AIFP pay. A predicate that raises charges. |
| `allow(ctx)` | — | Your veto after verification, before metering (a refused call costs nothing). Return `False` → 403. |
| `on_store_error` | `"closed"` | `"open"` serves un-metered calls when the store is down (`AIFP-Meter: degraded`). |
| `require_agent_match` | `False` | Refuse when `AIFP-Agent-Id` differs from the receipt subject (anti-accident, not anti-theft). |
| `replay` | `"auto"` | Single-use receipts get a one-shot nonce check. |
| `jwks` | fetched | Pin the key set and skip network I/O (redeploy on key rotation). |
| `on_event(e)` | — | `402` / `serve` / `403` / `meter_error` events for your metrics. |
| `refund_on_error` (adapters) | `False` | Give the units back when your handler answers 5xx. |

## What it guarantees

- Fails **closed**: if the JWKS cannot be reached, paid routes answer 503, never free.
- Only EdDSA receipts from `https://api.aifinpay.io` with `aud` = your merchant id.
- Only quota receipts are spendable; per-call billing receipts are refused.
- An expired receipt gets a 402 (buy again), a wrong one a 403 with a reason.
- Stricter than the Node gate in two places: a receipt without a numeric `exp`,
  or without a usable `unit_quota`, is refused.

Not included, on purpose: free allowances, daily caps and per-agent blocks live
in the AiFinPay dashboard, so there is one source of truth for each rule.
