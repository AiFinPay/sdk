# REPORTING-FUNNELS-20261009 — independent S05/S06 QA

Incremental SDK slice only. Reviewer did not author product code. All product,
author tests, package files, Git and shared logs are read-only. Only the two
new independent test files and these QA/security reports are writable.

## Current decision — independent repair replay, 2026-10-09

SEC-SDK-01 and SEC-SDK-02 independently CLOSED on the repaired frozen source.
Incremental SDK slice PASS; no waiver, skip, xfail or reviewer product repair.
The original 92 controls and both retained expected-behavior regressions are
byte-for-byte unchanged. Authors remained stopped during this replay.

| Actual execution | Pass | Fail | Skip | Qualification |
|---|---:|---:|---:|---|
| Retained Node independent |49|0|0|Separate run, 3.17s |
| Retained Python independent |43|0|0|Separate run, 7.24s |
| Full Node gate |259|0|0|21 files; 210 legacy/author +49 independent, 2.40s |
| Full Python gate |337|0|0|294 legacy/author +43 independent, 19.96s |
| Node payer |734|0|0|38 files, 12.84s |
| Python payer |435|0|0|12.78s |

Unique combined suite total1765PASS/0FAIL/0SKIP. The92 independent controls
are a subset, not counted twice. The seven added author controls (two Node,
five Python) were also actually replayed by this reviewer, not accepted on
author counts. Python gate retains two existing deprecation warnings
(Starlette/httpx and intentional threaded fork), not failures or skipped tests.
Fresh replay has0harness failures; earlier EPERM/fixture failures below remain
historical harness evidence, distinct from the original two product reds.

SEC-SDK-01 closure: unchanged public health minute control now passes <=12
attempts over[0,60) and >=5000ms spacing. Replayed expanded author controls
assert exactly12 acknowledged attempts and11outage attempts, stable body per
max5attempt sample, and no acknowledged health sample during503. Manual source
inspection confirms an unconditional5s attempt floor plus max(5000,backoff)
retry delay at gate/src/reporter.ts:808,846; no event-backoff change.

SEC-SDK-02 closure: unchanged actual ASGI body-abort repro now observes0
challenge events and0downstream calls. Replayed expanded author controls cover
successful terminal body, header abort, body abort, cancellation and reporting
outage. ASGI awaits _send_json before reporting at
python-gate/aifinpay_gate/asgi.py:74,76; no header-only reinterpretation.
Existing Express/ASGI/WSGI completion/privacy/payment-isolation controls pass.

Read both complete remediation/pin artifacts before execution. All fresh17
Node author pins match; Python artifact19pins comprise15author files plus
the unchanged four reviewer artifacts. Union36published pins plus two author
assumption documents and rootCHANGELOG gives39start/end hashes matching before
report updates. All247package files unchanged at end (original245 +2retained
reviewer tests); no added/removed package path, no author repair during replay.
The only subsequent changes are this QA report and the security report.
Independent fixture SHA256s remain unchanged, listed in the historical block.

### Fresh start/end manifest (37 non-report pins, identical)

The two report hashes were additionally checked unchanged through execution;
they intentionally change only for this closure handoff. No source pin drift.

```json
{
  "gate/src/reporter.ts": "d65d3c4cd08317a5cf8f85d80f1e3ec262c06fc9c0997e8bfdf3cd138fd2ad17",
  "gate/src/core.ts": "c3bf561af0f408654bbe6cda39aa1b11e280e96f041b53d9b366052ac5efefd9",
  "gate/src/express.ts": "f711d03d0ff6a00c9bf6bcf088d1942e60159865c5a2f789998b9c72243d8b1e",
  "gate/src/index.ts": "09d22eb7f07fb3817dcb6843bd030f26293d791a274546395655efc2e1c14a85",
  "gate/src/types.ts": "8cc9305d1d3aec674943e69d6bc69b09b2238212cce0b8a2c131ecf58af74fc1",
  "node/src/aifp1.ts": "ceb9de3a4e6c2e299ce3135f3fb9d42b4f0b8b165744660b1737f0023a2c7487",
  "node/src/agent.ts": "b82d942d06a71a4cec9a8d1df1f5df44de2d880201e74a3baf19f6eb14b055a0",
  "node/src/unifiedAgent.ts": "87c65caf1ce5e92c78177d2d6a40832b4eeb91a13277e8942964ed8771384695",
  "gate/REPORTING-V2.md": "421d4e761489d1fd8a49f7baadba6252850071eed8302ef0915a7f368a5cee1c",
  "gate/package.json": "0b479163558a03f9dcbeac7c086428e30a5c267e48149bce28f7cd88d8b32001",
  "gate/package-lock.json": "9add0e046b8f81e1a11ce91a6aadf6984bde2cd538373c7c254b0d4478e158f2",
  "gate/CHANGELOG.md": "2c133df4097c704064ec87d40c40e4d84ddf4eaf5a4278dac9a2c270fcc8e0f7",
  "node/package.json": "b0a270b555279a91437bc761075eb8157c7e45bfa089d8cdb85ef63d723cce42",
  "node/package-lock.json": "d3dfb3eb5c77ddecb035f00185c4564b7afba7b06eafda43d59bee9e05d73d91",
  "node/CHANGELOG.md": "35431f1422906e781f833a1131dc63cd4c59804def08d2a0b1db7fe2ba58aef4",
  "gate/tests/reporting-funnels-v2.test.ts": "07bccb7f9337f2781e701a5876373c75412a814cecd60c6c01b5b1e8a9c8cc52",
  "node/tests/reporting-funnels-v2.test.ts": "d9ec524421e87b479a45766a2688dde30ce39096cf5ba54186beba4af9c74eaf",
  "gate/tests/reporting-funnels-independent.test.ts": "9608fda92fe3f89728cc38d77de8f6ca586b832ed32a28674cab5d143bb0dfc8",
  "python-gate/tests/test_reporting_funnels_independent.py": "38eaac86bc479b25306d1a657ec897b8d95f9f1fa7c50d1b25505ab14663c431",
  "python-gate/aifinpay_gate/reporter.py": "f6629df2736668e40a7ca2d9036e7f921bbfbb687f49a511fe71e253f1501505",
  "python-gate/aifinpay_gate/core.py": "3943040ee826c03fa396cf6ed0a4d414bd19edad2533a553d4d77db9e16e8cd1",
  "python-gate/aifinpay_gate/asgi.py": "b04371e123653ce30d62e7f3a4480c1ee791273e045e2f61121d828b71c031a5",
  "python-gate/aifinpay_gate/wsgi.py": "2f508c708af248aaaf38c0c5b215267041482c0dd282ea2ddd4cea0b9c54ce75",
  "python-gate/aifinpay_gate/__init__.py": "ca7e3cbe09735fae56cd4adfb7d493337e32c7036fb1953fec4deb8d7120787c",
  "python/aifinpay/aifp1.py": "62f3d03d31a0bb89d9a9162d83176b9ed4ff6de3e17981e4e00914abcf0c2162",
  "python/aifinpay/client.py": "96e7112e9acfb7f8dc24d626c2446424158c1aeef4ad4dcbe67d7aa8eef82a4b",
  "python/aifinpay/unified_agent.py": "d79d4ca0f4bde885d5720db9b57e2851b4e0e2d11ac94b68fd439b261af0b57f",
  "python-gate/tests/test_reporting_funnels_v2.py": "6194524e670fc9c2033881bbf769f385fcae4e67837df5e74bab76f8942656b0",
  "python/tests/test_reporting_funnels_v2.py": "e93804d678736d6d05fcc353bd2dac873ef4d3f7f36e2ce165372d0eb8129d5c",
  "python-gate/REPORTING-V2.md": "d5982d462fc982c0378c7b54d0607abb1b2b60cab960b49424fbdcf23736d8e8",
  "python-gate/pyproject.toml": "b2636bad8adafd9e267958837f84c1d2d38ca80b98faa14174be48e5539d31f3",
  "python/pyproject.toml": "c2c560258b122bec4d48714950219c939324dc522e4cb2dc4d4d1b84589568b3",
  "python-gate/CHANGELOG.md": "67fd1db617cb1e8879eaebba48874a255c9b0c8616d8b9cb91e1b2f058a0e32a",
  "python/CHANGELOG.md": "32135aaf369c0c253b09b480d17a3df68f626abeaeee10471b70891241e967cd",
  "docs/stories/reporting-funnels-s05-assumptions.md": "e54c92f6c3585ed8339639a9564cdd00a88684ad3945da28034dd645210fcf2c",
  "docs/stories/reporting-funnels-s06-assumptions.md": "b406402415796479b643364924c75ac7b287f6272e7ba8c2e093d81bc44d9c06",
  "CHANGELOG.md": "2cd351623a6fdc7de7cfaa5ca0ffe658c46fc2abbfafe853170a3ac4f32e6b8f"
}
```

The exact replay commands below are unchanged; gate totals are now259/337.
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

Start pin check: all 27 author published SHA256s match actual files; seven
additional metadata/document pins recorded below. End check matches all34
pins below and all245 pre-existing package files, zero drift. Files captured
in memory (excluding ignored runtime/cache/dependency trees) for end comparison.

## Historical original start/end SHA256 (all identical in original replay)

```json
{
  "gate/src/reporter.ts": "fc91257c3180d98dec1e17da9cfcb758e436d9705b5d3e95d6a6aefad04e1c1d",
  "gate/src/core.ts": "c3bf561af0f408654bbe6cda39aa1b11e280e96f041b53d9b366052ac5efefd9",
  "gate/src/express.ts": "f711d03d0ff6a00c9bf6bcf088d1942e60159865c5a2f789998b9c72243d8b1e",
  "gate/src/index.ts": "09d22eb7f07fb3817dcb6843bd030f26293d791a274546395655efc2e1c14a85",
  "gate/src/types.ts": "8cc9305d1d3aec674943e69d6bc69b09b2238212cce0b8a2c131ecf58af74fc1",
  "node/src/aifp1.ts": "ceb9de3a4e6c2e299ce3135f3fb9d42b4f0b8b165744660b1737f0023a2c7487",
  "node/src/agent.ts": "b82d942d06a71a4cec9a8d1df1f5df44de2d880201e74a3baf19f6eb14b055a0",
  "node/src/unifiedAgent.ts": "87c65caf1ce5e92c78177d2d6a40832b4eeb91a13277e8942964ed8771384695",
  "gate/REPORTING-V2.md": "bf827354a0273b054c122cd2c35dac83eaf9969924115ce76ef651c01bb2c730",
  "gate/package.json": "0b479163558a03f9dcbeac7c086428e30a5c267e48149bce28f7cd88d8b32001",
  "gate/package-lock.json": "9add0e046b8f81e1a11ce91a6aadf6984bde2cd538373c7c254b0d4478e158f2",
  "gate/CHANGELOG.md": "2c133df4097c704064ec87d40c40e4d84ddf4eaf5a4278dac9a2c270fcc8e0f7",
  "node/package.json": "b0a270b555279a91437bc761075eb8157c7e45bfa089d8cdb85ef63d723cce42",
  "node/package-lock.json": "d3dfb3eb5c77ddecb035f00185c4564b7afba7b06eafda43d59bee9e05d73d91",
  "node/CHANGELOG.md": "35431f1422906e781f833a1131dc63cd4c59804def08d2a0b1db7fe2ba58aef4",
  "gate/tests/reporting-funnels-v2.test.ts": "cbfaeccd8d2ae5ccc71b594c578a66ddd1d9de0da513addefeb4ebe4ccfcd060",
  "node/tests/reporting-funnels-v2.test.ts": "d9ec524421e87b479a45766a2688dde30ce39096cf5ba54186beba4af9c74eaf",
  "python-gate/aifinpay_gate/reporter.py": "f6629df2736668e40a7ca2d9036e7f921bbfbb687f49a511fe71e253f1501505",
  "python-gate/aifinpay_gate/core.py": "3943040ee826c03fa396cf6ed0a4d414bd19edad2533a553d4d77db9e16e8cd1",
  "python-gate/aifinpay_gate/asgi.py": "451031f992a0f229dac4c4e6138b9c6b1dba496a69f26a64970d1deb1124075c",
  "python-gate/aifinpay_gate/wsgi.py": "2f508c708af248aaaf38c0c5b215267041482c0dd282ea2ddd4cea0b9c54ce75",
  "python-gate/aifinpay_gate/__init__.py": "ca7e3cbe09735fae56cd4adfb7d493337e32c7036fb1953fec4deb8d7120787c",
  "python/aifinpay/aifp1.py": "62f3d03d31a0bb89d9a9162d83176b9ed4ff6de3e17981e4e00914abcf0c2162",
  "python/aifinpay/client.py": "96e7112e9acfb7f8dc24d626c2446424158c1aeef4ad4dcbe67d7aa8eef82a4b",
  "python/aifinpay/unified_agent.py": "d79d4ca0f4bde885d5720db9b57e2851b4e0e2d11ac94b68fd439b261af0b57f",
  "python-gate/tests/test_reporting_funnels_v2.py": "ed7b9178fd6615a24921f8951ba56bafa286908e2972f7bcfb321303ae386aeb",
  "python/tests/test_reporting_funnels_v2.py": "e93804d678736d6d05fcc353bd2dac873ef4d3f7f36e2ce165372d0eb8129d5c",
  "python-gate/pyproject.toml": "b2636bad8adafd9e267958837f84c1d2d38ca80b98faa14174be48e5539d31f3",
  "python/pyproject.toml": "c2c560258b122bec4d48714950219c939324dc522e4cb2dc4d4d1b84589568b3",
  "python-gate/CHANGELOG.md": "67fd1db617cb1e8879eaebba48874a255c9b0c8616d8b9cb91e1b2f058a0e32a",
  "python/CHANGELOG.md": "32135aaf369c0c253b09b480d17a3df68f626abeaeee10471b70891241e967cd",
  "docs/stories/reporting-funnels-s05-assumptions.md": "52de916e3c31510adfb35d4d312071c718bf30aec14084d1e8c722b4eb482098",
  "docs/stories/reporting-funnels-s06-assumptions.md": "08e1f1774f08082799ff6402ab03de03beb580edf77ab51a4ef0fa470cc33b22",
  "CHANGELOG.md": "2cd351623a6fdc7de7cfaa5ca0ffe658c46fc2abbfafe853170a3ac4f32e6b8f"
}
```

## Historical original actual replay / decision (superseded by closure above)

Reviewer slot CLOSED on the frozen sources,2026-10-09. Incremental QA FAIL:
two retained product reds, no waiver. MAIN may resume authors; any repair needs
a new pin/retest. No author repair occurred during this replay. Only the four
dispatched new files edited; package inventory adds exactly two reviewer test
files. All245 pre-existing files and all34published/metadata pins unchanged.

| Actual execution | Pass | Fail | Skip | Qualification |
|---|---:|---:|---:|---|
| Node independent |48|1|0|49controls; SEC-SDK-01 red |
| Python independent |42|1|0|43controls; SEC-SDK-02 red |
| Full Node gate incl. independent |256|1|0|21files;208author tests pass |
| Full Python gate incl. independent |331|1|0|332controls;289author tests pass |
| Node payer existing/author suite |734|0|0|38files |
| Python payer existing/author suite |435|0|0|Actual source metadata/dependencies |

Unique full replay total1758:1756PASS/2FAIL/0SKIP. Independent counts are a
subset, not added twice. Gate Node5.14s/Python19.77s; payer Node18.90s/
Python17.78s. Python gate2existing warnings: Starlette httpx deprecation and
intentional threaded-fork control. Neither hides skips. Coverage=null;
author line coverage does not establish independent branch coverage.

Independent test hashes after final edits/end check:

```text
9608fda92fe3f89728cc38d77de8f6ca586b832ed32a28674cab5d143bb0dfc8 gate/tests/reporting-funnels-independent.test.ts
38eaac86bc479b25306d1a657ec897b8d95f9f1fa7c50d1b25505ab14663c431 python-gate/tests/test_reporting_funnels_independent.py
```

## Exact replay commands

Workroot `/Users/regrttrol/Documents/code/AiFinPay/sdk-reporting`. Run each
command from the indicated package directory. Gate HTTP needs loopback
permission, only ephemeral reviewer-owned127.0.0.1 endpoints. All other
transport injected; no external API/RPC/registry/install operation.

```sh
# gate:259; append tests/reporting-funnels-independent.test.ts for49
/Users/regrttrol/.nvm/versions/node/v24.0.2/bin/node node_modules/vitest/vitest.mjs run --no-cache
# node:734
/Users/regrttrol/.nvm/versions/node/v24.0.2/bin/node node_modules/vitest/vitest.mjs run --no-cache
# python-gate:337; replace tests with tests/test_reporting_funnels_independent.py for43
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:../python:/private/tmp/aifp-reporting-qa.IKSesN/s06-python-install:/private/tmp/aifp-reporting-qa.IKSesN/python-venv/lib/python3.13/site-packages:/Users/regrttrol/Documents/code/AiFinPay/aifinpay-sdk/python/.venv/lib/python3.13/site-packages /private/tmp/aifp-reporting-qa.IKSesN/python-venv/bin/python -m pytest -p no:cacheprovider tests -q
# python:435; existing truthful current-source metadata target from S06
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH=.:/private/tmp/aifp-reporting-qa.IKSesN/s06-python-install:/Users/regrttrol/Documents/code/AiFinPay/aifinpay-sdk/python/.venv/lib/python3.13/site-packages /private/tmp/aifp-reporting-qa.IKSesN/python-venv/bin/python -m pytest -p no:cacheprovider tests -q
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
absent from auth/payment bodies/journal/receipt cache/ledger. Full Node734
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

CURRENT HANDOFF: MAIN | incremental repaired SDK slice PASS | SEC-SDK-01/02 independently CLOSED | 92/92 independent;1765/1765 combined | reviewer slot CLOSED | fresh start/end pins verified | no waiver | backend/human/release gates pending
