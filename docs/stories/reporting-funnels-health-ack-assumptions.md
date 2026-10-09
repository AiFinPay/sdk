# REPORTING-FUNNELS-20261009 — CR05 combined SDK author remediation

2026-10-09. Role: bounded S05/S06 author remediation under the owner's approved
reporting implementation; high risk, supervised 20% cap retained. This document
is the only working log for this remediation. Independent QA/Security/review,
architecture contract clarification and human approvals remain pending.

## Owned scope and decisions

- Read project root AiFinPay.md, SDK/gate AGENTS, installed shared B inherited
  AGENTS/SDLC gates/dev/regulatory, principal YAGNI, architecture-auditor skill,
  full CR05 review, prior author and independent SDK reports, and exact S03 API
  clarification before implementation. python-gate/AGENTS.md is absent;
  SDK root applies. No missing instructions file was created.
- Canonical tests verified and announced before editing: gate/tests/reporting-funnels-v2.test.ts
  (not gate/test/) and python-gate/tests/test_reporting_funnels_v2.py
  (not test_reporting_v2.py).
- Actual S03 health handler and generated API return exactly version=2 and a
  boolean duplicate. Use a dedicated strict HealthAck parser in each reporter;
  preserve event Ack validation unchanged. Refuse event ACKs, count fields,
  missing/wrong version, nonboolean duplicate, unrelated JSON and extra keys.
- Shared architecture defines Ack without the dedicated HealthAck distinction.
  S03 API clarification explicitly records this inconsistency and pending
  architect/human approval. Author remediation aligns with the current handler;
  it does not silently approve the whole frozen contract or close CR05 itself.
- Health lastSample/last_sample retains only the original producer HealthSample,
  including its locally reported at. No receiver timestamp or authoritative
  acceptance/count/financial fact is invented. Preserve pacing, frozen retries,
  close/auth shutdown and independently closed SEC-SDK-01/02 source behavior.
- Existing B Graft graph was queried for health routing; K has only a cache,
  no graph, so no K graph is built. Retrieval is not acceptance evidence.
- TDD will invoke the actual non-I/O S03 route handler with synthetic req/res
  and feed its exact response through both public SDK health clients. No real
  backend POST, remote HTTP, installation, Git, release or payment operation.

Exactly seven owned paths under /Users/regrttrol/Documents/code/AiFinPay/sdk-reporting/:

1. gate/src/reporter.ts
2. python-gate/aifinpay_gate/reporter.py
3. gate/tests/reporting-funnels-v2.test.ts
4. python-gate/tests/test_reporting_funnels_v2.py
5. gate/REPORTING-V2.md
6. python-gate/REPORTING-V2.md
7. docs/stories/reporting-funnels-health-ack-assumptions.md

## Pre-change SHA256

```text
d65d3c4cd08317a5cf8f85d80f1e3ec262c06fc9c0997e8bfdf3cd138fd2ad17 gate/src/reporter.ts
f6629df2736668e40a7ca2d9036e7f921bbfbb687f49a511fe71e253f1501505 python-gate/aifinpay_gate/reporter.py
07bccb7f9337f2781e701a5876373c75412a814cecd60c6c01b5b1e8a9c8cc52 gate/tests/reporting-funnels-v2.test.ts
6194524e670fc9c2033881bbf769f385fcae4e67837df5e74bab76f8942656b0 python-gate/tests/test_reporting_funnels_v2.py
421d4e761489d1fd8a49f7baadba6252850071eed8302ef0915a7f368a5cee1c gate/REPORTING-V2.md
d5982d462fc982c0378c7b54d0607abb1b2b60cab960b49424fbdcf23736d8e8 python-gate/REPORTING-V2.md
```

Pre-change read-only SHA256 inventory captured in memory:237 regular files,
including four package trees (excluding dependencies/generated/cache trees),
SDK handoffs/reviewer reports/root changelog and seven B contract/source files.
The count differs from earlier reviewer inventories; no identical-inventory
claim is made. End comparison will identify every changed inventoried path.

## Assumptions and pending gates

- The exact S03 health shape remains current for this bounded remediation;
  changing the handler/OpenAPI shape invalidates this assumption and requires
  MAIN/S03 coordination plus a fresh contract review and independent replay.
- Synthetic handler output establishes client wire interoperability, not actual
  authentication, PG dedupe/commit-before-ack, deployment or partner coverage.
- Independent tests and reports stay read-only; obsolete event-style health
  fixtures may fail after correction and must be reported honestly for their
  owner. No waiver or self-approval is allowed.

Validation pending. No independent gate advanced.
