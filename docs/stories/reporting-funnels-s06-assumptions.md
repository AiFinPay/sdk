# reporting-funnels-S06 — Python implementation handoff

Requirement REPORTING-FUNNELS-20261009; frozen reporting.v2.20261009.
Owner «Так» architecture/implementation approval is supplied in dispatch.
Independent QA/Security/code review and human approvals before merge remain
pending. Author tests do not approve those gates.

## Decisions / working log

- Read complete finalized architecture, ADR0010, PRD, stories, SDK/Python
  AGENTS, inherited SDLC/dev and principal YAGNI. Installed inherited config
  is read from aifinpay-reporting/backend/node_modules/@daochild/agents-config
  because this checkout has no root node_modules. Architecture auditor skill
  is inherited from the backend reporting checkout; author checks are not an
  independent review. No config mirror or dependency is added.
- Explicit GateReporterV2 is separate from unchanged GateReporter. Gate gets
  optional reporting/context arguments; adapters own actual response hooks.
  Challenge observation requires emitted402; successful admission is separate
  from once-only terminal response completion. No browser observation inferred.
- Mint is an explicit application operation, never synchronous middleware I/O.
  Context is in memory, explicit channel/consent, optional observed client UUID
  and scoped capability. The application owns consent and registered resources;
  backend owns scope/expiry/authority. Tokens never enter diagnostics or files.
- Payer propagation uses an optional per-call reporting_token. Only the exact
  canonical first-party quote target receives it; no auth statement, grant,
  recovery record, payment submission or foreign request receives it.
- Baseline gate: actual219/219,0skips, FastAPI+Flask executed. Supplied QA venv
  lacks payer dependencies: initial payer collection18errors/1skip is a harness
  limitation, not source acceptance. Existing sibling .venv dependencies can be
  reused read-only via PYTHONPATH without installing/changing dependencies.
- Exact version-only amendments permit python-gate0.1.3 and Python2.5.1 plus
  per-package changelogs; Python CHANGELOG did not previously exist. Root
  changelog belongs to MAIN, README and all Node/backend/UI files stay read-only.

Assumptions: supplied frozen contract remains authoritative; actual backend
HTTP acceptance follows S03. If backend differs, return to MAIN/Architect.
In-memory loss on crash/fork is an explicit coverage interruption; instantiate
a new reporter after fork. No durable telemetry outbox or probes are introduced.

## Results / exported interfaces

- First adapter run35passed/8failed: the new author fixture incorrectly used
  wildcard resource with prefix receipt scope; existing scope verifier correctly
  refused it. Corrected only new fixtures to /api/ prefix;262/262 then passed
  (219existing+43new),0skips. No verifier/access-policy change.
- Source inspection caught initial optional parameter patch at similarly named
  _budget_binding signature. Moved it to aifp1_fetch immediately; reporting
  remains absent from financial binding/auth/journal schemas.
- Payer source baseline410/410 passed using existing sibling dependencies
  read-only. No install, dependency/lock or source mutation outside S06.
- Expanded real Flask fixture initially failed because Werkzeug returns an
  unbuffered response. Reading get_data() is required to exhaust it; no completion
  before exhaustion is correct. New fixture now explicitly consumes the stream.
- Version regression initially434pass/1fail used sibling2.5.0 metadata after
  the authorized2.5.1 source bump. Current source package metadata must be built
  locally for this verification; no runtime version literal or test bypass.
- Read-only Node S05 comparison confirms the same strict event/context/ack and
  two intended quote endpoints. Health supported stages are now explicitly
  declared, so installing a producer alone cannot claim wired completion hooks.
- Author concurrency inspection found health-auth could clear pending events
  while an event result was applying. Health/event attempts now reserve the
  same _sending state under the condition; the worker waits for public health
  attempts, preventing queue mutation during an event attempt. Reporting state
  remains isolated from financial/access state.
- Local source2.5.1 wheel built/installed under owned temporary QA target with
  --no-deps --no-index --no-build-isolation using existing bundled setuptools;
  runtime metadata test is truthful, no mock/literal bypass. No dependencies
  fetched or installed; source is selected first in PYTHONPATH.
- Initial expanded gate66pass/3fail were localhost bindEPERM only. Authorized
  loopback escalation ran the entire actual gate288/288,0skip, and payer435/435,
  0skip. Gate warnings: Starlette httpx deprecation, intentional threaded-fork
  safety control. Source-only/localhost acceptance, not backend PG acceptance.
- Standard-library thread-aware line tracing (no coverage dependency) reran
  gate288/288. Module executable coverage: reporter558/608=91.78%,
  core309/315=98.10%, ASGI99/102=97.06%, WSGI133/136=97.79%. Includes legacy
  lines, not branch coverage. Initial collector sorting failed on a None line
  marker after277tests passed; collector filtering corrected, no product waiver.
- Meaningful red controls ran with memory-only baseline ASGI/WSGI methods and
  mutated ack/foreign-header guard:3+1+4+8actual assertion failures as expected.
  Disk source unchanged. Normal suites are green; these controls are author
  evidence, not independent QA/Security/review approval.
- Context/header inspection found an explicit consent callback could accidentally
  omit incoming capability correlation. A valid capability header is now copied
  after context validation unless the integrator supplied one; invalid header
  loses correlation while retaining the ordinary observation. No access grant.

Implementation and final author counts are recorded below; independent gates
are still pending.

- Payer coverage run invoked from stdin produced434pass/1harness failure:
  multiprocessing.spawn cannot reload a nonexistent <stdin> script for the
  existing two-process ledger test. Normal full435/435 remains valid. Coverage
  runner must be a real guarded temporary file; no product/test waiver.
- Final guarded-file trace runs: gate289/289 (219existing+70new), payer435/435
  (410existing+25new), both0skip/0fail. Actual FastAPI/Flask, fork, localhost
  wire and two-process ledger controls executed. Added a deterministic in-flight
  event/public-health control: a refused health caller cannot release another
  attempt's reservation or mutate pending facts. No independent gate approved.
- Refreshed executable line coverage, thread-aware standard-library tracing:
  reporter558/608=91.78%, core313/319=98.12%, ASGI99/102=97.06%,
  WSGI133/136=97.79%. Whole payer modules (including unrelated legacy code):
  client162/243=66.67%, aifp1 1252/1344=93.15%, unified_agent681/804=84.70%.
  This is author line evidence only, not branch coverage or a waived threshold.

## Exact owned write manifest / public surface

All paths are beneath `/Users/regrttrol/Documents/code/AiFinPay/sdk-reporting/`:

1. `python-gate/aifinpay_gate/reporter.py`
2. `python-gate/aifinpay_gate/core.py`
3. `python-gate/aifinpay_gate/asgi.py`
4. `python-gate/aifinpay_gate/wsgi.py`
5. `python-gate/aifinpay_gate/__init__.py`
6. `python/aifinpay/aifp1.py`
7. `python/aifinpay/client.py`
8. `python/aifinpay/unified_agent.py`
9. `python-gate/REPORTING-V2.md`
10. `python-gate/pyproject.toml`
11. `python-gate/CHANGELOG.md`
12. `python/pyproject.toml`
13. `python/CHANGELOG.md`
14. `python-gate/tests/test_reporting_funnels_v2.py`
15. `python/tests/test_reporting_funnels_v2.py`
16. `docs/stories/reporting-funnels-s06-assumptions.md`

Exports: `aifinpay_gate.GateReporterV2`, `aifinpay_gate.ReportingFlow`.
Producer API: constructor merchant_id/merchant_secret/supported/api_base;
on_event/call, mint_flow, health_sample, health, stats, flush, close.
Gate adds optional reporting/reporting_context and adapter-local
reporting_for/report_observation hooks. Existing ASGI/WSGI public constructors
do not change. Payer adds optional reporting_token to Agent.pay,
Agent.quote_split, aifinpay.aifp1.aifp1_fetch, AiFinPayAgent.fetch_paid.
Private validation/transport helpers are not new public APIs.

Parsed TOML comparison against HEAD confirms both manifests change ONLY
project.version: gate0.1.2→0.1.3, payer2.5.0→2.5.1. GateReporter v1 AST is
identical to HEAD. Scoped git diff --check passes. No dependencies, locks,
Node/root changelog/UI/backend edits by this author; concurrent S05/MAIN
changes are preserved. No Git mutation/publication/merge/deploy.

## Reproduction and evidence limits

QA interpreter: `/private/tmp/aifp-reporting-qa.IKSesN/python-venv/bin/python`.
Actual commands from each package directory:

```sh
# python-gate; loopback permission required, no external connection
PYTHONPATH=. /private/tmp/aifp-reporting-qa.IKSesN/python-venv/bin/python -m pytest tests -q
# python; existing dependency tree read-only, truthful current source metadata
PYTHONPATH=.:/private/tmp/aifp-reporting-qa.IKSesN/s06-python-install:/Users/regrttrol/Documents/code/AiFinPay/aifinpay-sdk/python/.venv/lib/python3.13/site-packages /private/tmp/aifp-reporting-qa.IKSesN/python-venv/bin/python -m pytest tests -q
```

## SEC-SDK-02 repair — author replay,2026-10-09

- Read the complete independent SDK QA/security reports and retained Python/
  Node tests read-only. Reviewer slot is closed; no author edits to its reports
  or retained tests. Original34pin/245file replay is historical independent
  evidence, not a claim that repaired bytes are already approved.
- Actual retained Python repro before repair:1FAIL/0PASS/0SKIP (pytest exit1),
  one false access_challenged despite ConnectionError on402body. Root cause:
  reporting after response.start before the terminal body send returned.
  Fix is scoped to the existing ASGI JSON send, not access/payment or Node.
- New5author regression controls first3FAIL/2PASS/0SKIP. ASGI now awaits the
  unchanged _send_json (headers plus terminal body) before reporting once.
  Failed headers/body and cancellation propagate unchanged with no challenge;
  reporting exceptions remain swallowed by the existing hook. Paid admission/
  completion/refund code is untouched. Documentation corrects header-only
  wording. No new helper, dependency, service, version or ownership change.

Final full-suite runs used the same imports/fixtures with real guarded
`/private/tmp/aifp-reporting-qa.IKSesN/s06-trace.py` instead of -m pytest,
collecting thread-aware executable lines: gate289pass/0fail/0skip in19.40s,
payer435pass/0fail/0skip in25.18s. Gate has2warnings (Starlette httpx
deprecation; intentional locked-thread fork refusal). Payer has no warnings.
Initial failed harness runs and meaningful mutation-red controls remain in
the log above; no fixture waiver or dependency change masks them.

Principal YAGNI kept the producer in the existing standard-library transport
and two actual adapters: no persistence, new service, generic analytics layer
or dependency. SDLC keeps author evidence distinct from independent acceptance.

Remaining: backend S03/S04 real HTTP commit-before-ack, scope/expiry/erasure,
PG conflict/health acceptance and cross-language acceptance; independent QA,
Security/code review and human pre-merge gates. No deployed/partner evidence.
Full-module line coverage includes legacy payer paths and is not a release
coverage or branch-coverage approval. A bounded caller can leave at most one
daemon OS/DNS operation alive after3s; no transport-thread accumulation.
WSGI cannot prove TCP delivery and requires server close on interruption.
Mint has one automatic attempt, with explicit caller request_id reuse only.
Capabilities and queue are memory-only: crash/fork loses coverage; no durable
telemetry claim. Health retries obey at least5s spacing (up to8s at attempt5)
to preserve the independent≤12/minute cap, while event retries use1/2/4/8s.

## Pre-SEC-SDK-02 runtime/test source SHA256 (historical author freeze)

```text
f6629df2736668e40a7ca2d9036e7f921bbfbb687f49a511fe71e253f1501505 python-gate/aifinpay_gate/reporter.py
3943040ee826c03fa396cf6ed0a4d414bd19edad2533a553d4d77db9e16e8cd1 python-gate/aifinpay_gate/core.py
451031f992a0f229dac4c4e6138b9c6b1dba496a69f26a64970d1deb1124075c python-gate/aifinpay_gate/asgi.py
2f508c708af248aaaf38c0c5b215267041482c0dd282ea2ddd4cea0b9c54ce75 python-gate/aifinpay_gate/wsgi.py
ca7e3cbe09735fae56cd4adfb7d493337e32c7036fb1953fec4deb8d7120787c python-gate/aifinpay_gate/__init__.py
62f3d03d31a0bb89d9a9162d83176b9ed4ff6de3e17981e4e00914abcf0c2162 python/aifinpay/aifp1.py
96e7112e9acfb7f8dc24d626c2446424158c1aeef4ad4dcbe67d7aa8eef82a4b python/aifinpay/client.py
d79d4ca0f4bde885d5720db9b57e2851b4e0e2d11ac94b68fd439b261af0b57f python/aifinpay/unified_agent.py
ed7b9178fd6615a24921f8951ba56bafa286908e2972f7bcfb321303ae386aeb python-gate/tests/test_reporting_funnels_v2.py
e93804d678736d6d05fcc353bd2dac873ef4d3f7f36e2ce165372d0eb8129d5c python/tests/test_reporting_funnels_v2.py
```

## SEC-SDK-02 repaired freeze / replay handoff

Actual retained repro RED1fail/0pass/0skip→GREEN1pass/0fail/0skip, executed
unchanged in the6control focused green run (the other5are author additions).
New author controls RED3fail/2pass→GREEN5pass. No skip/xfail/test waiver.
Full gate **337PASS/0FAIL/0SKIP** in20.06s:219original+75S06author+43retained
independent. Full payer **435PASS/0FAIL/0SKIP** in9.59s. Unique Python full
total772PASS; focused replays are subsets and are not added again.
Actual FastAPI/Flask, POSIX fork and local HTTP controls ran. Gate2existing
deprecation warnings (Starlette httpx and intentional threaded fork); payer0.
No new coverage measurement; preceding line evidence is historical, not
independent branch coverage on repaired bytes.

Retained repro/full gate commands from `sdk-reporting/python-gate`:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:../python:/private/tmp/aifp-reporting-qa.IKSesN/s06-python-install:/private/tmp/aifp-reporting-qa.IKSesN/python-venv/lib/python3.13/site-packages:/Users/regrttrol/Documents/code/AiFinPay/aifinpay-sdk/python/.venv/lib/python3.13/site-packages /private/tmp/aifp-reporting-qa.IKSesN/python-venv/bin/python -m pytest -p no:cacheprovider tests/test_reporting_funnels_independent.py::test_SEC_SDK_02_asgi_challenge_body_abort_is_not_finished402 -q
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:../python:/private/tmp/aifp-reporting-qa.IKSesN/s06-python-install:/private/tmp/aifp-reporting-qa.IKSesN/python-venv/lib/python3.13/site-packages:/Users/regrttrol/Documents/code/AiFinPay/aifinpay-sdk/python/.venv/lib/python3.13/site-packages /private/tmp/aifp-reporting-qa.IKSesN/python-venv/bin/python -m pytest -p no:cacheprovider tests -q
```

Full payer command from `sdk-reporting/python`:

```sh
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:/private/tmp/aifp-reporting-qa.IKSesN/s06-python-install:/Users/regrttrol/Documents/code/AiFinPay/aifinpay-sdk/python/.venv/lib/python3.13/site-packages /private/tmp/aifp-reporting-qa.IKSesN/python-venv/bin/python -m pytest -p no:cacheprovider tests -q
```

Gate full replay used authorized escalation solely for owned ephemeral loopback
fixtures. No dependency installation, external HTTP/RPC, payment or credentials.
Repair delta is exactly4original-scope files: asgi.py, gate author test,
REPORTING-V2.md, this assumptions log. No Node/reviewer/report edits or Git
mutation/publication/deployment. Payer source and all other S06 source/version
pins remain unchanged. Public exports and source versions stay0.1.3/2.5.1.
Scoped git diff --check passes. SDLC/YAGNI keeps this one post-send hook and
does not authorize self-approval. Independent QA/Security/review and human
pre-merge gates require fresh independent replay; backend acceptance pending.
Node SEC-SDK-01 belongs to its author and is not reapproved by this replay.

Fresh S06 SHA256, paths relative to sdk-reporting (assumptions self-hash is
returned separately; hashing a file containing its own hash is not meaningful):

```text
f6629df2736668e40a7ca2d9036e7f921bbfbb687f49a511fe71e253f1501505 python-gate/aifinpay_gate/reporter.py
3943040ee826c03fa396cf6ed0a4d414bd19edad2533a553d4d77db9e16e8cd1 python-gate/aifinpay_gate/core.py
b04371e123653ce30d62e7f3a4480c1ee791273e045e2f61121d828b71c031a5 python-gate/aifinpay_gate/asgi.py
2f508c708af248aaaf38c0c5b215267041482c0dd282ea2ddd4cea0b9c54ce75 python-gate/aifinpay_gate/wsgi.py
ca7e3cbe09735fae56cd4adfb7d493337e32c7036fb1953fec4deb8d7120787c python-gate/aifinpay_gate/__init__.py
62f3d03d31a0bb89d9a9162d83176b9ed4ff6de3e17981e4e00914abcf0c2162 python/aifinpay/aifp1.py
96e7112e9acfb7f8dc24d626c2446424158c1aeef4ad4dcbe67d7aa8eef82a4b python/aifinpay/client.py
d79d4ca0f4bde885d5720db9b57e2851b4e0e2d11ac94b68fd439b261af0b57f python/aifinpay/unified_agent.py
6194524e670fc9c2033881bbf769f385fcae4e67837df5e74bab76f8942656b0 python-gate/tests/test_reporting_funnels_v2.py
e93804d678736d6d05fcc353bd2dac873ef4d3f7f36e2ce165372d0eb8129d5c python/tests/test_reporting_funnels_v2.py
d5982d462fc982c0378c7b54d0607abb1b2b60cab960b49424fbdcf23736d8e8 python-gate/REPORTING-V2.md
b2636bad8adafd9e267958837f84c1d2d38ca80b98faa14174be48e5539d31f3 python-gate/pyproject.toml
c2c560258b122bec4d48714950219c939324dc522e4cb2dc4d4d1b84589568b3 python/pyproject.toml
67fd1db617cb1e8879eaebba48874a255c9b0c8616d8b9cb91e1b2f058a0e32a python-gate/CHANGELOG.md
32135aaf369c0c253b09b480d17a3df68f626abeaeee10471b70891241e967cd python/CHANGELOG.md
```

Read-only independent evidence pins checked before/after repair, all unchanged:

```text
1d9ca6447b05a5d85ea14168e1697524febb13093aff60d8cf5f82d1e8813918 docs/stories/reporting-funnels-sdk-independent-tests.md
ba2c2e2847025e228d3f4d0d4d31607c555b82acfa724c5c111f08e7f7aabbee docs/security/reporting-funnels-sdk-security.md
38eaac86bc479b25306d1a657ec897b8d95f9f1fa7c50d1b25505ab14663c431 python-gate/tests/test_reporting_funnels_independent.py
9608fda92fe3f89728cc38d77de8f6ca586b832ed32a28674cab5d143bb0dfc8 gate/tests/reporting-funnels-independent.test.ts
```

HANDOFF: MAIN / independent SDK QA+Security | SEC-SDK-02 author repair frozen |
no self-approval | fresh independent replay required | REPORTING-FUNNELS-20261009/S06
