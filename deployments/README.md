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

// Query artifacts
const abi = artifacts.getEvmAbi("B2BSplitterV14", "1.4");
const solanaIdl = artifacts.getSolanaIdl("mainnet");
```

See [USAGE.md](./USAGE.md) for complete documentation.

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
│   └── casper/deployments.json # Casper deployments
├── abi/
│   ├── evm/         # EVM ABI bundles (B2BSplitterV14, TimelockWrapper)
│   └── tron/        # Tron ABI bundles when applicable
└── idl/
    ├── solana/      # Solana IDL (splitter-v14 mainnet/devnet)
    ├── aptos/       # Aptos IDL artifacts
    └── casper/      # Casper IDL artifacts
```

### Version history

| Registry | Location | Versions | Status |
|---|---|---|---|
| Legacy route table | `registry/splitter/evm/v1.3` | v1.2 `legacy`, v1.3 `merchant-aifp1` / `agent-x402` | Superseded; kept for `node/` SDK generation |
| Legacy v1.2 | `registry/splitter/evm/v1.2` | v1.2 with `paymentId` replay guard | Superseded |
| Legacy v1.1 | `registry/splitter/evm/v1.1` | v1.1 initial release | Superseded |
| This package | `registry/splitter/evm/v1.4/deployments.json` | v1.4 EVM | Active grabber output |
| This package | `registry/splitter/solana/deployments.json` | v1.4 Solana | Active grabber output |

## Exports

### Deployment Registry

- `AifinpayRegistry.loadEvm(version?)` — load EVM deployment registry (default: "latest" = "1.4")
- `AifinpayRegistry.loadSolana(version?)` — load Solana deployment registry (default: "latest" = "1.4")
- `getEvmDeployment(chainId)` — O(1) lookup by chain ID
- `getEvmByNetwork(network)` — lookup by network name
- `getSplitterAddress(chainId)`, `getTokenListAddress(chainId)`, `getProfilesAddress(chainId)` — contract addresses
- `getStablecoins(chainId)` — stablecoin list
- `isSettlementEnabled(chainId)` — settlement status
- `getGovernanceSafe(env)` — Safe multisig address
- `filterByStatus(status)`, `getProdDeployments()`, `getTestnetDeployments()` — filtering

### Artifact Registry

- `ArtifactRegistry.load()` — load all ABI/IDL artifacts
- `getEvmAbi(contractName, version?)` — EVM ABI
- `getSolanaIdl(cluster)` — Solana IDL (mainnet/devnet)
- `getCasperIdl(network)` — Casper IDL (mainnet/testnet)
- `getAptosIdl(contractName, version?)` — Aptos IDL
- `getTronAbi(contractName, version?)` — Tron ABI

### Legacy grabber (deprecated)

- `buildRegistry()` — fetch upstream EVM + Solana records (deprecated: use `AifinpayRegistry.loadEvm()`)
- `writeSplitRegistries(registry, outDir)` — write split registry files
- `grabEvmDeployments()` / `grabSolanaDeployments()` — grab one chain family
- `getEvmDeployment(registry, chainId)` / `getSolanaDeployment(registry, cluster)` — O(1) lookup helpers
- `isEvmDeployment(d)` / `isSolanaDeployment(d)` — type guards

### Types

- `DeploymentRegistry`, `EcosystemRegistry`, `Deployment`, `EvmDeployment`, `SolanaDeployment`, `Stablecoin`
- `EvmDeploymentRecord`, `SolanaDeploymentRecord`, `EvmAbiArtifact`, `SolanaIdlArtifact`
