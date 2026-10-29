# ADR 0007 — Shared payment deployment JSON Schema

Date: 2026-10-19. Status: accepted.

## Context

Versioned deployment JSON files need a schema reference that resolves both in
the repository and in the published `@aifinpay/deployments` package. EVM,
Solana and Casper files have ecosystem-specific record layouts, while EVM
history also includes route and legacy variants.

## Decision

Maintain one JSON Schema at
`deployments/src/reference/payment-deployments.schema.json`. Its ecosystem
branches describe the common EVM, Solana and Casper registry shapes while
allowing additive, version-specific record fields. Generated deployment
records omit `status` and `disabledReason`; `settlementEnabled` remains
packaged metadata rather than a live availability assertion. Each registry
file points to that source schema with a relative `$schema` reference. Include
the schema in the published package so those references remain resolvable to
consumers.

## Consequences

- Schema changes and registry references are reviewed together.
- Registry JSON remains the source of deployment metadata; the schema does not
  establish deployment availability or authorize settlement.
- The deployment package version changes when this published artifact changes.
