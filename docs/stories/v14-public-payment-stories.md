# Public v1.4 payment — execution and acceptance

Traceability: `v14-public-payment`. Planning status only; no test/deployment pass
is asserted by this artifact.

Risk: high financial/security impact; medium technical complexity and breaking
change probability; sensitive wallet/receipt data; no intended infrastructure or
contract mutation. Payment autonomy cap: 20%, with existing user authorization
for implementation under the accepted v1.4 design. Independent security/code
review and concrete release evidence remain required before final sign-off.

1. SDK executor: supported native pins/ABI/signature/role/profile/nonce checks,
   simulation, bounded send, mined success, unknown-confirmation recovery.
2. SDK fetch flow: preserve signed quote identity, independent price and caps,
   retained budget/receipt/pending-payment state, direct merchant receipt reuse.
3. MCP: owner-only enablement/limits, safe origin selection, generic tool and
   recovery surface, truthful bounded output. Test against packed new SDK.
4. Backend compatibility: verify dev quote/pay/indexer, perform dev acceptance,
   then controlled approved production payment and matching merchant record.
5. Release/documentation: version bumps/changelogs, source-package integration,
   public skill/docs instructions, deployment evidence and recording runbook.

## Required test evidence

| Area | Positive case | Negative/recovery cases |
|---|---|---|
| Executor | Valid signed native Polygon/Amoy quote confirms | Alter every signed field; wrong chain/runtime/signer/role/route/value; malformed signature; expired/stale nonce/paused/profile mismatch; unsupported token |
| Budgets | Correct independent price and owner cap reserve then commit | Missing/stale FX, USD/native mismatch, oversized model cap, invalid cap, gas/value overflow, concurrent calls |
| Confirmation | Successful receipt with expected event | Revert; timeout after broadcast; lost response; retry/restart recovers same hash and cannot create second payment |
| AIFP-1 | Verified JWT cached, content succeeds, batch reused | Wrong issuer/payer/merchant/scope/order; invalid JWT; receipt response loss; paid content retry failure retains receipt |
| MCP boundary | Tool works through packed SDK and persisted wallet | Ephemeral wallet/payment disabled, SSRF/redirect/private address, origin mismatch, secret headers, overlong body, unsupported protocol no fallback |
| Full flow | Public tool → quote → tx → receipt → HTTP200 → same dashboard hash | Second request performs zero payments; lost HTTP recovery; quota exhaustion explicit |

Unit/integration tests use mock HTTP/RPC boundaries; live controlled acceptance is
separate evidence. Run package registry check, build, relevant full suites, Node
and MCP production dependency audit, secret/diff checks, independent review, and
negative controls that remove a critical binding to prove regression tests fail.

Current evidence is recorded in `../reviews/v14-public-payment-review.md`.
Implementation and local validation are complete; independent review findings
were addressed. Human sign-off, dev/live acceptance, publication and deployment
remain pending. Local test passes do not establish production readiness.
