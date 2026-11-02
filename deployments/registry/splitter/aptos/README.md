# Aptos deployment snapshots

This directory packages Aptos payment deployment records, multisig creation
records, and the artifacts those records reference:

- `deployments.json` contains the mainnet and testnet records and uses the shared
  [payment deployment schema](../../../src/reference/payment-deployments.schema.json).
- `multisig-deployments.json` contains the mainnet and testnet multisig records and uses the
  [multisig deployment schema](../../../src/reference/aptos-multisig-deployment.schema.json).
- Splitter ABI artifacts live under [`registry/abi/aptos/splitter/`](../../abi/aptos/splitter/).

Each deployment record carries its source repository, commit, source path, and
capture time. Treat them as recorded inputs, not live verification or
authorization to settle. Check the selected registry entry, backend
capabilities, merchant quote, and executor runtime checks before relying on any
route.

These are curated snapshots from `AiFinPay/aptos-contract` and are not generated
by `npm run registry:build`. To refresh them, compare the upstream
`deployments/*-latest.json` records with the matching timestamped records, copy
the referenced ABI artifacts into `registry/abi/aptos/splitter/`, preserve source
provenance, and verify all local schema and artifact paths. A package version
and root changelog update are required when these shipped files change.
