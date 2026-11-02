# B2BSplitter v1.4 — Contract Suite Registry

## Contract roles

The v1.4 registry describes a contract suite:

- `splitter` — Payment settlement
- `tokenList` — Allowed assets
- `profiles` — Agent/merchant identity profiles
- `admin` — Administrative control
- `signer` — Signature verification
- `pauser` — Emergency pause control
- `treasury` — Fee recipient

## Deployment and governance lookup

Read [deployments.json](deployments.json) for each chain's contract addresses,
asset list, `runtimeCodeHash`, `settlementEnabled` and Safe metadata. Inspect
both top-level `governance` and per-deployment `safe` and `contracts` fields
rather than assuming all chains share a Safe.

The registry's `source`, `sourceArtifact` and `generatedAt` fields carry recorded
provenance. Generation is implemented by the [grabber](../../../../src/grabber.ts)
and [build CLI](../../../../src/build.ts); run `npm run build` followed by
`npm run registry:build` from `deployments/` only when intentionally refreshing
these artifacts.

## Verification

Settlement flags are not fresh runtime/backend evidence. Before settlement,
check the actual selected record and obtain live evidence for
contract bytecode, configured signer, governance, treasury, allowed assets and
backend receipt verification. Do not treat a listed address or ABI as proof of
availability.

See [SDK preflight and execution checks](../../../../../node/src/settlementV14.ts)
and the [registry verification checklist](../../INDEX.md). Keep disabled,
invalid, testnet and policy gates intact; this guide does not authorize
activation.

## Interface

- [Linted splitter ABI](../../../abi/evm/B2BSplitterV14/B2BSplitterV14-linted.json) — use this ABI for Arc and every subsequent EVM chain deployment.
- [Original splitter ABI](../../../abi/evm/B2BSplitterV14/B2BSplitterV14.json) — retained as a separate artifact; it is not the deployment ABI for Arc or subsequent EVM chains.
- [Timelock ABI](../../../abi/evm/TimelockWrapper/TimelockWrapper.json)
- [Registry types](../../../../src/types.ts)

Using this ABI defines the contract interface for a deployment; it does not
verify deployment bytecode or authorize settlement activation. Follow the
[verification checklist](../../INDEX.md) and runtime/backend checks before
claiming availability.
