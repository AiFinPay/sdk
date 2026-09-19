# Public v1.4 payment candidate — review and release evidence

2026-09-19. Local candidate only. Not published, merged, deployed or exercised
with a new live payment. Requirements: `v14-public-payment`.

## Result

An ordinary owner can use the candidate's generic MCP `payable_fetch`, backed by
Node SDK native Polygon v1.4 execution and persistent wallet state. No Raters
adapter is part of the product. Existing contracts and the September12 accepted
mutable ADMIN_ROLE profile model remain unchanged.

Candidates: Node2.1.0, MCP2.2.0, skill2.0.15 and gate0.3.3. The public versions
remain older. MCP's lockfile pins the exact local Node/skill tarball integrities;
registry installation cannot be claimed until those dependencies are published.

## Automated and independent evidence

- Node: registry check, build, lint and437/437 tests pass.
- MCP:174/174 tests, build and lint pass against the actual packed Node candidate.
- Gate:115/115 tests, build and lint pass. Removed instructions link negative
  control fails; restored version passes.
- Backend merchant configuration:25 adjacent tests pass. Real store and route
  handlers cover12 cases; HTTP auth middleware was stubbed in that focused suite.
- Backend v1.4 verification:18 behavioral tests pass. Removing the mutable-fee
  compatibility fix reproduces the regression; restored version passes.
- Backend full suite:885 tests,883 passed,0 failed,2 skipped (unavailable live
  Solana RPC). RPC-budget fixtures now count the pinned-runtime read and restore
  their mocks after success/failure. Independent parent review found no blocker.
- Website and merchant dashboard: TypeScript/build pass. Dashboard route check
  passes. Docs:8 edited MDX pages compile,18 internal links resolve locally.
- Node/MCP production dependency scans: no high or critical advisory; two existing
  moderate stream-json/jayson findings remain. This is not a zero-risk claim.
- Final artifact metadata, Node/skill SHA512 lock integrity and MCP bundled-skill
  equality pass. Tarballs and SHA256 manifest are in the workspace release evidence.

Independent review was performed by agents other than each change's author:
`v14_executor`, `payment_sdlc`, `payment_route_review` and parent cross-review.
Initial redirect, receipt-echo and first-directory journal durability findings
were fixed and re-reviewed. No remaining blocking finding was identified within
this bounded review. This is not an external audit or live acceptance result.

## Boundaries and remaining acceptance

Only native Polygon GET purchases are exposed by MCP. The low-level SDK also
supports native Amoy execution; Amoy receipt purchases and stable-token execution
are not enabled by this MCP candidate. Owner limits and exact origins are required.

Pending payments reserve budget. A crashed process leaves an operation lock for
owner reconciliation; it must not be cleared until the exact saved transaction
hash is reconciled. No receipt, raw transaction or private key belongs in logs.

The backend verifies the exact signed purchase, pinned deployed runtime at the
mined block and actual split conservation. Under the accepted contract model,
an admin fee change does not invalidate an otherwise legitimate purchase.
Legacy v1.2/v1.3 merchant floors remain enforced.

Raters must fix its dev llms.txt links to dev discovery/catalog. Its existing
catalog already describes51 paid resources. The catalog remains in the merchant
application; AiFinPay does not automatically upload that configuration.

The global Polygon indexer still reads legacy Payment events. Raters merchant
receipt history is separate. Do not describe this candidate as v1.4 global
indexed-history or analytics support.

## Release sequence

1. Human review of this concrete high-risk candidate; CI on review branches.
2. Integrate backend into dev and verify quote, signed instructions, receipt
   recovery and merchant history against the existing v1.4 route.
3. Publish exact Node and skill artifacts; check registry integrity; then clean
   install/build/test MCP from its lockfile and publish MCP.
4. Release gate links and updated public skill/site/docs/dashboard presentation.
5. Promote the dev-verified backend; explicitly select Raters merchant v1.4 only
   when quote-time readiness passes. Do not change payout or contract registry.
6. From published packages and owner limits: discover Raters → one purchase →
   data → repeat without payment → same hash in Raters merchant receipts.
7. Record the public-client flow only after this acceptance passes.

Do not roll back to a legacy executor after a prepared/broadcast v1.4 payment.
Disable new purchases if rollout fails, retain recovery state and keep receipt
recovery available for any transaction that may already have settled.

## Traceability

```yaml
traceability:
  requirement_id: v14-public-payment
  ai_agents:
    - {role: architecture_and_mcp, agent: payment_sdlc}
    - {role: executor_and_cross_review, agent: v14_executor}
    - {role: backend_and_cross_review, agent: payment_route_review}
    - {role: integration_and_cross_review, agent: root}
  repository: AiFinPay/sdk
  changed_modules: [node, mcp, gate, public_skill, merchant_settings, receipt_verifier, docs]
  gate_results:
    requirement: pass
    architecture: standing_user_decision_2026_09_12
    implementation: pass
    testing: local_pass_live_acceptance_pending
    security: independent_review_complete_human_signoff_pending
    code_review: independent_review_complete_human_signoff_pending
    deployment: pending
    definition_of_done: pending
  risk_class: high
  human_approvals:
    - {gate: contract_model, approver: user, date: 2026-09-12}
  deployment: {env: none, ref: null, artifacts: [agent2.1.0, mcp2.2.0, skill2.0.15]}
  metrics: {test_coverage_pct: null, human_review_minutes: null}
```
