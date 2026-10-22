## 0.3.0 — unreleased

- Port of `@aifinpay/gate` 0.6.0: `Gate(mode="shadow" | "enforce")`. Shadow
  makes the same decision and emits the same event as enforce, then serves
  the request — `AIFP-Mode: shadow` on every response, `AIFP-Shadow-Status`
  and `aifp["shadow"]` on a would-be refusal; nothing metered for it.
  Omitting `mode` is enforce; an unknown value raises. `HEADER_MODE` and
  `HEADER_SHADOW_STATUS` exported.
- The parity fixture now records the events of every Node scenario alongside
  the responses, and adds shadow scenarios; `test_parity.py` replays both.

## 0.2.0 — unreleased

- Port of `@aifinpay/gate` 0.5.0: every event carries `operator`, `ua_class`
  and `verified` from the shared marker table (`AI_AGENT_UA_TABLE`,
  `GATE_OPERATORS`, `UA_CLASSES`, `classify_agent`); `verified` only after the
  receipt verified. The parity fixture now holds the table and the
  classification of every recorded request equal to Node's.
- `GateReporter` sends the fields, forwards agent-class exempt serves as
  `exempt: true`, and falls back to the legacy shape on a 400 for the new one.

## 0.1.3 — unreleased

- Add explicit reporting-v2 producer, bounded flow mint/event/health transport,
  stable retries and consented observational context. V1 remains unchanged.
- Observe ASGI/WSGI streaming completion, aborts and terminal statuses once;
  admission and emitted402 remain distinct from successful resource delivery.

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
