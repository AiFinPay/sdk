## 0.1.2 — unreleased

- Add explicit opt-in merchant request reporting through the existing gate event
  callback. UUID-stable bounded batches/retries, HTTPS-only/no redirects, sanitized
  drop/outage status and best-effort flush/shutdown; no payment/quota changes.
- Report only registered canonical 402/gate-admission events, excluding exempt
  humans and sensitive request fields. Document observation coverage and lifecycle.

## 0.1.1 — unreleased

Fixes for bugs found by the coverage pass (AiFinPay/sdk#96); P1, P5, P6 and
P7 also ship in `@aifinpay/gate` 0.3.5.

- P1: the quota counter and single-use nonce now live until
  `exp + clock_tolerance_s`, as long as the verifier accepts the receipt. They
  used to expire at `exp`, so a spent batch refilled for 30 seconds.
- P2: a receipt whose header nests thousands of JSON arrays is refused with
  403. It used to raise `RecursionError` out of `Gate.decide`, which an
  adapter with `on_store_error="open"` treated as an outage and served free.
- P9: a truncated or malformed JWKS response (`http.client.HTTPException`)
  fails closed with 503 instead of escaping `decide()`.
- P3: `Route(methods="POST")` gates `POST`. A bare string used to be iterated
  into `{"P", "O", "S", "T"}`, so the route matched nothing and was free.
- P5: `Gate(tier=...)` refuses an unknown tier, as `Route` does.
- P6: a call refused for not fitting takes its increment back, so the units
  that remain stay spendable.
- P7: a store failure after the nonce check no longer burns a single-use
  receipt when the gate fails closed.

## 0.1.0 — unreleased

- First release: `Gate` (framework-agnostic decision), `AifpGateMiddleware`
  (ASGI: FastAPI, Starlette) and `AifpGateWSGI` (Flask, Django), path routes
  with trailing `/*` wildcards and per-route tier/weight/methods,
  `MemoryStore` and `RedisStore`, `known_ai_agent`, `/.well-known/x402.json`.
- Parity with `@aifinpay/gate` 0.3.4: 29 recorded scenarios, the 402 body,
  discovery document, scope table and constants replay identically.
- Verified against real receipts on a Polygon fork: an agent's USDC purchase,
  metering 199 → 198 on the same receipt, a forged receipt refused.
