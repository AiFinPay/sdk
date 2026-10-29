# REPORTING-FUNNELS-20261009 — S05 author handoff

2026-10-09. Frozen contract `reporting.v2.20261009`. Owner «Так» and current
dispatch authorize this implementation; high risk / 20% supervised AI cap.
Independent QA, Security, code review and human merge gates remain pending.

Historical author handoff only. All counts, pass/fail dispositions and source
freeze observations below describe the dated work, not current pass/readiness
evidence. Reproduce against [gate tests](../../gate/tests/),
[Node tests](../../node/tests/) and [candidate CI](../../.github/workflows/ci.yml).
Retained authoritative controls are the [independent Node regression](../../gate/tests/reporting-funnels-independent.test.ts)
and [independent review](../security/reporting-funnels-sdk-security.md).

## Decisions / working log

- Read SDK/gate/Node AGENTS, inherited AGENTS + complete SDLC/dev rules,
  principal YAGNI, architecture, ADR0010, complete story plan and PRD.
  SDK root inherited package is absent; read the installed shared package at
  `../aifinpay-reporting/backend/node_modules/@daochild/agents-config`.
- Separate `createGateReporterV2` is the explicit producer opt-in. Legacy
  `createGateReporter` remains unchanged. Integrators select one producer.
- Flow mint is an explicit helper, never a synchronous requirement of a gate
  decision. Capabilities and caller consent context remain memory-only.
- Express observes challenge only at actual finished402; completion hooks
  apply to admitted paid resource calls. Exempt/open calls stay outside this
  paid access funnel. Core exposes the resolved registered resource to the
  adapter without claiming HTTP delivery.
- Use actual canonical `node/tests/reporting-funnels-v2.test.ts`; the story's
  proposed `node/test/` path is superseded by its canonical-directory amendment.
- Optional payer token is call-scoped; only canonical `/v1/quote` and explicit
  first-party API calls can receive it. No gateway/partner, pay, authorization,
  admission journal, recovery or policy fields gain telemetry authority.
- No new dependencies, services, probes, financial calls, Git operations or
  publication. Backend HTTP integration waits for S03; local frozen-contract
  adapter acceptance is the current deliverable.

## Assumptions

- Registered resource ownership and token cryptographic scope are validated by
  the backend; SDK validates exact wire syntax. A backend contract change
  invalidates this assumption and requires architect coordination.
- Consent/caller context is explicitly supplied by the integrator, never
  inferred from User-Agent, IP, AIFP-Agent-Id or a payer wallet. Random UUIDs
  represent site-scoped unverified observations only.
- Owned loopback HTTP fixtures and existing dependency runtime symlinks are
  allowed for offline author validation; no dependency installation/lock refresh.

## Acceptance evidence

- Initial new producer red:17/17 FAIL, missing factory. First implementation:
  gate TypeScript PASS;45PASS/1FAIL across v2 + legacy reporter29. The one
  failure regenerated a wall-clock timestamp in the expected fixture; fixed
  by comparing the immutable original fact. No product timestamp rewrite.
- Node source baseline replay via read-only sibling originals:6PASS/3FAIL,
  missing quote/Agent/unified token propagation. Current source:9/9PASS,
  including actual Ed25519 receipt validation and original once-only simulated
  settlement/auth/recovery controls; zero external financial requests.
- Expanded restricted v2 run:30PASS/15FAIL;14 are owned-loopback listen EPERM,
  one health fixture reused an already-consumed Response stream. Fixed fixture
  to construct fresh responses; scoped loopback retry follows. Neither is
  reported as backend runtime regression or skipped acceptance.
- Supplied baselines gate154/154, legacy reporter29/29 and Python gate219/219
  are historical evidence; legacy29 was also executed unchanged above.
- Final source inspection found registry fallback paths could be labelled
  registered simply because a registry was configured. Capture the actual
  resolved registered pattern during decision instead; unmatched caller paths
  remain outside reporting. No access/quota behavior changed. Enforce one
  producer: v2 plus legacy onEvent wiring refuses at configuration time.
- Source inspection also found a disconnect during awaited verification/store
  could precede listener attachment. Adapter now checks an already-destroyed
  response after registering its once-only listeners; delayed-meter realHTTP
  controls exercise abort without invented status on both Express majors.
- Actual lost-ack HTTP replay initially51PASS/1FAIL: the fixture rewrote the
  logical HTTPS collector to loopback but retained Response.url=loopback.
  Producer correctly refused that unexpected response origin. Corrected only
  the injected fixture's logical response URL; actual HTTP bytes/status/stream
  and the product redirect/origin guard remain intact. Replaying acceptance.
- Final concurrency inspection produced two meaningful author reds: health403
  during an inflight accepted batch counted that fact as both delivered and
  dropped; close returned while health was still in flight. Corrected auth
  shutdown to reconcile active acknowledgement before dropping remainder and
  close to await bounded outstanding health/mint calls. Focused replay had
  2FAIL/52 filter-excluded controls after correcting one Promise fixture typo;
  those52 are not acceptance skips. Full nonfiltered replay follows.

## Final author evidence / implementation handoff

- The dated author replay exercised complete gate and Node payer suites.
  Current totals/outcomes must come from the linked tests and fresh CI, not
  this historical freeze. No live API/RPC/partner/financial request was made.
- Explicit v1 reporter29/29 was executed; its interfaces/implementation body
  byte-compares unchanged against the read-only original sibling. Python219
  is the supplied historical baseline, not rerun or certified by this author.
- Red evidence: initial producer17FAIL→54PASS; read-only payer baseline
  6PASS/3FAIL→9PASS. Final concurrency2FAIL→PASS included in the54-control
  complete replay. Restricted-loopback EPERM and timestamp/Response/logicalURL/
  Promise fixture corrections above remain qualified harness history. Focused
  filter-excluded controls are not acceptance skips; final runs excluded none.
- Gate TypeScript build and Node actual safe build script PASS; both actual
  registry checks PASS. Scoped ESLint PASS, formatting applied only to owned
  paths. Generated declarations verified against public exports. Four package
  manifest/lock JSON comparisons prove only version changed; dependency and
  other manifest/lock data are identical to original source. Gate0.4.0 and
  agent2.6.0 are unreleased source candidates, not publication/readiness claims.
- Real adapters: Express4/5 emitted402≠view, paid admission≠completion,
  once-only2xx/3xx/error/stream abort and pre-header delayed-meter abort,
  reporting503 preserves original response/quota. Actual HTTP lost-ack replay
  retains same accepted facts beyond new-event late bound; mock collector map
  is a wire fixture, not real backend PG durability. Injected transport maps a
  single asserted logical HTTPS collector to owned ephemeral127.0.0.1; no
  production response-origin guard is disabled. Fixture servers are closed.
- Node controls now generate payer keys only in memory, actually sign and
  verify wallet authorization, and verify synthetic Ed25519 receipts through
  the existing SDK. Exactly one simulated transfer/auth/pay and receipt reuse;
  pay refusal preserves original recovery, absent/invalid telemetry preserves
  result, custom origins receive no capability. Token never enters JSON,
  authorization, budget hooks, prepared recovery or partner/JWKS headers.
- Local producer stats are not report completeness: `lastSample:null` means
  no acknowledged remote sample, pending/drop coverage unknown remotely.
  No backend reporting reader/projection/retention/cryptographic scope, browser
  consent storage, erasure implementation or partner rollout is claimed here.
- Applied inherited YAGNI to keep one separate producer and one shared fixed
  first-party header helper, within existing layers and dependencies. Author
  source inspection used the already-read architecture-auditor checklist for
  source/trust/queue/compatibility boundaries; two concurrency findings and
  registry/early-abort fixes are recorded above. This is not an independent
  Security/QA/review approval or measured80% coverage claim (coverage=null).

Public functions from both gate reporter/root:
`createGateReporterV2`, `validReportedEvent`, `validReportingContext`.
Public interfaces: `GateReporterV2Options`, `GateReporterV2`,
`GateReporterV2Stats`. Exact exported wire types: `UUID`, `UTC`, `Mode`,
`Channel`, `Consent`, `ResponseOutcome`, `ServerObservation`,
`BrowserObservation`, `ReportingReason`, `ReportingContext`, `FlowRequest`,
`FlowResponse`, `ReportedEvent`, `Batch`, `BrowserEvent`, `HealthError`,
`HealthSample`, `Ack`, `ErrorResponse`. Existing legacy exports remain.
Node adds `Aifp1FetchOptions.reportingToken?:string` (through the existing root
type export), `Agent.quoteSplit` optional argument and source-module exported
`reportingHeaders`; Node root/index/export map is unchanged.
Detailed usage, wire endpoints and bounds: `gate/REPORTING-V2.md`.

Exact authored paths under
`/Users/regrttrol/Documents/code/AiFinPay/sdk-reporting/` (18):

1. `gate/src/reporter.ts`
2. `gate/src/core.ts`
3. `gate/src/express.ts`
4. `gate/src/index.ts`
5. `gate/src/types.ts`
6. `node/src/aifp1.ts`
7. `node/src/agent.ts`
8. `node/src/unifiedAgent.ts`
9. `gate/REPORTING-V2.md`
10. `gate/package.json`
11. `gate/package-lock.json`
12. `gate/CHANGELOG.md`
13. `node/package.json`
14. `node/package-lock.json`
15. `node/CHANGELOG.md`
16. `gate/tests/reporting-funnels-v2.test.ts`
17. `node/tests/reporting-funnels-v2.test.ts`
18. `docs/stories/reporting-funnels-s05-assumptions.md`

Ignored runtime outputs: built only gate/node `dist/`; existing gate runtime
symlink retained; new ignored Node dependency symlink points to existing
`../aifinpay-sdk/node/node_modules`. No installation/dependency refresh.
Python, UI, SDK root CHANGELOG and all other product paths remain read-only.
No Git, publish, live API/RPC, paid transaction, secret/profile, partner,
cloud or new-service action. MAIN coordinates root CHANGELOG/cohort and later
S03/S04 HTTP integration separately; no automatic release is implied.

Historical source identity belongs in version control and CI artifacts, not a
duplicated freeze table. Source references:
[reporter](../../gate/src/reporter.ts), [adapter](../../gate/src/express.ts),
[payer](../../node/src/aifp1.ts), [gate controls](../../gate/tests/reporting-funnels-v2.test.ts),
[payer controls](../../node/tests/reporting-funnels-v2.test.ts) and
[guide](../../gate/REPORTING-V2.md). These links are navigation, not attestations
that today's files match the dated review.

Implementation self-check: patterns/scope/no new dependencies/assumptions PASS.
Independent QA, Security, engineering review, human merge gates and actual
backend integration remain PENDING. Author does not self-approve those gates.

HANDOFF: sdlc-qa | artifact: sdk-reporting source + docs/stories/reporting-funnels-s05-assumptions.md | gate: implementation pass | requirement: REPORTING-FUNNELS-20261009/S05

## SEC-SDK-01 author remediation — 2026-10-09

- Read complete independent QA/Security reports and both retained Node/Python
  independent test files read-only. Python SEC-SDK-02 remains outside S05.
- Actual unchanged independent Node replay:48PASS/1FAIL/0SKIP (49controls).
  Complete simulated [0,60) seconds with503 and public health calls each second
  reproduces15HTTP attempts, exceeding12. No fixture or assertion changed.
- Root cause: the5s guard protected only new health samples; pending retries
  used shorter event backoff. Repair will enforce the floor across all health
  attempts and max(5s,event backoff) on retry scheduling. Event retry pacing,
  immutable health facts/sequence, attempts/age, support claims and v1 stay fixed.
- Captured247package file hashes (245pre-existing +2retained independent tests)
  plus both independent reports/root CHANGELOG/S05/S06 assumptions before edits
  for scoped drift checks. No independent artifact or Python write authorized.
- Applied the health-only floor in admission and retry scheduling. Added author
  boundary checks at1s/4999ms/5s and complete60s success/outage controls; existing
  event1/2/4/8s controls remain unchanged. Updated only the existing Node guide.
  This repairs pacing, not reporting coverage or backend readiness claims.
- The historical repair replay exercised the unchanged independent regression,
  complete gate/payer suites, v1 identity/version-only checks, TypeScript and
  scoped ESLint without filtered/skipped acceptance or waiver. The added minute
  controls and retained repro, not copied suite totals, define current coverage.
- Complete-minute author controls record11attempts for503 and12for successful
  ACKs; every spacing>=5s. Frozen outage samples retain identical bodies for
  their five attempts; new sequence appears only after exhaustion. Earlier
  event1/2/4/8s +five-attempt independent control still passes unchanged.
- All34reviewer baseline pins matched at author start. End package inventory
  remains247(245pre-existing +2retained independent tests), no additions or
  removals. This author changed exactly reporter, author test, Node guide and
  this S05 log. Concurrent changes observed in Python guide/ASGI/author test/
  S06 log; untouched by this author, so no global245-file freeze is claimed.
  Only three of the17Node S05 product/test/document identities changed; the
  other14retain their independent-review pins. Both retained independent tests
  and both QA/Security reports remain byte-identical to remediation start.
- No API/type/export/support-stage/version/dependency change; no Python,
  independent artifact, root CHANGELOG, Git, deploy, install or live request
  write/action. Reviewer must close SEC-SDK-01 independently on these new bytes;
  SEC-SDK-02 and all broader QA/Security/backend/release gates are not certified.

Replay from package directories with source dependencies configured:

```sh
# gate: retained independent regression; complete [0,60) pacing
node node_modules/vitest/vitest.mjs run --no-cache tests/reporting-funnels-independent.test.ts
# gate and node, separately: complete suites, no filter
node node_modules/vitest/vitest.mjs run --no-cache
# gate: build and scoped lint
node node_modules/typescript/bin/tsc -p tsconfig.json
node node_modules/eslint/bin/eslint.js src/reporter.ts tests/reporting-funnels-v2.test.ts
```

Loopback permission is required only for owned HTTP adapter fixtures.
The repair and independent repro remain in the source/control links above.
For the dated independent closure and limitations, see the
[QA report](reporting-funnels-sdk-independent-tests.md) and
[security report](../security/reporting-funnels-sdk-security.md).
Fresh source-bound CI/review, not these historical freeze observations, must
establish current acceptance.

HANDOFF: MAIN / independent reviewer | SEC-SDK-01 author repair and replay PASS | independent finding closure PENDING | no waiver
