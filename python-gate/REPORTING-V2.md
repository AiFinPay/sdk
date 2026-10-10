# Reporting v2 — explicit Python producer

Frozen contract: `reporting.v2.20261009`, S06 of REPORTING-FUNNELS-20261009.
Source candidate `aifinpay-gate`0.1.3 / `aifinpay-agent`2.5.1, unpublished.
The existing `GateReporter` and `on_event=` integration remain strict v1.
Use one version per producer; never attach both or add overlapping totals.

```python
from aifinpay_gate import Gate, GateReporterV2, Route, AifpGateMiddleware

# Create AFTER a worker fork. Supply only stages your adapter actually wires.
reporter = GateReporterV2(
    merchant_id=merchant_id,
    merchant_secret=merchant_secret,  # server only; never browser or logs
    supported=["access_challenged", "access_admitted", "resource_response_completed"],
)
gate = Gate(merchant_id, routes=[Route("/api/*")], reporting=reporter)
app.add_middleware(AifpGateMiddleware, gate=gate)
```

WSGI uses the same Gate with `AifpGateWSGI(app.wsgi_app, gate)`.
Installing a producer alone does not establish instrumented stages or a
verified integration. Default channel/consent are unknown; no client ID is
generated or inferred. Gate/context callbacks must be synchronous, local
lookups, with no network I/O. Direct `Gate.decide()` has no response lifecycle;
it never asserts emitted402 or completed bytes.

An integrator may provide `reporting_context=lambda req: {...}` with exact
`channel,consent` and optional `client_id,reporting_token` keys. Channel is
browser/api/unknown; consent is granted/denied/unknown. A normalized random
UUID client_id is permitted only after explicit consent=granted and remains
an unverified, site-scoped observation. Never derive it from wallet,
AIFP-Agent-Id, User-Agent, IP, fingerprint, request content or an access JWT.
Context is copied per request. Invalid/throwing context loses attribution
without changing gate decisions. A syntactically valid AIFP-Reporting-Token
header is copied unless the callback explicitly supplied a reporting_token;
without a callback the channel/consent stay unknown. Invalid header syntax
loses correlation only; backend validates actual scope, expiry and integrity.

## Flow mint and exact wire facts

`reporter.mint_flow(resource="/api/*", channel="api", consent="denied",
request_id=uuid)` makes one explicit bounded request to
`POST /v2/merchants/:id/reporting/flows` with existing AIFP-Merchant-Secret.
The result is a frozen `ReportingFlow(flow_id,reporting_token,expires_at,mode,resource)`
or None. Token is hidden from repr. Omitting request_id generates a random UUID;
reuse the same request_id explicitly for an identical mint retry. Gate never
mints synchronously. No mint retries or capability storage are implicit.
Keep the returned capability only in memory; it permits observations, never
payment, receipt validation, access, identity verification or ownership.
Registered route, server mode and15minute expiry are backend-owned.

`reporter.on_event(event)` / calling the reporter directly accepts one exact
ReportedEvent and returns bool. Required keys: `id,name,resource,at,channel,consent`.
Optional keys: `client_id,reporting_token,outcome,status,reason`; null/unknown
keys are refused. IDs use lowercase RFC UUID; at is calendar-valid UTC with
milliseconds and new facts stay within−24h/+5min. Resource is the registered
ASCII route pattern≤512bytes, never full URL/query/fragment/path parameters.
No bodies, sessions, wallets, raw JWTs, amounts or arbitrary error/metadata.

Supported names: access_challenged, access_admitted,
resource_response_completed. Completion requires success/redirect/error/abort;
finished status100..599 maps2xx→success,3xx→redirect,otherwise→error. Abort
includes status only if actual headers were emitted. Reasons are limited to
receipt_missing,receipt_rejected,quota_exhausted,upstream_error,client_abort,unknown.
An issued402 never means paywall_viewed. Admission never means payment or
successful resource delivery. Exempt/open/uncovered/discovery traffic is not
reported as paid admission. Browser observations require their separate API.

## Queue, acknowledgement, health and shutdown

- ≤1000queued/in-flight events per process, batches≤50 and≤64KiB, flush1s.
- Each HTTP attempt has a3s end-to-end caller deadline, including header/body
  wait. One transport may remain inside OS/DNS after timeout; no second
  transport thread starts until it exits. A late response is discarded and
  an equal retry retains the original event ID/time/facts.
- Events expire after15minutes queued;≤5attempts with1/2/4/8s backoff (zero
  jitter within the bound). Flush does not bypass retry backoff. Pending equal
  facts are deduplicated before freshness; conflicting pending facts are refused.
- POST `/v2/merchants/:id/gate-events` sends only `{version:2,events:[...]}`.
  Delivery requires strict `{version:2,accepted,duplicates,received_at}` with
  nonnegative integer counts summing to batch size. An HTTP2xx alone is not ack.
  Malformed ack retries boundedly;400/403/409/other permanent4xx and redirects
  are never retried. Auth failures stop/drop the producer;409 drops that batch
  without overwriting facts or calling access/payment APIs.
- `health_sample()` atomically allocates a monotonically increasing sequence
  for a process-random producer UUID. Counters are decimal strings≤20digits.
  `health()` attempts the frozen sample; the worker also sends automatically,
  no faster than5s (≤12/min). Lost-ack retries retain sample/sequence/facts.
  POST `/v2/merchants/:id/reporting/health` is acknowledged by exactly `{version:2,duplicate:bool}`
  (the backend health handler body), not by the event batch ack.
- `stats` has local queued/pending/delivered/dropped/retries, bounded last_error,
  producer_id and last_sample. Remote queue/drop coverage stays unknown until
  an acknowledged sample. Health supported stages are explicitly declared;
  remote gap>5minutes is interpreted by the backend. Lifetime samples are not
  summed. Forked instances return unknown counts and never acquire inherited
  locks or send; create a new instance/producer in the child.
- `flush(timeout=10)` bounds waiting for the queue snapshot; background retries
  remain pending. `close(timeout=10)` stops acceptance, attempts that snapshot,
  drops remaining events, stops the worker within the budget. Call close during
  application shutdown. A timed-out OS transport is daemonized, cannot enqueue
  or acknowledge late facts, and may finish after shutdown. Crash loses the
  memory queue: incomplete coverage/lower bounds, no durable outbox claim.

ASGI records a finished402 only after its terminal JSON body send succeeds;
failed headers/body or cancellation emit no challenge. Admitted
response finishes only after final body (and promised trailers). Disconnect,
cancel, failed send or unfinished handler gives one abort; status500 finish
gives error. WSGI observes write/iteration, exhaustion and early close, closes
the underlying iterable once, and records one terminal event. Calling
start_response alone is not delivered content. WSGI cannot prove TCP delivery
or client reading; servers must call close on interrupted iterables. Neither
adapter infers an unseen disconnect by draining the request body.

## Optional payer header

`AiFinPayAgent.fetch_paid(..., reporting_token=capability)` and
`aifinpay.aifp1.aifp1_fetch(..., reporting_token=capability)` send it only on
the intended canonical POST `/v1/quote`, with redirects disabled.
`Agent.quote_split(..., reporting_token=capability)` sends it only on its
canonical GET `/api/b2b/quote-split`, also with redirects disabled when attached.
`Agent.pay(..., method="POST", reporting_token=capability)` supports the initial
canonical quote request only; no header is copied into its auth retry.
Origins are exactly https://api.aifinpay.io or https://aifinpay.io. Foreign,
credential-bearing, query/fragment and noncanonical targets lose attribution.
Do not put tokens into requests.Session defaults or manually supplied headers.

Token syntax is43base64url characters; invalid options are omitted and do not
change access/payment. No reporting header on merchant resource GETs,
JWKS/RPC/price sources, `/v1/pay`, financial signatures, Solana quote-admission
body, grants, receipt caches, spend ledger, journal or recovery. Reusing a
receipt or recovering an uncertain payment cannot create another reporting
quote or payment. Backend optional attribution failure must preserve the
required original quote operation; actual cross-component acceptance is S03.

## Evidence boundary

Author tests use synthetic signing, mocks, actual FastAPI/Flask, POSIX fork and
localhost-only wire fixtures; no production credentials, external API/RPC,
payment, partner rollout, publication or Git change. Backend commit-before-ack,
scope/expiry/erasure, PG races, Node interoperability and deployed partner
coverage require later independent acceptance. See the exact author
[assumptions/handoff](../docs/stories/reporting-funnels-s06-assumptions.md).
