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
    ├── splitter/                  # versioned registry with governance metadata
    │   ├── INDEX.md               # registry index with lookup tables
    │   ├── evm/                   # EVM deployments
    │   │   ├── v1.4/deployments.json  # EVM v1.4 full contract suite
    │   │   ├── v1.3/deployments.json  # EVM v1.3 route table
    │   │   ├── v1.2/deployments.json  # EVM v1.2 legacy
    │   │   └── v1.1/deployments.json  # EVM v1.1 legacy
    │   ├── solana/deployments.json # Solana v1.4 program deployments
    │   └── casper/deployments.json # Casper deployments
    ├── abi/               # EVM / Tron ABI bundles
    └── idl/               # Solana / Aptos / Casper IDL artifacts
```

## Source (`src/`)

| File | Purpose |
|------|---------|
| `src/index.ts` | Public exports: `buildRegistry`, `writeSplitRegistries`, `grabEvmDeployments`, `grabSolanaDeployments`, `getEvmDeployment`, `getSolanaDeployment`, `isEvmDeployment`, `isSolanaDeployment`, `ABI_DIR`, `IDL_DIR`, and all types. |
| `src/grabber.ts` | GitHub listing helpers, EVM + Solana fetch + latest-per-chain selection, deployment file writer, O(1) lookup helpers. |
| `src/types.ts` | Registry TypeScript types: `DeploymentRegistry`, `EcosystemRegistry`, `EvmDeployment`, `SolanaDeployment`, `Stablecoin`, type guards. |
| `src/build.ts` | CLI entry point for `npm run registry:build`; writes deployment files to `registry/splitter/evm/v1.4/` and `registry/splitter/solana/`. |


## Tests (`tests/`)

| File | Coverage |
|------|----------|
| `tests/grabber.test.ts` | `compareVersionTime`, `listGitHubFiles`, `fetchJson`, mocked `grabEvmDeployments`, mocked `grabSolanaDeployments` + IDL writes, mocked `buildRegistry`, `writeSplitRegistries`. |

## Registry artifacts (`registry/`)

### `registry/splitter/`

Versioned deployment registry with governance metadata. Each version directory contains `deployments.json` following a consistent schema:

- `evm/v1.4/deployments.json` — EVM v1.4 full contract suite with governance Safe info
- `evm/v1.3/deployments.json` — EVM v1.3 route table (merchant-aifp1 + agent-x402 routes)
- `evm/v1.2/deployments.json` — EVM v1.2 legacy with `paymentId` replay guard
- `evm/v1.1/deployments.json` — EVM v1.1 initial production release
- `solana/deployments.json` — Solana v1.4 program deployments
- `casper/deployments.json` — Casper deployments (testnet live, mainnet historical)
- `INDEX.md` — registry index with lookup tables by version and chain

Each `deployments.json` includes `$schema`, `version`, `description`, `schemaVersion`, `generatedAt`, `ecosystem`, `protocolVersion`, `source`, `governance` (EVM only), `deployments` array, and `sourceArtifact` metadata.

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
3. `npm run registry:build` → fetches upstream + writes `registry/splitter/evm/v1.4/deployments.json`, `registry/splitter/solana/deployments.json`
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
registry/splitter/INDEX.md
registry/splitter/casper/deployments.json
registry/splitter/casper/README.md
registry/splitter/evm/v1.1/deployments.json
registry/splitter/evm/v1.1/README.md
registry/splitter/evm/v1.2/deployments.json
registry/splitter/evm/v1.2/README.md
registry/splitter/evm/v1.3/deployments.json
registry/splitter/evm/v1.3/README.md
registry/splitter/evm/v1.4/deployments.json
registry/splitter/evm/v1.4/README.md
registry/splitter/solana/deployments.json
registry/splitter/solana/README.md
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
