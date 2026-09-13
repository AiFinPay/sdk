# ADR-0001: Fail-closed payment deployment resolution

**Date:** 2026-09-13
**Status:** proposed
**Deciders:** AiFinPay CTO/protocol team
**Tickets:** AIFINP-223, AIFINP-224

## Context

The SDK currently resolves EVM and Solana deployments from separate generated
tables. EVM `auto` selection prefers v1.4 but silently falls back to v1.2 when
v1.4 is unavailable. Solana already fails when v1.4 is absent because it has no
valid v1.2 fallback.

Payment versions are not interchangeable. They may use different contracts,
quote formats, payout economics, governance, token allow-lists and backend
verification logic. Availability cannot safely choose those semantics.

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
- Resolution uses an exact rail, environment, network and version tuple.
- Omitted version/`auto` means the single reviewed default for that exact
  network. It does not mean a version search.
- Missing, disabled, mismatched or unverifiable entries return a typed error
  before a wallet transaction is constructed.
- Assets are an explicitly identified array. A token symbol alone is never a
  payment identity.
- Deployment existence and settlement readiness are separate registry states.
- BOT Chain has no production payment default and remains disabled in payment
  resolution under contract ADR-0001.

No resolver may silently downgrade or switch protocol version, environment,
network, rail, route or asset.

## Consequences

### Positive

- A stale deployment fails before funds move.
- SDK releases are reproducible and traceable to exact contract artifacts.
- EVM and Solana follow the same selection policy.
- Robinhood can represent USDe/USDG without inventing USDC/USDT fields.
- Networks can be distributed as disabled metadata and enabled independently
  after full verification.
- Rollback disables the affected target instead of redirecting money through a
  legacy contract.

### Negative

- Clients that relied on EVM `auto` fallback will receive a typed error.
- Every deployment/configuration update requires registry regeneration and an
  SDK release.
- Deprecated table exports must be maintained temporarily.
- The backend and SDK release processes become coupled at the settlement-ready
  gate.

## Alternatives considered

### Keep automatic v1.4 → v1.2 fallback

Rejected. It changes payment semantics because a preferred deployment is
unavailable. A warning is not enough once an autonomous client can submit
funds.

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
4. Move both resolvers to exact registry lookup and remove version fallback.
5. Remove BOT Chain from payment allow-lists and add Robinhood as disabled.
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
