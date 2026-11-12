## 0.8.0 — the content licence travels with the content

- The 402 no longer carries `protocol_fee_bps`, and `PROTOCOL_FEE_BPS` /
  `MERCHANT_SHARE_BPS` are gone from `pricing`. The fee is set per merchant and
  stated by the quote.
- Port of the `@aifinpay/gate` licence headers: a receipt with a `lic` claim unlocks content with `AIFP-License` and `Link: rel="license"`, and `aifp["license"]`. Never on a refusal.

## 0.7.1 — what an independent review of 0.7.0 found

0.7.0 was never published.

- **Both adapters read a decoded path as if it were raw.** `/x%3F/../paid/a` reached the gate as `/x?/../paid/a` and was read as `/x`, so an app that resolves it served the paid page free. A `?` or `#` in a decoded path is now part of the path. Serious on any app that serves files; publish nothing before this.
- WSGI reads `PATH_INFO` as the bytes it holds and ASGI reads `raw_path` for a path outside ASCII, so a route with such a character is the page it names on both adapters.
- Port of `@aifinpay/gate` 0.10.1, including a path that reads the same when read twice: routes and a receipt's resource are read the way a path is read, an unregistered path is quoted as asked, a paid response drops a CDN's own cache headers, a prefix receipt for `/x/*` covers the section.
- A mount with no resource observes nothing for reporting v2: it would name the raw path, which is private.

## 0.7.0 — a path as an origin reads it, payer binding on, network mode, shadow spends nothing

- Port of `@aifinpay/gate` 0.10.0, which lists what answers differently and the way back from each. Options: `case_sensitive`, `network_mode`, `require_agent_match` on by default. `inspect_path` exported. Parity fixture regenerated, with the path table added.
- A route list no longer trusts the app's routing: `/PAID/a` and `/;x/paid/a` are `/paid/a`, on an app that resolves them or not.

## 0.6.1 — differences the conformance vectors found

- Port of `@aifinpay/gate` 0.9.1: a 402, 403 or 503, a paid response and a
  shadow would-be refusal carry `Cache-Control: private, no-store, max-age=0`,
  and a handler's own `Cache-Control` does not make a paid response storable.
  Exported as `NO_STORE`. Parity fixture regenerated.
- `AifpGateWSGI` sends no body on a HEAD refusal. A server that writes what it
  is given (waitress) otherwise broke the connection.
- A prefix receipt covers the section page: `/paid/` opens `/paid`, which is
  what the SDKs buy for a `/paid/*` 402.
- A route with `paywall=False` reports an exempt serve, not a plain one: the
  ingest counted it as a paid admission, and a reader on it was reported.
- A mount with neither `resource` nor `routes` marks its events `unregistered`,
  and the reporter drops them: the raw path is private.

## 0.6.0 — $0.02 minimum batch

- Port of `@aifinpay/gate` 0.9.0: `min_requests` 40 / 10 / 4 (was
  200 / 50 / 20), `Gate(min_batch_units=...)`, `min_requests_for_tier(tier,
  min_batch_units)` and `MIN_BATCH_UNITS`. Parity fixture regenerated.

## 0.5.0 — unreleased

- Port of `@aifinpay/gate` 0.8.0: `AifpGateMiddleware` and `AifpGateWSGI` add
  the discovery `Link` header (`</llms.txt>` as `rel="alternate"`,
  `</.well-known/x402.json>` as `rel="describedby"`) to every HTML response
  that passes through them, so an agent that opened a page finds the payment
  instructions. JSON, including the gate's own 402 / 403 / 503, never carries
  it; a page's own `Link` is kept. On by default; `discovery_link=False`
  switches it off, `discovery_link={"llms_txt": ..., "x402": ...}` moves
  either target (or drops it with `False`). No decision, status, event or
  metered unit changes.
- `discovery_link_header`, `is_html_content_type` and `LLMS_TXT_PATH`
  exported; the parity fixture records both helpers and `test_discovery_link.py`
  replays them.

## 0.4.0 — unreleased

- Port of `@aifinpay/gate` 0.7.0: `Gate(operator_policy=...)` — the merchant's
  allow / charge / block per operator, as saved on the dashboard, applied after
  classification and before `should_charge`. `allow` serves free (`mode
  "exempt"`, a `serve` event with `exempt: True`), `block` answers 403
  `AIFP-403` (a `403` event), `charge` is the gate's own decision; the event
  `detail` names the rule in enforce and shadow alike. A `verified_only` rule
  applies only once the receipt verified. Pass the dict from
  `GET /v1/merchants/:id` (`normalize_operator_policy` reduces it to what this
  gate can apply) or a callable returning the current one. `decide_operator`,
  `normalize_operator_policy`, `OPERATOR_ACTIONS`, `OPERATOR_DEFAULT` exported.
  No policy, or one without rules, changes nothing.
- The parity fixture records operator-policy scenarios; `test_parity.py`
  replays them.

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

## 0.1.4 — documentation refresh

- Remove versioned release snapshots from the README and reporting guide;
  clarify that source test fixtures do not establish live integration.

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
