# REPORTING-FUNNELS-20261009 — S05 author handoff

2026-10-09. Frozen contract `reporting.v2.20261009`. Owner «Так» and current
dispatch authorize this implementation; high risk / 20% supervised AI cap.
Independent QA, Security, code review and human merge gates remain pending.

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

- Actual Node executable: `/Users/regrttrol/.nvm/versions/node/v24.0.2/bin/node`.
  Final source freeze: gate208/208PASS across20files (154 existing +54new),
  Node734/734PASS across38files (725 existing +9new). Both0FAIL/0SKIP.
  Gate run3.66s, Node run17.06s; no live API/RPC/partner/financial request.
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

Frozen SHA256 (17 files; this working log deliberately excluded from self-hash):

```text
fc91257c3180d98dec1e17da9cfcb758e436d9705b5d3e95d6a6aefad04e1c1d gate/src/reporter.ts
c3bf561af0f408654bbe6cda39aa1b11e280e96f041b53d9b366052ac5efefd9 gate/src/core.ts
f711d03d0ff6a00c9bf6bcf088d1942e60159865c5a2f789998b9c72243d8b1e gate/src/express.ts
09d22eb7f07fb3817dcb6843bd030f26293d791a274546395655efc2e1c14a85 gate/src/index.ts
8cc9305d1d3aec674943e69d6bc69b09b2238212cce0b8a2c131ecf58af74fc1 gate/src/types.ts
ceb9de3a4e6c2e299ce3135f3fb9d42b4f0b8b165744660b1737f0023a2c7487 node/src/aifp1.ts
b82d942d06a71a4cec9a8d1df1f5df44de2d880201e74a3baf19f6eb14b055a0 node/src/agent.ts
87c65caf1ce5e92c78177d2d6a40832b4eeb91a13277e8942964ed8771384695 node/src/unifiedAgent.ts
bf827354a0273b054c122cd2c35dac83eaf9969924115ce76ef651c01bb2c730 gate/REPORTING-V2.md
0b479163558a03f9dcbeac7c086428e30a5c267e48149bce28f7cd88d8b32001 gate/package.json
9add0e046b8f81e1a11ce91a6aadf6984bde2cd538373c7c254b0d4478e158f2 gate/package-lock.json
2c133df4097c704064ec87d40c40e4d84ddf4eaf5a4278dac9a2c270fcc8e0f7 gate/CHANGELOG.md
b0a270b555279a91437bc761075eb8157c7e45bfa089d8cdb85ef63d723cce42 node/package.json
d3dfb3eb5c77ddecb035f00185c4564b7afba7b06eafda43d59bee9e05d73d91 node/package-lock.json
35431f1422906e781f833a1131dc63cd4c59804def08d2a0b1db7fe2ba58aef4 node/CHANGELOG.md
cbfaeccd8d2ae5ccc71b594c578a66ddd1d9de0da513addefeb4ebe4ccfcd060 gate/tests/reporting-funnels-v2.test.ts
d9ec524421e87b479a45766a2688dde30ce39096cf5ba54186beba4af9c74eaf node/tests/reporting-funnels-v2.test.ts
```

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
- Actual green replay: unchanged independent Node49PASS/0FAIL/0SKIP (2.12s),
  full Gate259PASS/0FAIL/0SKIP across21files (3.95s):210author/legacy +49
  independent. Original author54now56 with two added minute controls.
  Existing v1 reporter29passes; independent byte-identity/version-only checks
  pass. Node payer734PASS/0FAIL/0SKIP across38files (12.37s). Gate TypeScript
  build and scoped ESLint PASS. No filtered/skipped acceptance or waiver.
- Complete-minute author controls record11attempts for503 and12for successful
  ACKs; every spacing>=5s. Frozen outage samples retain identical bodies for
  their five attempts; new sequence appears only after exhaustion. Earlier
  event1/2/4/8s +five-attempt independent control still passes unchanged.
- All34reviewer baseline pins matched at author start. End package inventory
  remains247(245pre-existing +2retained independent tests), no additions or
  removals. This author changed exactly reporter, author test, Node guide and
  this S05 log. Concurrent changes observed in Python guide/ASGI/author test/
  S06 log; untouched by this author, so no global245-file freeze is claimed.
  Only three of the17Node S05 product/test/document pins below changed; the
  other14retain their independent-review pins. Both retained independent tests
  and both QA/Security reports remain byte-identical to remediation start.
- No API/type/export/support-stage/version/dependency change; no Python,
  independent artifact, root CHANGELOG, Git, deploy, install or live request
  write/action. Reviewer must close SEC-SDK-01 independently on these new bytes;
  SEC-SDK-02 and all broader QA/Security/backend/release gates are not certified.

Exact replay from package directories (same absolute Node as above):

```sh
# gate: retained independent49; complete [0,60) pacing, no filter
/Users/regrttrol/.nvm/versions/node/v24.0.2/bin/node node_modules/vitest/vitest.mjs run --no-cache tests/reporting-funnels-independent.test.ts
# gate:259 includes210author/legacy +49independent
/Users/regrttrol/.nvm/versions/node/v24.0.2/bin/node node_modules/vitest/vitest.mjs run --no-cache
# node:734existing/author payer controls
/Users/regrttrol/.nvm/versions/node/v24.0.2/bin/node node_modules/vitest/vitest.mjs run --no-cache
# gate: build and scoped lint
/Users/regrttrol/.nvm/versions/node/v24.0.2/bin/node node_modules/typescript/bin/tsc -p tsconfig.json
/Users/regrttrol/.nvm/versions/node/v24.0.2/bin/node node_modules/eslint/bin/eslint.js src/reporter.ts tests/reporting-funnels-v2.test.ts
```

Loopback permission is required only for owned HTTP adapter fixtures.
Fresh S05 freeze SHA256(17; log excluded from self-hash):

```text
d65d3c4cd08317a5cf8f85d80f1e3ec262c06fc9c0997e8bfdf3cd138fd2ad17 gate/src/reporter.ts
c3bf561af0f408654bbe6cda39aa1b11e280e96f041b53d9b366052ac5efefd9 gate/src/core.ts
f711d03d0ff6a00c9bf6bcf088d1942e60159865c5a2f789998b9c72243d8b1e gate/src/express.ts
09d22eb7f07fb3817dcb6843bd030f26293d791a274546395655efc2e1c14a85 gate/src/index.ts
8cc9305d1d3aec674943e69d6bc69b09b2238212cce0b8a2c131ecf58af74fc1 gate/src/types.ts
ceb9de3a4e6c2e299ce3135f3fb9d42b4f0b8b165744660b1737f0023a2c7487 node/src/aifp1.ts
b82d942d06a71a4cec9a8d1df1f5df44de2d880201e74a3baf19f6eb14b055a0 node/src/agent.ts
87c65caf1ce5e92c78177d2d6a40832b4eeb91a13277e8942964ed8771384695 node/src/unifiedAgent.ts
421d4e761489d1fd8a49f7baadba6252850071eed8302ef0915a7f368a5cee1c gate/REPORTING-V2.md
0b479163558a03f9dcbeac7c086428e30a5c267e48149bce28f7cd88d8b32001 gate/package.json
9add0e046b8f81e1a11ce91a6aadf6984bde2cd538373c7c254b0d4478e158f2 gate/package-lock.json
2c133df4097c704064ec87d40c40e4d84ddf4eaf5a4278dac9a2c270fcc8e0f7 gate/CHANGELOG.md
b0a270b555279a91437bc761075eb8157c7e45bfa089d8cdb85ef63d723cce42 node/package.json
d3dfb3eb5c77ddecb035f00185c4564b7afba7b06eafda43d59bee9e05d73d91 node/package-lock.json
35431f1422906e781f833a1131dc63cd4c59804def08d2a0b1db7fe2ba58aef4 node/CHANGELOG.md
07bccb7f9337f2781e701a5876373c75412a814cecd60c6c01b5b1e8a9c8cc52 gate/tests/reporting-funnels-v2.test.ts
d9ec524421e87b479a45766a2688dde30ce39096cf5ba54186beba4af9c74eaf node/tests/reporting-funnels-v2.test.ts
```

Read-only independent replay artifact pins (4unchanged):

```text
9608fda92fe3f89728cc38d77de8f6ca586b832ed32a28674cab5d143bb0dfc8 gate/tests/reporting-funnels-independent.test.ts
38eaac86bc479b25306d1a657ec897b8d95f9f1fa7c50d1b25505ab14663c431 python-gate/tests/test_reporting_funnels_independent.py
ba2c2e2847025e228d3f4d0d4d31607c555b82acfa724c5c111f08e7f7aabbee docs/security/reporting-funnels-sdk-security.md
1d9ca6447b05a5d85ea14168e1697524febb13093aff60d8cf5f82d1e8813918 docs/stories/reporting-funnels-sdk-independent-tests.md
```

HANDOFF: MAIN / independent reviewer | SEC-SDK-01 author repair and replay PASS | independent finding closure PENDING | no waiver
