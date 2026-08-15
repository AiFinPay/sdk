# ADR-001 — Product route ↔ fee profile policy (AIFINP-119 P0-3)

**Status:** Proposed — implementation complete, awaiting founder sign-off.
**Date:** 2026-08-15
**Jira:** AIFINP-119 (P0-3), AIFINP-106

## Context

The 14 Aug founder audit found that dual routing between the two products was
not implemented: the SDK forbade v1.1/v1.2 signing entirely, while the stated
plan ("keep v1.2 for AIFP-1") contradicted that gate. The audit requires an
explicit policy for which payment type may select which contract family and
fee profile, with the server challenge unable to make that choice.

The economics were locked on 14 Aug (`evm-contract` commits `4ac56bf`,
`bf2ebd1`): **AIFP-2 agent x402 = 0/0** (no AiFinPay fee) and **AIFP-1
merchant monetization = 100/0** (1% protocol fee on top, no creator leg).
The v1.3 deploy script exposes exactly these as its two named `FEE_PROFILE`s
(`agent-x402`, `merchant-aifp1`), implying one v1.3 deployment per profile
per chain.

## Decision

1. **A payment's route class is declared by the SDK entry point that
   initiated it, never by the server.**
   - `AiFinPayAgent.call()` — the x402 bridge flow — **is** the AIFP-2
     `agent-x402` route.
   - `AiFinPayAgent.fetchPaid()` — the AIFP-1 gateway paywall flow — **is**
     the `merchant-aifp1` route.
   The 402 challenge supplies amounts and an order id only. It cannot name a
   route class, a contract family, a version, or a fee profile; those resolve
   from the SDK's verified registry plus the code path itself.

2. **Each route settles only against a registry target carrying exactly its
   approved fee profile** (`ROUTE_FEE_PROFILES` in
   `node/src/paymentRegistry.ts`):
   - `agent-x402` → `treasuryBps 0 / ipCreatorBps 0`
   - `merchant-aifp1` → `treasuryBps 100 / ipCreatorBps 0`
   Anything else fails closed with `route_fee_profile_mismatch:<route>`,
   including the retired 100/1 profile and any cross-pairing (AIFP-2 on a
   fee-bearing target, AIFP-1 on a 0/0 target). An unrecognised route class
   fails with `route_class_unknown`.

3. **Both products settle on the v1.3 contract family only.** v1.1/v1.2
   remain rejected (`fee_inclusive_splitter_disabled`) for both routes — the
   audit-identified contradiction is resolved in favour of the gate. AIFP-1
   does not return to v1.2; it waits for a `merchant-aifp1` (100/0) v1.3
   deployment, just as AIFP-2 waits for an `agent-x402` (0/0) one.

## Consequences

- Neither route can settle until the corresponding v1.3 profile is deployed
  and enabled in the registry — unchanged from the current fail-closed state.
- Each chain that supports both products needs two registry entries (one per
  profile), which the registry schema already supports as separate targets.
- Cross-route negative tests, both directions plus the retired profile and an
  unknown class, live in `node/tests/paymentTargetRegistry.test.ts`.

## Open for founder confirmation

- This ADR encodes 0/0 and 100/0 as fixed constants in the SDK. If a future
  profile change is expected before the investment round closes, say so now —
  the constants would then move into the generated registry table instead.
- Whether MCP tools and the Python SDK must surface the route class in their
  public signatures in this release, or inherit it from the Node agent's
  entry points as they do today.
