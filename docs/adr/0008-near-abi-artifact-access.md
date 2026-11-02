# ADR 0008 — NEAR ABI artifact access

Date: 2026-11-02. Status: accepted.

## Context

The deployments package includes a curated NEAR contract ABI, but the
`ArtifactRegistry` does not load or expose artifacts from the NEAR ABI
directory.

## Decision

Load NEAR ABI JSON documents from `registry/abi/near/` through
`ArtifactRegistry`, using the document's metadata name and version as lookup
keys. Expose both contract/version lookup and enumeration, and retain the full
document as the artifact's `abi` value.

## Consequences

- Consumers can access packaged NEAR interfaces through the same public
  registry entry point as other ecosystem artifacts.
- Deployment snapshots remain distinct from ABI metadata; this API does not
  authorize or indicate NEAR payment availability.
