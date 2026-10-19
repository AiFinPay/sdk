# Splitter Deployment Registry — Index

Versioned deployment records and interface artifacts. Registry values are recorded
inputs to verification, not evidence of current runtime or backend availability.

## Registry lookup

| Registry | Machine-readable records | Guide |
|----------|--------------------------|-------|
| EVM v1.1 | [deployments.json](evm/v1.1/deployments.json) | [Legacy interface](evm/v1.1/README.md) |
| EVM v1.2 | [deployments.json](evm/v1.2/deployments.json) | [Replay guard](evm/v1.2/README.md) |
| EVM v1.3 | [deployments.json](evm/v1.3/deployments.json) | [Protocol routes](evm/v1.3/README.md) |
| EVM v1.4 | [deployments.json](evm/v1.4/deployments.json) | [Contract suite](evm/v1.4/README.md) |
| Solana | [deployments.json](solana/deployments.json) | [Program and IDL](solana/README.md) |
| Casper | [deployments.json](casper/deployments.json) | [Contract schema](casper/README.md) |

Read the selected record for chain/network identity, addresses or program IDs,
runtime hashes, governance, assets, policy fields and settlement flags. Read
`source`, `sourceArtifact` and `generatedAt` where present for provenance;
do not infer provenance from the age of this guide.

## Querying records

Use [AifinpayRegistry](../../src/registry.ts) and the
[usage guide](../../USAGE.md) for lookups and generated exports. A registry query
does not perform live verification. For v1.3, select the raw record by chain
**and** `_route`; the chain-keyed registry API cannot distinguish multiple routes
on the same chain.

## Refreshing and testing

The [grabber](../../src/grabber.ts) and [build CLI](../../src/build.ts) define
upstream selection and generated output locations. From `deployments/`:

```bash
npm run build
npm test
# Explicit maintenance operation: fetches upstream and rewrites registry outputs.
npm run registry:build
```

These commands build, test or refresh records; none proves live settlement.
Review upstream provenance and resulting JSON changes before adopting refreshed
records. The grabber does not regenerate the v1.3 route snapshot; preserve its
provenance when maintaining it. See the [package rules](../../AGENTS.md).

For downstream SDK generation, see
[the generator](../../../node/scripts/generate-splitter-routes.mjs).
Run `npm run registry:check` from `node/` to check generated files against the
installed deployment package. This is an offline consistency check, not runtime
or backend verification.

## Interface artifacts

- [EVM ABI bundles](../abi/evm/)
- [Solana IDL copies](../idl/solana/splitter-v14/)
- [Casper contract schema](../idl/casper/aifinpay-casper-schema.json)
- [Artifact loading implementation](../../src/artifacts.ts)
