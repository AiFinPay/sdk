# REPORTING-FUNNELS-20261009 — independent S05/S06 QA

Incremental SDK slice only. Reviewer did not author product code. All product,
author tests, package files, Git and shared logs are read-only. Only the two
new independent test files and these QA/security reports are writable.

Historical QA record only. Findings, closures and harness observations describe
the dated replay, not current test-pass/readiness evidence. Current coverage and
outcomes must be reproduced from [gate tests](../../gate/tests/),
[Python gate tests](../../python-gate/tests/), [Node tests](../../node/tests/),
[Python tests](../../python/tests/) and [candidate CI](../../.github/workflows/ci.yml).
Version control and fresh CI artifacts must bind the replay to candidate bytes;
the source links below are navigational, not immutable historical attestations.

## Historical decision — independent repair replay, 2026-10-09

SEC-SDK-01 and SEC-SDK-02 were independently closed on the reviewed repaired source.
The bounded replay passed; no waiver, skip, xfail or reviewer product repair.
The original 92 controls and both retained expected-behavior regressions are
byte-for-byte unchanged. Authors remained stopped during this replay.

Historical replay included the retained Node/Python independent controls,
full gate suites and both payer suites. Independent controls are subsets of
the full suites, not additive totals. The added author controls were also
replayed, not accepted on author counts. Current totals and results belong in
fresh CI, not this report. Python gate retained existing deprecation warnings
(Starlette/httpx and intentional threaded fork), not failures or skipped tests.
That repair replay had no harness failures; earlier EPERM/fixture failures below remain
historical harness evidence, distinct from the original two product reds.

SEC-SDK-01 closure: unchanged public health minute control observed <=12
attempts over[0,60) and >=5000ms spacing. Replayed expanded author controls
assert exactly12 acknowledged attempts and11outage attempts, stable body per
max5attempt sample, and no acknowledged health sample during503. Manual source
inspection confirms an unconditional5s attempt floor plus max(5000,backoff)
retry delay at gate/src/reporter.ts:808,846; no event-backoff change.

SEC-SDK-02 closure: unchanged actual ASGI body-abort repro observed0
challenge events and0downstream calls. Replayed expanded author controls cover
successful terminal body, header abort, body abort, cancellation and reporting
outage. ASGI awaits _send_json before reporting at
python-gate/aifinpay_gate/asgi.py:74,76; no header-only reinterpretation.
Existing Express/ASGI/WSGI completion/privacy/payment-isolation controls pass.

Read both complete remediation artifacts before execution. The original
reviewer reported matching source/test/document identities at start/end,
with no package drift or author repair during replay. Only the reviewer reports
were subsequently updated for that handoff. Those historical fixture identity
checks do not attest to today's source.

### Source and replay references

Use the [Node author handoff](reporting-funnels-s05-assumptions.md),
[Python author handoff](reporting-funnels-s06-assumptions.md),
[independent Node tests](../../gate/tests/reporting-funnels-independent.test.ts)
and [independent Python tests](../../python-gate/tests/test_reporting_funnels_independent.py).
Duplicated start/end digests are removed; historical freeze observations above
are not fresh provenance for mutable source links.

The replay commands below select source tests without promising fixed totals.
Separate retained commands select their named files. --no-cache, no pytest
cache provider and PYTHONDONTWRITEBYTECODE prevent repository cache writes.
Scoped escalation covers only existing owned ephemeral localhost HTTP
fixtures. No external request, new dependency, registry fetch or source edit.

Reviewer slot CLOSED. MAIN may resume Node author/S04. This closure is not
backend/HTTP17AC, native-browser, human Security/Engineering or release approval.
Legal applicability remains unknown, not certified. Coverage remains null.

## Historical original review — working decisions (2026-10-09)

Read AiFinPay.md first; SDK/gate/Node/Python AGENTS, inherited SDLC QA/security,
senior-qa, local YAGNI, reporting architecture/ADR0010/stories and the complete
backend architecture-auditor skill. Existing owner scope authorizes local
synthetic fixtures. No new dependency, registry check/fetch, external API/RPC,
payment, SSH, partner/cloud write or publication. Keep logical HTTPS response
URLs correct when mapping an owned collector to loopback; no guard weakening.
Author counts are supplied evidence, not independent proof. Unknown legal
applicability and human Security/Engineering approvals remain pending.

The original reviewer compared author-published identities, additional metadata
and pre-existing package files at start/end, reporting no drift. Files were
captured in memory (excluding ignored runtime/cache/dependency trees) for end
comparison. This historical observation is not a current identity attestation.

Original source identity must be recovered from version control and retained
CI artifacts for the dated review, not from a duplicated digest inventory.

## Historical original actual replay / decision (superseded by closure above)

Reviewer slot CLOSED on the frozen sources,2026-10-09. Incremental QA FAIL:
two retained product reds, no waiver. MAIN may resume authors; any repair needs
a new pin/retest. No author repair occurred during this replay. Only the four
dispatched new files edited; package inventory adds exactly two reviewer test
files. All245 pre-existing files and all34published/metadata pins unchanged.

Original replay found SEC-SDK-01 in Node and SEC-SDK-02 in Python despite
passing author/payer suites. These two product failures, rather than stale
aggregate totals, explain the original rejection. Python gate had existing
warnings: Starlette httpx deprecation and
intentional threaded-fork control. Neither hides skips. Coverage=null;
author line coverage does not establish independent branch coverage.

## Replay commands

Run each command from the indicated package directory using that package's
source dependencies and truthful locally built Python distribution metadata.
Gate HTTP needs loopback
permission, only ephemeral reviewer-owned127.0.0.1 endpoints. All other
transport injected; no external API/RPC/registry/install operation.

```sh
# gate and node, separately
node node_modules/vitest/vitest.mjs run --no-cache
# python-gate and python, separately, with local-source dependencies configured
PYTHONDONTWRITEBYTECODE=1 python -m pytest -p no:cacheprovider tests -q
```

SEC-SDK-01 single repro: gate command +
`tests/reporting-funnels-independent.test.ts -t SEC-SDK-01`.
SEC-SDK-02 single repro: python-gate command, replacing tests with
`tests/test_reporting_funnels_independent.py::test_SEC_SDK_02_asgi_challenge_body_abort_is_not_finished402`.
Focused repro excludes others; final full runs excluded none.

## Controls / traceability

AC02/05/10/15: Node v1 implementation and Python v1 AST unchanged; Node JSON
and Python TOML version-only/no-dependency comparisons; dual-producer refusal.
Spoofed authoritative/browser facts, mode/source/origin, time/token/freeform
errors and URLs refuse without transport/throw. Consent-denied ID refused.
Actual incoming valid capability is observation-only. Default no caller UUID,
IP/User-Agent/wallet-derived identity on Express/ASGI/Flask. Invalid context
does not grant access.

AC09/11/14: immutable facts, pending equal/conflict IDs; identical lost-ack
retransmission through actual Node/Python local HTTP collectors; duplicate ack
delivers once. Collectors are synthetic maps, not backend PG durability proof.
400/403/409/302 never retry/follow;1000capacity includes inflight, overflow/drop
coverage,50-event/64KiB batches,15min expiry,1/2/4/8backoff, exactly5attempts.
Node fake time3s header/body deadline/cancellation; Python actual3s caller
deadline prevents transport thread accumulation. Event/health reservation,
auth-ack overlap and close run; no acknowledged sample means null, not remote
zero. Node complete-minute pacing is red; Python minimum5s retry passes.

AC03: real Express4/5 HTTP2xx/3xx/error/abort emits exactly one admission and
one terminal event; finished402 never invents browser view. Reporter503 leaves
response/status/one quota debit intact. Actual ASGI send and Flask/WSGI stream
exhaustion/early close/exception distinguish terminal outcome, do not duplicate
or repeat access. ASGI challenge body abort is the retained SEC-SDK-02 failure.

AC05/06/11/17: payer target allowlists reject foreign/pay/JWKS/query/fragment/
userinfo targets; quote capability is call-scoped/manual redirect; next call
has none. Node cached receipt/upstream503 makes no new settlement/auth;
caller reporting header stripped on merchant calls. Python independent
assertions use the original pre-reporting financial fixture (no author-v2
test imports), execute local signing/receipt verification and simulate lost
optional quote reporting: one quote/transfer/pay, then receipt reuse. Token
absent from auth/payment bodies/journal/receipt cache/ledger. The full Node payer
replay supplements these controls; no new independent Node fresh-payment
fixture claimed. No external financial operation executed.

## Harness history (not product findings)

First Node35PASS/14FAIL:11localhost sandboxEPERM, two fixture API/gateway
name mistakes, SEC-SDK-01. Authorized47PASS/2FAIL:SEC-SDK-01 + cached fixture
key mismatch (requires origin+slug). Corrected owned fixtures only; product
guards unchanged and logical HTTPS Response.url restored on actual HTTP.
Final48/1 independent +208/0 author. No skip/xfail/waiver.

First Python independent41PASS/1FAIL. Initial combined328PASS/2FAIL/2SKIP was
not acceptance: sibling typing_extensions preceded QA-venv anyio/FastAPI,
lacked sentinel; existing importorskip controls skipped. Read-only PYTHONPATH
ordering corrected, no dependency edits/install. Final331PASS/1productFAIL/
0SKIP includes original FastAPI/Flask and both local HTTP collector controls.

## Scope limits

Local SDK facts/HTTP fixtures do not prove actual backend commit-before-ack,
PG conflicts/erasure/scope/retention, full HTTP AC01–17, native browser consent,
partner deployment, human review or release acceptance. Coverage is null until
measured; author line coverage is not independent branch coverage.

HISTORICAL HANDOFF: MAIN | original incremental SDK QA FAIL | SEC-SDK-01 + SEC-SDK-02 | source-stable original replay

HISTORICAL REPAIR HANDOFF: MAIN | bounded SEC-SDK-01/02 closure at review time | no waiver | not current pass/readiness evidence; backend/human/release gates require fresh evidence
