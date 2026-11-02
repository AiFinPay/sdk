# @aifinpay/deployments

## Deployment registry & artifact manager

This package provides a programmatic interface for querying AIFP deployment records and contract artifacts (ABI/IDL).

### Quick Start

```typescript
import { AifinpayRegistry, ArtifactRegistry } from "@aifinpay/deployments";

// Load deployment registries
const evmRegistry = AifinpayRegistry.loadEvm("latest");      // or "1.4", "1.3", etc.
const solanaRegistry = AifinpayRegistry.loadSolana("latest");

// Load contract artifacts
const artifacts = ArtifactRegistry.load();

// Query deployments
const optimism = evmRegistry.getEvmDeployment(10);
const splitterAddr = evmRegistry.getSplitterAddress(10);
const stablecoins = evmRegistry.getStablecoins(10);

// Get supported chains
const chains = evmRegistry.getSupportedChains("enabled");
const networks = evmRegistry.getNetworkList();             // [{ chainId, name, settlementEnabled, testnet }]

// Export as markdown/json/csv
const markdown = evmRegistry.exportAsMarkdown("prod");
const json = evmRegistry.exportAsJson();
const csv = evmRegistry.exportAsCsv();

// Query artifacts
const abi = artifacts.getEvmAbi("B2BSplitterV14", "1.4");
const solanaIdl = artifacts.getSolanaIdl("mainnet");
const nearAbi = artifacts.getNearAbi("aifinpay-near-contract");
```

See [USAGE.md](./USAGE.md) for complete documentation.

## Evidence and availability

Use the [registry index](registry/splitter/INDEX.md) to select the actual
machine-readable record for the required ecosystem, version, chain and route.
Addresses, program IDs, runtime hashes, governance and provenance belong in
those records, not copied tables here.

Registry queries read packaged metadata; they do not check live chain state or
backend receipt verification. Settlement flags are not current verification
results. Follow the index's runtime/backend verification checklist and obtain
fresh end-to-end evidence before claiming availability. Never infer activation
from an export.

---

## Registry grabber (legacy)

`src/grabber.ts` pulls the latest deployment records from the canonical
upstream repositories and produces per-ecosystem split registry files:

- EVM v1.4: `registry/splitter/evm/v1.4/deployments.json`
- Solana v1.4: `registry/splitter/solana/deployments.json`

```bash
cd deployments
npm ci --no-audit --no-fund
npm run build          # compile TypeScript
npm run registry:build # fetch upstream + write registry/*.json
npm test               # offline unit tests
```

## Registry layout

Per-ecosystem split files are the canonical artifacts. ABI and IDL
subdirectories are kept for downstream consumers that need raw contract
artifacts:

```
registry/
├── splitter/                  # versioned registry with governance metadata
│   ├── evm/
│   │   ├── v1.4/deployments.json  # EVM v1.4 full contract suite
│   │   ├── v1.3/deployments.json  # EVM v1.3 route table
│   │   ├── v1.2/deployments.json  # EVM v1.2 legacy
│   │   └── v1.1/deployments.json  # EVM v1.1 legacy
│   ├── solana/deployments.json # Solana v1.4 program deployments
│   ├── casper/deployments.json # Casper deployments
│   ├── near/deployments.json   # Curated NEAR account/WASM snapshots
│   └── aptos/                  # Aptos deployment snapshots
│       ├── deployments.json
│       └── multisig-deployments.json
├── abi/
│   ├── aptos/       # Aptos splitter ABI snapshots
│   ├── evm/         # EVM ABI bundles (including the linted B2BSplitterV14 ABI)
│   └── tron/        # Tron ABI bundles when applicable
└── idl/
    ├── solana/      # Solana IDL (splitter-v14 mainnet/devnet)
    ├── aptos/       # Aptos IDL artifacts
    └── casper/      # Casper IDL artifacts
```

The [registry index](registry/splitter/INDEX.md) links versioned JSON records
and interface guides, and the [payment deployment JSON
Schema](src/reference/payment-deployments.schema.json) describes their
ecosystem-specific record shapes. Output selection is implemented in the
[grabber](src/grabber.ts) and [build CLI](src/build.ts); upstream provenance is
stored in the generated JSON rather than this README.

Aptos records are curated package data, not outputs of `registry:build`. See the
[Aptos registry guide](registry/splitter/aptos/README.md) for snapshot
provenance and refresh instructions.

NEAR deployment records are curated package data, not grabber outputs or
programmatic deployment lookup APIs. NEAR ABI documents are available through
`ArtifactRegistry`. See the [NEAR registry guide](registry/splitter/near/README.md)
for provenance, field normalization, governance caveats, and refresh instructions.

## Exports

### Deployment Registry

- `AifinpayRegistry.loadEvm(version?)` — load EVM deployment registry (default: "latest" = "1.4")
- `AifinpayRegistry.loadSolana(version?)` — load Solana deployment registry (default: "latest" = "1.4")
- `getEvmDeployment(chainId)` — O(1) lookup by chain ID
- `getEvmByNetwork(network)` — lookup by network name
- `getSplitterAddress(chainId)`, `getTokenListAddress(chainId)`, `getProfilesAddress(chainId)` — contract addresses
- `getStablecoins(chainId)` — stablecoin list
- `isSettlementEnabled(chainId)` — recorded settlement flag, not a live check
- `getGovernanceSafe(env)` — Safe multisig address
- `getProdDeployments()`, `getTestnetDeployments()` — filtering
- `getSupportedChains(filter?)` — get list of supported chain IDs (filter: "all" | "prod" | "testnet" | "enabled")
- `getNetworkList(filter?)` — get network list with metadata
- `isChainSupported(chainId)` — check if chain is supported
- `getChainIdByNetwork(network)` — get chain ID by name
- `getNetworkByChainId(chainId)` — get network name by ID
- `exportAsMarkdown(filter?)`, `exportAsJson(filter?)`, `exportAsCsv(filter?)` — export formats

### Artifact Registry

- `ArtifactRegistry.load()` — load all ABI/IDL artifacts
- `getEvmAbi(contractName, version?)` — EVM ABI
- `getSolanaIdl(cluster)` — Solana IDL (mainnet/devnet)
- `getCasperIdl(network)` — Casper IDL (mainnet/testnet)
- `getAptosIdl(contractName, version?)` — Aptos IDL
- `getTronAbi(contractName, version?)` — Tron ABI
- `getNearAbi(contractName, version?)` — NEAR ABI document
- `getAllNearAbis()` — all loaded NEAR ABI documents

### Legacy grabber (deprecated)

- `buildRegistry()` — fetch upstream EVM + Solana records (deprecated: use `AifinpayRegistry.loadEvm()`)
- `writeSplitRegistries(registry, outDir)` — write split registry files
- `grabEvmDeployments()` / `grabSolanaDeployments()` — grab one chain family
- `getEvmDeployment(registry, chainId)` / `getSolanaDeployment(registry, cluster)` — O(1) lookup helpers
- `isEvmDeployment(d)` / `isSolanaDeployment(d)` — type guards

### Types

- `DeploymentRegistry`, `EcosystemRegistry`, `Deployment`, `EvmDeployment`, `SolanaDeployment`, `Stablecoin`
- `EvmDeploymentRecord`, `SolanaDeploymentRecord`, `EvmAbiArtifact`, `SolanaIdlArtifact`, `NearAbiArtifact`
