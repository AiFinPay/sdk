# Solana Splitter v1.4 — Program Registry

## Deployment lookup

Solana deployments use a program ID and IDL rather than an EVM contract suite.
Read [deployments.json](deployments.json) for cluster, environment, program ID,
IDL metadata, recorded status, settlement flag and reason fields.

`disabledReason` is a recorded explanation, not a currently verified statement
about backend implementation or upgrade authority. Inspect the actual registry
and obtain live program/runtime and backend receipt-verification evidence.
Never infer activation from the presence of a program ID or IDL, and never
bypass a disabled record.

## Verification

Use the [deployment resolver](../../../../node/src/solanaDeploymentResolver.ts)
and [settlement checks](../../../../node/src/settlementSolanaV14.ts) to understand
SDK gating and transaction validation. Before settlement, verify the executable
program, ProgramData, upgrade authority, configuration, selected asset and
receipt binding for the selected cluster. Fresh backend and end-to-end evidence
is also required; source code alone does not prove deployment availability.

See the [registry verification checklist](../INDEX.md). This guide grants no
production activation or availability-bypass authority.

## IDL files

- [Devnet IDL](../../idl/solana/splitter-v14/splitter.devnet.json)
- [Mainnet IDL](../../idl/solana/splitter-v14/splitter.mainnet.json)

Read each IDL's metadata rather than assuming interface versions are identical.

## Provenance and refresh

The JSON's `source`, `sourceArtifact` and `generatedAt` fields record upstream
provenance. The [grabber](../../../src/grabber.ts) and
[build CLI](../../../src/build.ts) define fetching and output paths.
From `deployments/`, `npm run build` followed by `npm run registry:build`
refreshes generated registry outputs; it does not verify live settlement.
