# `@aifinpay/deployments` structure

This file records the full directory layout of the `deployments/` package. Update it when files, outputs, or registry subdirectories change.

## Top-level

```
deployments/
├── AGENTS.md              # agent guide (scope, commands, rules)
├── README.md              # package documentation
├── package.json           # @aifinpay/deployments metadata & scripts
├── package-lock.json      # lockfile (npm)
├── tsconfig.json          # TypeScript config
├── vitest.config.ts       # test runner config
├── .gitignore             # ignored build/install artifacts
├── src/                   # TypeScript source
├── dist/                  # compiled output (tsc)
├── tests/                 # offline unit tests
└── registry/              # shipped deployment artifacts
    ├── evm-splitter-v1.4.json     # EVM v1.4 deployments (includes Safe)
    ├── solana-splitter-v1.4.json  # Solana v1.4.1 deployments
    ├── deployments.json           # generated combined registry (backward-compat)
    ├── reference/                 # historical / upstream copies
    │   ├── evm-splitter-v1.3.json
    │   ├── payment-deployments.json
    │   ├── payment-deployments.schema.json
    │   ├── splitter-table.json
    │   └── splitter-table-source.json
    ├── abi/               # EVM / Tron ABI bundles
    └── idl/               # Solana / Aptos / Casper IDL artifacts
```

## Source (`src/`)

| File | Purpose |
|------|---------|
| `src/index.ts` | Public exports: `buildRegistry`, `writeSplitRegistries`, `grabEvmDeployments`, `grabSolanaDeployments`, `getEvmDeployment`, `getSolanaDeployment`, `isEvmDeployment`, `isSolanaDeployment`, `ABI_DIR`, `IDL_DIR`, and all types. |
| `src/grabber.ts` | GitHub listing helpers, EVM + Solana fetch + latest-per-chain selection, split-file writer, O(1) lookup helpers. |
| `src/types.ts` | Registry TypeScript types: `DeploymentRegistry`, `EcosystemRegistry`, `EvmDeployment`, `SolanaDeployment`, `Stablecoin`, type guards. |
| `src/build.ts` | CLI entry point for `npm run registry:build`; writes `registry/deployments.json` and split files. |


## Tests (`tests/`)

| File | Coverage |
|------|----------|
| `tests/grabber.test.ts` | `compareVersionTime`, `listGitHubFiles`, `fetchJson`, mocked `grabEvmDeployments`, mocked `grabSolanaDeployments` + IDL writes, mocked `buildRegistry`, `writeSplitRegistries`. |

## Registry artifacts (`registry/`)

### `registry/evm-splitter-v1.4.json`

Canonical EVM v1.4 deployment registry. Includes `schemaVersion`, `generatedAt`, `ecosystem`, `protocolVersion`, `sources`, and a `deployments` array. Each deployment includes `contracts` (splitter, tokenList, profiles, admin, signer, pauser, treasury), `assets`, `runtimeCodeHash`, `safe` (address, version, threshold, owners), and `status`/`settlementEnabled`.

### `registry/solana-splitter-v1.4.json`

Canonical Solana v1.4.1 deployment registry. Includes `schemaVersion`, `generatedAt`, `ecosystem`, `protocolVersion`, `sources`, and a `deployments` array. Each deployment includes `programId` and `idl` metadata.

### `registry/deployments.json`

Combined, generated registry with two top-level keys:

- `evm: Record<string, EvmDeployment>` keyed by `chainId`.
- `solana: Record<string, SolanaDeployment>` keyed by cluster (`mainnet`, `devnet`).

Includes `generatedAt` and `sources` provenance. Kept for backward compatibility.

### `registry/reference/`

Historical and upstream-copied artifacts:

- `evm-splitter-v1.3.json` — v1.3 route table snapshot (merchant-aifp1 + agent-x402 routes).
- `payment-deployments.json` — upstream v1.4 combined registry.
- `payment-deployments.schema.json` — JSON Schema for the v1.4 payment registry.
- `splitter-table.json` — upstream v1.2/v1.3 route table.
- `splitter-table-source.json` — provenance for `splitter-table.json`.

### `registry/abi/`

```
registry/abi/
├── evm/
│   ├── B2BSplitterV14/B2BSplitterV14.json
│   └── TimelockWrapper/TimelockWrapper.json
└── tron/
    └── .gitkeep
```

### `registry/idl/`

```
registry/idl/
├── aptos/
│   └── .gitkeep
├── casper/
│   └── .gitkeep
└── solana/
    └── splitter-v14/
        ├── splitter.devnet.json
        └── splitter.mainnet.json
```

## Build/test flow

1. `npm ci --no-audit --no-fund`
2. `npm run build` → populates `dist/`
3. `npm run registry:build` → fetches upstream + writes `registry/deployments.json`, `registry/evm-splitter-v1.4.json`, `registry/solana-splitter-v1.4.json`
4. `npm test` → runs `vitest` offline

## Full file list

Excluding `node_modules/` and `dist/`:

```
.gitignore
AGENTS.md
README.md
package-lock.json
package.json
registry/abi/evm/B2BSplitterV14/B2BSplitterV14.json
registry/abi/evm/TimelockWrapper/TimelockWrapper.json
registry/abi/tron/.gitkeep
registry/deployments.json
registry/evm-splitter-v1.4.json
registry/solana-splitter-v1.4.json
registry/reference/evm-splitter-v1.3.json
registry/reference/payment-deployments.json
registry/reference/payment-deployments.schema.json
registry/reference/splitter-table.json
registry/reference/splitter-table-source.json
registry/idl/aptos/.gitkeep
registry/idl/casper/.gitkeep
registry/idl/solana/splitter-v14/splitter.devnet.json
registry/idl/solana/splitter-v14/splitter.mainnet.json
src/build.ts
src/grabber.ts
src/index.ts
src/types.ts
tests/grabber.test.ts
tsconfig.json
vitest.config.ts
```
