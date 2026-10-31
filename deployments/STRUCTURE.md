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
├── src/                   # TypeScript source and schema references
├── dist/                  # compiled output (tsc)
├── tests/                 # offline unit tests
└── registry/              # shipped deployment artifacts
    ├── splitter/                  # versioned registry with governance metadata
    │   ├── INDEX.md               # registry links and verification checklist
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
| `src/index.ts` | Public exports: `AifinpayRegistry`, `ArtifactRegistry`, `buildRegistry`, `writeSplitRegistries`, `grabEvmDeployments`, `grabSolanaDeployments`, `getEvmDeployment`, `getSolanaDeployment`, `isEvmDeployment`, `isSolanaDeployment`, `ABI_DIR`, `IDL_DIR`, and all types. |
| `src/registry.ts` | `AifinpayRegistry` class: programmatic interface for querying deployment records with O(1) lookups. |
| `src/artifacts.ts` | `ArtifactRegistry` class: programmatic interface for querying ABI/IDL artifacts. |
| `src/grabber.ts` | GitHub listing helpers, EVM + Solana fetch + latest-per-chain selection, deployment file writer, O(1) lookup helpers. |
| `src/types.ts` | Registry TypeScript types: `DeploymentRegistry`, `EcosystemRegistry`, `EvmDeployment`, `SolanaDeployment`, `Stablecoin`, type guards. |
| `src/build.ts` | CLI entry point for `npm run registry:build`; writes deployment files to `registry/splitter/evm/v1.4/` and `registry/splitter/solana/`. |
| `src/reference/payment-deployments.schema.json` | Shared JSON Schema defining deployment record shapes for EVM, Solana, Casper, Aptos and NEAR. |


## Tests (`tests/`)

| File | Coverage |
|------|----------|
| `tests/grabber.test.ts` | `compareVersionTime`, `listGitHubFiles`, `fetchJson`, mocked `grabEvmDeployments`, mocked `grabSolanaDeployments` + IDL writes, mocked `buildRegistry`, `writeSplitRegistries`. |
| `tests/registry.test.ts` | `AifinpayRegistry` class: all public methods for EVM/Solana deployment queries. |
| `tests/artifacts.test.ts` | `ArtifactRegistry` class: EVM ABI, Solana IDL, Casper IDL, Aptos IDL, Tron ABI queries. |
| `tests/schema.test.ts` | Checks that each registry's relative `$schema` reference resolves to the packaged schema. |

## Registry artifacts (`registry/`)

### `registry/splitter/`

Versioned deployment registry with governance metadata. Consult the
[registry index](registry/splitter/INDEX.md) for links to each JSON and the
verification checklist; this layout is not an availability report.

- `evm/v1.4/deployments.json` — EVM v1.4 full contract suite with governance Safe info
- `evm/v1.3/deployments.json` — EVM v1.3 route table (merchant-aifp1 + agent-x402 routes)
- `evm/v1.2/deployments.json` — EVM v1.2 legacy with `paymentId` replay guard
- `evm/v1.1/deployments.json` — EVM v1.1 initial production release
- `solana/deployments.json` — Solana v1.4 program deployments
- `casper/deployments.json` — Casper deployment records
- `aptos/` — curated Aptos mainnet/testnet payment and multisig snapshots
- `INDEX.md` — registry links and verification checklist
- Each deployment JSON references `src/reference/payment-deployments.schema.json` using a relative `$schema` link.

Common metadata fields include `version`, `schemaVersion`, `generatedAt`,
`ecosystem`, `protocolVersion`, `source`, `deployments` and `sourceArtifact`.
Field layout varies by ecosystem/version; read the selected JSON and
[registry types](src/types.ts). Treat settlement flags in generated EVM and
Solana records as packaged metadata requiring fresh runtime/backend evidence,
not proof of activation.

### `registry/abi/`

```
registry/abi/
├── aptos/
│   └── splitter/
│       ├── splitter-mainnet-<address>.json
│       └── splitter-testnet-<address>.json
├── evm/
│   ├── B2BSplitterV14/B2BSplitterV14.json
│   ├── B2BSplitterV14/B2BSplitterV14-linted.json # Required for Arc and subsequent EVM deployments
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
│   ├── .gitkeep
│   └── aifinpay-casper-schema.json
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
USAGE.md                 # User documentation for programmatic interface
STRUCTURE.md             # This file
package-lock.json
package.json
registry/abi/evm/B2BSplitterV14/B2BSplitterV14.json
registry/abi/evm/B2BSplitterV14/B2BSplitterV14-linted.json
registry/abi/evm/TimelockWrapper/TimelockWrapper.json
registry/abi/tron/.gitkeep
registry/abi/aptos/splitter/splitter-mainnet-<address>.json
registry/abi/aptos/splitter/splitter-testnet-<address>.json
registry/splitter/INDEX.md
registry/splitter/aptos/README.md
registry/splitter/aptos/deployments.json
registry/splitter/aptos/multisig-deployments.json
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
registry/idl/casper/.gitkeep
registry/idl/casper/aifinpay-casper-schema.json
registry/idl/solana/splitter-v14/splitter.devnet.json
registry/idl/solana/splitter-v14/splitter.mainnet.json
src/build.ts
src/grabber.ts
src/index.ts
src/types.ts
src/registry.ts            # AifinpayRegistry class
src/artifacts.ts            # ArtifactRegistry class
src/reference/payment-deployments.schema.json
src/reference/aptos-multisig-deployment.schema.json
tests/grabber.test.ts
tests/registry.test.ts      # AifinpayRegistry tests
tests/artifacts.test.ts     # ArtifactRegistry tests
tests/schema.test.ts
tsconfig.json
vitest.config.ts
```
