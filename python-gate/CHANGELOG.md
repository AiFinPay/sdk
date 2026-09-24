## 0.1.0 — unreleased

- First release: `Gate` (framework-agnostic decision), `AifpGateMiddleware`
  (ASGI: FastAPI, Starlette) and `AifpGateWSGI` (Flask, Django), path routes
  with trailing `/*` wildcards and per-route tier/weight/methods,
  `MemoryStore` and `RedisStore`, `known_ai_agent`, `/.well-known/x402.json`.
- Parity with `@aifinpay/gate` 0.3.4: 29 recorded scenarios, the 402 body,
  discovery document, scope table and constants replay identically.
- Verified against real receipts on a Polygon fork: an agent's USDC purchase,
  metering 199 → 198 on the same receipt, a forged receipt refused.
