# ADR-0001: Controlled EVM automatic fallback

**Date:** 2026-09-13
**Status:** proposed
**Deciders:** AiFinPay CTO/protocol team
**Tickets:** AIFINP-223, AIFINP-224

## Context

The SDK resolves EVM and Solana deployments from separate generated tables.
AIFINP-223 requires EVM `auto` selection to prefer v1.4 and fall back to v1.2
when v1.4 is unavailable. Explicit v1.4 must never downgrade. Solana has no
valid v1.2 fallback and therefore fails when v1.4 is unavailable.

Payment versions may use different contracts and verification logic. The
automatic fallback is therefore limited to the documented `auto` mode and the
resolved result always reports the concrete selected version.

The reviewed deployment commits also contain networks that are deployed but
not yet safe to advertise as payable. Examples include an internally
inconsistent Base artifact, a Polygon asset-identity error, Robinhood assets
that do not fit the existing fixed USDC/USDT SDK model, and new Solana program
IDs that require complete executable/initialization evidence and backend
verification.

## Decision

AiFinPay will use one static canonical payment deployment registry for EVM and
Solana.

- SDK deployment artifacts are generated deterministically from that registry.
- Contract-repository artifacts are imported offline from pinned commits and
  recorded with hashes.
- Runtime code never fetches configuration from GitHub, Jira, or a mutable URL.
- Resolution uses an exact rail, environment, network and requested version.
- EVM omitted version/`auto` selects enabled v1.4 first, then a known production
  v1.2 deployment. If neither is usable, it returns a typed error.
- Explicit EVM v1.4 and v1.2 never substitute another version.
- Solana `auto` selects only v1.4 because no v1.2 deployment exists.
- Disabled or invalid v1.4 records are never returned as v1.4 payment targets.
- Assets are an explicitly identified array. A token symbol alone is never a
  payment identity.
- Deployment existence and settlement readiness are separate registry states.
- BOT Chain has no v1.4 record under contract ADR-0001. Its existing legacy
  v1.2 record remains available for backward compatibility until a separate
  deprecation decision removes it.

No explicit version request may downgrade or switch environment, network, rail,
route or asset. The only version fallback is the AIFINP-223 EVM `auto` rule.

## Consequences

### Positive

- A stale deployment fails before funds move.
- SDK releases are reproducible and traceable to exact contract artifacts.
- EVM and Solana follow the same selection policy.
- Robinhood can represent USDe/USDG without inventing USDC/USDT fields.
- Networks can be distributed as disabled metadata and enabled independently
  after full verification.
- A quarantined v1.4 deployment can fall back only where a reviewed legacy
  deployment already exists.

### Negative

- EVM callers that omit the version may receive v1.2 while v1.4 is quarantined;
  callers that require v1.4 must request it explicitly.
- Every deployment/configuration update requires registry regeneration and an
  SDK release.
- Deprecated table exports must be maintained temporarily.
- The backend and SDK release processes become coupled at the settlement-ready
  gate.

## Alternatives considered

### Remove automatic v1.4 → v1.2 fallback

Rejected because it contradicts AIFINP-223 and breaks existing integrations.
The safety boundary is explicit selection: `version: "v1.4"` always fails when
v1.4 is absent, disabled or invalid.

### Fetch the latest deployment files from GitHub at runtime

Rejected. Branch contents are mutable, availability becomes a payment
dependency, and the reviewed SDK package no longer determines its payout
target.

### Keep separate hand-maintained EVM and Solana tables

Rejected. The current tables have already drifted from their source commits and
use incompatible asset/readiness models.

### Enable every address present in a deployment commit

Rejected. A deploy transaction proves neither correct initialization nor
backend quote/receipt support. Deployment metadata may be imported, but it
starts disabled.

## Migration

1. Add the canonical registry and schema.
2. Import EVM `78240ec...` and Solana `e5df8f5...` as disabled records.
3. Generate the unified TypeScript artifact and deprecated compatibility views.
4. Keep EVM `auto` fallback centralized in the resolver; keep explicit versions exact.
5. Exclude BOT Chain from v1.4 and add Robinhood as disabled v1.4 metadata.
6. Correct Polygon asset identity and reject the current Base record.
7. Enable deployments individually only after verification, funded E2E,
   security review and human approval.

## Compliance and approval

This changes payment routing and therefore carries a 10–30% AI autonomy cap
under the project SDLC. Architecture, security, code review and production
enablement require named human approval. Production deployment remains a
separate authorized action.

## References

- `docs/architecture/aifinp-223-224-payment-registry.md`
- `node/src/deploymentResolver.ts`
- `node/src/solanaDeploymentResolver.ts`
- `node/src/v14Deployments.generated.ts`
- `node/src/solanaV14Deployments.generated.ts`
- `AiFinPay/evm-contract` commit `78240eccf96dd078c9b40be068d635b14876364c`
- `AiFinPay/solana-contract` commit `e5df8f5436cf646ab495381eee04e0d1a10b4e2f`
