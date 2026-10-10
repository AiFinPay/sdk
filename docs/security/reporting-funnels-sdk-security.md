# REPORTING-FUNNELS-20261009 — independent S05/S06 security slice

## Current finding disposition — independently CLOSED, 2026-10-09

Both original Medium findings are closed on fresh, stable author source pins.
This is incremental SDK QA/security-slice acceptance, not author self-review,
full security certification, backend/HTTP17AC or release acceptance.

| Finding | Original severity | Repaired location | Retained independent repro/result |
|---|---|---|---|
| SEC-SDK-01 | Medium, CLOSED | gate/src/reporter.ts:808,846 | gate/tests/reporting-funnels-independent.test.ts:145; complete-minute503attempt cap and >=5s spacing now PASS |
| SEC-SDK-02 | Medium, CLOSED | python-gate/aifinpay_gate/asgi.py:74,76 | python-gate/tests/test_reporting_funnels_independent.py:253; actual402headers then body ConnectionError now0challenge/0access, PASS |

Node reporter SHA256 d65d3c4cd08317a5cf8f85d80f1e3ec262c06fc9c0997e8bfdf3cd138fd2ad17.
Python ASGI SHA256 b04371e123653ce30d62e7f3a4480c1ee791273e045e2f61121d828b71c031a5.
Python reporter remains f6629df2736668e40a7ca2d9036e7f921bbfbb687f49a511fe71e253f1501505.

Manual repair review confirms the Node attempt guard applies to pending samples
and health retries use max(5000,backoff), preserving event backoff and max5.
ASGI observation follows successful terminal body send, not response.start;
failed send/cancellation propagates without inventing a completed challenge.
No guard weakened, no header-only semantic waiver, no reviewer product change.

Actually replayed unchanged independent49Node+43Python=92PASS/0FAIL/0SKIP.
Expanded combined suites259gate+337Python-gate+734Node-payer+435Python-payer
=1765PASS/0FAIL/0SKIP, with92as a subset. Seven new author controls were executed,
including health success/outage full-minute sequences and ASGI send/cancellation/
telemetry outcomes. No new finding within this bounded repaired slice.
No claim of global absence of Critical/High/Medium issues.

Read both complete remediation/pin artifacts before replay. Fresh17Node author
and15Python author pins match, plus four unchanged reviewer artifact pins.
All39published/document/root pins and all247package files match start/end before
closure report edits. Retained test hashes unchanged. Authors remained stopped;
no repair during replay. Only the two reviewer reports are updated for handoff.
The QA artifact has the exact37non-report manifest and replay commands.
Fresh replay0harness errors; historicalEPERM/fixture failures are not waived
product reds. Two existing Python deprecation warnings, zero skips.

Earlier source SAST/secrets and unchanged-dependency evidence below is scoped
historical evidence; this replay independently re-inspects the two repairs.
No fresh full SAST/history/entropy/CVE/license scan or legal certification
claimed. Product/author tests/package/Git/shared log stayed read-only; no new
dependency, external API/RPC/payment/partner/cloud/registry/probe operation.
Inherited QA/security, architecture-auditor and YAGNI constrain acceptance to
actual bounded SDK behavior and stable evidence, not broader release claims.

Reviewer slot CLOSED; MAIN may resume Node author/S04. Full backend/HTTP17AC,
native browser, human Security+Engineering and release gates remain pending.

## Historical original review (superseded by repair closure above)

Reviewer is independent of Node/Python authors. Original start pins: all27 published
hashes match; full34-pin manifest is in the independent QA report. Writes are
confined to the four dispatched new files. Product repairs belong to authors.

## Historical original findings for MAIN (retained, source-stable original replay)

**SEC-SDK-01 — Medium — Node health retry pacing bypasses independent cap.**
Source `gate/src/reporter.ts:806`, retry `gate/src/reporter.ts:843`.
The5s guard applies only without a pending sample;
pending failure uses event backoff1/2/4/8s. A public caller can reattempt after
1s during503 rather than5s. Independent test observed2attempts at t=0,t=1s.
This violates the frozen <=12health attempts/minute contract and differs from
Python's max(HEALTH_INTERVAL, backoff). It can cause unnecessary collector load
and rate-limit/drop coverage during an outage; no access/payment bypass shown.
Repro: independent Vitest `SEC-SDK-01` test, using injected503 and fake time.
Retained expected behavior is red; no skip/xfail or product modification.
Remediation: apply minimum5s spacing to health retries as well as new samples.
Complete-minute retained control executed: injected503 and a public health
call at each integer second over [0,60) gives15attempts, expected<=12.
Source SHA256 fc91257c3180d98dec1e17da9cfcb758e436d9705b5d3e95d6a6aefad04e1c1d.

**SEC-SDK-02 — Medium — ASGI challenge counted before402 body completion.**
Source `python-gate/aifinpay_gate/asgi.py:74` reports access_challenged as
soon as response.start returns, before _send_json sends the body. Independent
`test_SEC_SDK_02_asgi_challenge_body_abort_is_not_finished402` makes the actual
ASGI send accept402 headers then raise ConnectionError on body. Product emits
one challenge although body never finishes, expected zero. No downstream
access occurs. This breaks the requested finished402 criterion and Node finish
parity, inflating challenge cohort observations after aborted delivery. It
does not imply paywall_viewed or a receipt/access bypass. Remediation belongs
to Python author: count only a successful terminal challenge body emission.
Source SHA256451031f992a0f229dac4c4e6138b9c6b1dba496a69f26a64970d1deb1124075c.

SEC-SDK-02 is scoped to the dispatched **finished402** requirement and
cross-language completion parity. Backend architecture says "actual emitted402";
choosing header-only semantics would require an explicit MAIN contract decision
and Node/Python alignment, not a silently weakened fixture. Existing author
tests cover successful header-stage observation, missing this aborted body.

|Finding|Severity|Product location|Retained repro|
|---|---|---|---|
|SEC-SDK-01|Medium|gate/src/reporter.ts:806,843|gate/tests/reporting-funnels-independent.test.ts:145;15attempts vs<=12in[0,60)|
|SEC-SDK-02|Medium|python-gate/aifinpay_gate/asgi.py:74|python-gate/tests/test_reporting_funnels_independent.py:253;402headers/body abort gives1challenge vs0|

Critical0/High0/Medium2 within this bounded review, not a global absence claim.
Independent controls90PASS/2FAIL/0SKIP; expected assertions retained red,
no waiver/product fix/xfail. Author suites208/734/289/435 all PASS0SKIP in the
final combined replay. Exact commands/hashes/counts are in
[the QA artifact](../stories/reporting-funnels-sdk-independent-tests.md).

## Working decisions / scope

2026-10-09: requested architecture-auditor + inherited SDLC security/QA and
YAGNI applied to trust, compatibility, source pins, bounded transport and
real adapter observations. Initial Node35PASS/14FAIL: one reproduced product
finding;11localhost EPERM and2fixture errors (wrong Agent factory/gateway name).
Fixture corrections keep origin/redirect guards intact. Second run Node47PASS/
2FAIL: one product red and one cached-receipt fixture key mismatch, corrected
to origin+slug. Python41PASS/1FAIL: reproduced SEC-SDK-02; no skips. Actual
minute result15>12 retained. No product changes or waiver.

Final frozen replay has0harness failures/skips. Intermediate Python framework
import failure/2baseline skips came from fallback dependency path ordering;
QA-venv framework tree must precede original payer dependency fallback.
Correcting PYTHONPATH reproduced all289author gate tests and left only the
independent ASGI product red. No dependency installation or source change.

End verification:34/34published and metadata/document pins match start, plus
245/245pre-existing package file hashes unchanged. New package paths are
exactly the two dispatched independent tests. No author repair during replay.
Node reporter fc91257c3180d98dec1e17da9cfcb758e436d9705b5d3e95d6a6aefad04e1c1d;
Python reporter f6629df2736668e40a7ca2d9036e7f921bbfbb687f49a511fe71e253f1501505;
ASGI451031f992a0f229dac4c4e6138b9c6b1dba496a69f26a64970d1deb1124075c.

## Local security checks / practical limits

Source SAST: focused added-line sink review over16changed runtime modules,
1564added/21removed lines. Installed TypeScript parser parsed8TS modules;
Python AST parsed15modules (whole gate +3payer modules). Local lexical diff
scan for eval/exec/spawn/file-write/browser persistence/pickle sinks:0hits;
three synthetic unsafe controls detected. Manual inspection traced strict
wire validators, runtime input failure isolation, closure/in-memory capability,
redirect/origin checks, bounded transport, quotas and financial propagation.
Two behavioral findings above remain despite static scan0hits. This is not
full semantic taint analysis or a full SDK security audit.

Secrets: local added-line credential-marker scan over the same16modules,
0hits; one synthetic fake credential control detected. It checks private-key
PEM/AWS/PAT/Slack/live-provider key markers without printing any matched secret.
Reviewed reporting additions contain no literal credentials/private identity.
In-process test keys/capabilities are synthetic; no profile/env/secret read or
persisted key. Gitleaks/TruffleHog are unavailable via PATH; no new binary,
download or scanner coverage claim. This limited scan is not high-entropy or
history scanning. Product scans and end pins run on the same frozen bytes.

Dependencies: independent Node manifest/lock and Python TOML comparisons pass:
only versions differ against original read-only sibling. No dependency change,
registry check/fetch or install. Fresh CVE/license/advisory database scanning
not executed; unchanged dependencies do not certify current advisory status.
No full Security Gate PASS inferred from source inspection.

Auth/trust: spoofed authoritative stages/body mode/origin/wallet/ID/time/freeform
errors refuse; invalid reporting context never grants access. Incoming valid
capability is syntactic correlation only; backend crypto/scope/expiry remain
separate acceptance. Actual Express4/5/ASGI/Flask no default identity/IP/UA;
quote header narrowly targeted, absent from auth/pay/JWKS/partner/recovery/
receipt/ledger state. Reporter503 leaves original quota/status/access and
simulated payment count intact. Owned HTTP fixtures preserve logical HTTPS
Response.url and original redirect guards; no live API/RPC/partner probes.

No fresh advisory database fetch is authorized; local unchanged-dependency
manifest comparison does not certify current CVE status. SAST/secrets source
inspection is scoped evidence, not a full audit. Legal applicability is unknown,
not certified. Full backend/HTTP AC01–17, native browser, human Security and
Engineering, code review, deployment and release acceptance remain pending.

Reviewer slot CLOSED. MAIN may relay the retained findings and resume authors.
Repairs require a new source pin and independent retest. Full backend/HTTP
AC01–17/native browser/human Security+Engineering remain pending; legal
applicability unknown, no certification. No release/merge/deploy authorization.

HISTORICAL HANDOFF: MAIN | original incremental SDK QA/security FAIL | two Medium findings | source-stable original replay

CURRENT HANDOFF: MAIN | incremental repaired SDK QA/security slice PASS | SEC-SDK-01/02 independently CLOSED | 92/92 independent;1765/1765 combined | slot CLOSED | fresh source-stable | no waiver | backend/human/release gates pending
