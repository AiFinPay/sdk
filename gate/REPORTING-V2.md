# Node reporting v2 — explicit producer opt-in

Contract `reporting.v2.20261009`, requirement `REPORTING-FUNNELS-20261009/S05`.
Source candidate gate0.4.0 / agent2.6.0. Independent QA/Security/engineering,
backend S03 integration, publication and partner rollout remain separate.

## Wiring a merchant gate

```ts
import { aifpGate, createGateReporterV2, MemoryStore } from "@aifinpay/gate";

const reporter = createGateReporterV2({
  version: 2,
  merchantId,
  merchantSecret,
  supported: ["access_challenged", "access_admitted", "resource_response_completed"],
});
app.get(
  "/api/search",
  aifpGate({
    merchantId,
    resource: "/api/search", // must match a registered route pattern
    store: new MemoryStore(),
    reporting: {
      version: 2,
      reporter,
      context: () => ({ channel: "api", consent: "unknown" }),
    },
  }),
  handler
);
// After the HTTP server has drained requests:
await reporter.flush();
await reporter.close();
```

Share one producer per merchant/process. The example's in-memory quota store
is for a single process; retain your existing production quota/JWKS setup.
Do not wire the legacy reporter/onEvent simultaneously. Core refuses combined
`reporting` and `onEvent` wiring. `createGateReporter` continues sending strict
v1 by default. V2 never calls v1 and legacy events never gain inferred identity.
Custom adapters may use `record`/`observe` and declare only their actual
supported stages; core alone reports no completed HTTP delivery.

Express4/5 observes emitted402 at `finish`, admission before the paid handler,
and a single terminal response across `finish`/`close`. Completed2xx means
`success`;3xx means `redirect`;other terminal statuses mean `error`.
Disconnect means `abort`, including disconnect while the gate awaits a store.
Abort status is present only after headers were actually sent. Exempt/open
calls do not enter the paid access funnel. Unmatched registry fallback paths
are not exported. Issuing402 is not a browser view; admission is not completion.
No body, IP, raw headers, receipt/JWT, agent/wallet identity or exception text
enters these events. `AIFP-Agent-Id` never establishes observed client identity.

## Public exports and exact wire types

Both `src/reporter.ts` and package root export:

- Functions: `createGateReporterV2(options): GateReporterV2`,
  `validReportedEvent(value): value is ReportedEvent`,
  `validReportingContext(value): value is ReportingContext`.
- Producer interfaces: `GateReporterV2Options`, `GateReporterV2`,
  `GateReporterV2Stats`.
- Wire types: `UUID`, `UTC`, `Mode`, `Channel`, `Consent`, `ResponseOutcome`,
  `ServerObservation`, `BrowserObservation`, `ReportingReason`,
  `ReportingContext`, `FlowRequest`, `FlowResponse`, `ReportedEvent`, `Batch`,
  `BrowserEvent`, `HealthError`, `HealthSample`, `Ack`, `ErrorResponse`.

`GateOptions.reporting` contains `{version:2,reporter,context?}`; context is a
synchronous `(request:GateRequest)=>ReportingContext`. It is copied once per
response; malformed/throwing context loses identity rather than access.
Optional `GateResult.reportingResource` carries the resolved registered
resource to adapters only. It is not an HTTP completion fact.

`GateReporterV2` has `version:2`, `record(ReportedEvent):boolean`,
`observe(Omit<ReportedEvent,"id"|"at">):boolean`,
`mintFlow(FlowRequest):Promise<FlowResponse|null>`, `health():Promise<boolean>`,
`flush()/close():Promise<GateReporterV2Stats>` and readonly `stats`.
`observe` makes the random event UUID/time once; `record` preserves supplied
facts and allows equal pending retries. Invalid/unknown fields are refused.
UUIDs are lowercase RFC UUIDs, timestamps calendar-valid UTC milliseconds,
resources ASCII static/wildcard patterns≤512 bytes with no URL/query/fragment/
path-parameter values. Only the three server observation names are accepted;
completion outcome/status/reason combinations are strictly checked.

Exact endpoints, with JSON bodies and `AIFP-Merchant-Secret` header:

| Operation      | POST path                            | Request                              | Success        |
| -------------- | ------------------------------------ | ------------------------------------ | -------------- |
| mintFlow       | `/v2/merchants/:id/reporting/flows`  | `FlowRequest`                        | `FlowResponse` |
| record/observe | `/v2/merchants/:id/gate-events`      | `{version:2,events:ReportedEvent[]}` | `Ack`          |
| health         | `/v2/merchants/:id/reporting/health` | `HealthSample`                       | `HealthAck`    |

Requests never contain body `mode`, `source`, payment claims or arbitrary
metadata. Additional success-response fields are refused; ACK accepted+
duplicates must equal batch size. Health answers `HealthAck`
`{version:2,duplicate:boolean}` instead, and nothing else is accepted for it. Redirects stop without
forwarding the secret. Diagnostics expose bounded error enums only.

## Flow and consent

Flow mint is explicit and optional, never performed in a gate decision:

```ts
const flow = await reporter.mintFlow({
  version: 2,
  request_id: crypto.randomUUID(),
  resource: "/api/search",
  channel: "api",
  consent: "unknown",
});
// flow may be null; preserve the original access/payment result.
const response = await agent.fetchPaid(
  resourceUrl,
  {},
  {
    ...existingPaymentOptions,
    reportingToken: flow?.reporting_token,
  }
);
```

Backend issues the15minute opaque capability and validates actual merchant/
resource/config/consent scope. SDK syntax validation is not cryptographic
validation. A copied token permits observations only, never paid/access,
ownership or integration verification. Preserve request_id and exact facts on
mint retry; concurrent same-fact mint calls share one request. A second distinct
concurrent mint returns null rather than building another queue.

Supply optional random site-scoped `client_id` only with `consent:"granted"`.
It remains unverified. Denied/unknown consent has no ID. Collection/storage
opt-in belongs to the integrator. Reset discards the old ID and capability;
backend erasure must be requested by its separate capability API. No browser
persistence is implemented here. Scope/time/signed-ledger linkage and erasure
are backend authority; this SDK never reconstructs historical identities.

## Optional payer header

`Aifp1FetchOptions.reportingToken?:string` works through
`AiFinPayAgent.fetchPaid`. The capability goes only to canonical first-party
`/v1/quote` at `https://api.aifinpay.io` or `https://aifinpay.io`, with the
existing redirect-refusing settlement transport. It is removed from gateway/
partner request headers, even if supplied through RequestInit. Custom quote
origins and arbitrary redirects never receive it. Invalid token syntax silently
omits the optional header; it cannot retry a transfer or change auth/policy.

`Agent.quoteSplit({...existingArgs,reportingToken?})` supports the fixed
first-party `/api/b2b/quote-split` view call and stops redirects when a token is
attached. This is optional propagation, not proof that a B2B price-view endpoint
creates an authoritative flow/quote witness. Backend frozen `/v1/quote` linkage
is the later S03/S04 integration contract. The shared syntax/destination helper
`reportingHeaders(token:unknown,endpoint:string):Record<string,string>` is
exported from `node/src/agent.ts`; existing Node package export map is unchanged.

Tokens are not added to pay JSON/headers, quote authorization statements,
budget binding, durable admission, prepared journal, recovery, receipts,
access/auth/policy or payment retry logic. Keep them in memory only, never
URL/query, logs, local/session storage, cookies or recovery files.

## Bounds, loss and health

Event queue≤1000 including inflight, batches≤50/64KiB, auto flush after1s,
each request/header/body deadline3s, event queue age15min, at most5 attempts,
retry backoff1/2/4/8s ±10% jitter. New timestamps are within24h late/5min future.
Equal pending retries compare immutable facts before timestamp freshness.
Backend handles accepted-fact expiry exceptions on retransmission. New unknown
IDs outside the late bound are refused locally; no90day SDK outbox exists.
No mutation/renewal of IDs or timestamps.
No retry400/403/409 or other permanent4xx, or redirects. Auth failures stop
the producer and drop pending events. Transient failures retry only telemetry.
`flush` attempts current unsent/due records once; it cannot accelerate pending
backoff. `close` refuses new records, flushes eligible records once and drops
remaining retries; it is idempotent. Process crash loses unacknowledged events.

Health auto-samples every60s; all `health` attempts, including failed retries,
are at least5s apart (at most12attempts in [0,60) seconds). Retry delay is
max(5s,event backoff), retaining frozen sample facts/sequence,5attempts and
15min age. Explicit calls cannot bypass either delay. Each
process has a new random producer_id. Counters are decimal strings≤20 digits;
sequence increases only for a new sample. No new timer drives financial work.
Remote report queue/drop metrics are unknown until a sample is acknowledged;
`stats.lastSample===null` exposes that state. Local `stats.pending/dropped`
are local producer counts, not a durable/complete traffic claim. A health gap
after5min and overlapping process lifetimes are handled by backend coverage;
never sum superseding lifetime counters. Uninstrumented browser/payment/ledger
stages remain unsupported. Raters rollout and integration verification are not
established by installing this source candidate.

Author verification runs only local synthetic endpoints, actual Express4/5,
strict producer transports and actual SDK receipt/auth/recovery adapters.
Backend PG/Redis dedupe, conflicts, token cryptographic scope, retention and
reports require the later S03/S04 integration and independent acceptance.
