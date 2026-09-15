# @aifinpay/deployments — Usage Guide

Programmatic interface for querying AIFP deployment records and contract artifacts (ABI/IDL).

## Installation

```bash
npm install @aifinpay/deployments
```

## Quick Start

```typescript
import { AifinpayRegistry, ArtifactRegistry } from "@aifinpay/deployments";

// Load registries
const evmRegistry = AifinpayRegistry.loadEvm();      // latest = v1.4
const solanaRegistry = AifinpayRegistry.loadSolana(); // latest = v1.4
const artifacts = ArtifactRegistry.load();
```

---

## AifinpayRegistry — Deployment Records

### Load EVM Registry

```typescript
// Load latest version (v1.4)
const registry = AifinpayRegistry.loadEvm();

// Load specific version
const v14 = AifinpayRegistry.loadEvm("1.4");
const v13 = AifinpayRegistry.loadEvm("1.3");
const v12 = AifinpayRegistry.loadEvm("1.2");
const v11 = AifinpayRegistry.loadEvm("1.1");

// Explicit latest
const latest = AifinpayRegistry.loadEvm("latest");
```

### Load Solana Registry

```typescript
// Load latest version (v1.4)
const registry = AifinpayRegistry.loadSolana();

// Explicit version
const v14 = AifinpayRegistry.loadSolana("1.4");
const latest = AifinpayRegistry.loadSolana("latest");
```

### Query Deployments

```typescript
const registry = AifinpayRegistry.loadEvm();

// Get deployment by chain ID
const optimism = registry.getEvmDeployment(10);
if (optimism) {
  console.log(optimism.chain);        // "optimism"
  console.log(optimism.status);       // "enabled"
  console.log(optimism.contracts);    // { splitter, tokenList, profiles, ... }
}

// Get deployment by network name
const polygon = registry.getEvmByNetwork("polygon");
console.log(polygon?.chainId); // 137

// Get all deployments
const all = registry.getAllEvmDeployments();

// Filter by status
const enabled = registry.filterByStatus("enabled");
const disabled = registry.filterByStatus("disabled");

// Get prod/testnet deployments
const prod = registry.getProdDeployments();
const testnet = registry.getTestnetDeployments();
```

### Contract Addresses

```typescript
const registry = AifinpayRegistry.loadEvm();
const chainId = 10; // Optimism

// Get contract addresses
const splitter = registry.getSplitterAddress(chainId);
const tokenList = registry.getTokenListAddress(chainId);
const profiles = registry.getProfilesAddress(chainId);

// All return null if not found
const unknown = registry.getSplitterAddress(99999); // null
```

### Stablecoins

```typescript
const registry = AifinpayRegistry.loadEvm();
const chainId = 10; // Optimism

const stablecoins = registry.getStablecoins(chainId);
// Returns: Array<{ symbol: string, name: string, address: string }>

for (const coin of stablecoins) {
  console.log(`${coin.symbol}: ${coin.address}`);
}

// Empty array if chain not found
const empty = registry.getStablecoins(99999); // []
```

### Settlement Status

```typescript
const registry = AifinpayRegistry.loadEvm();

// Check if settlement is enabled
const enabled = registry.isSettlementEnabled(10); // true/false

// Returns false for unknown chains
const disabled = registry.isSettlementEnabled(99999); // false
```

### Governance

```typescript
const registry = AifinpayRegistry.loadEvm();

// Get Safe multisig addresses
const prodSafe = registry.getGovernanceSafe("prod");
const testnetSafe = registry.getGovernanceSafe("testnet");
```

### Registry Metadata

```typescript
const registry = AifinpayRegistry.loadEvm();

console.log(registry.getVersion());      // "1.4"
console.log(registry.getGeneratedAt());  // ISO 8601 timestamp
```

---

## ArtifactRegistry — ABI/IDL Artifacts

### Load Artifacts

```typescript
const artifacts = ArtifactRegistry.load();
```

### EVM ABI

```typescript
const artifacts = ArtifactRegistry.load();

// Get ABI by contract name and version
const abi = artifacts.getEvmAbi("B2BSplitterV14", "1.4");
if (abi) {
  console.log(abi.contractName);  // "B2BSplitterV14"
  console.log(abi.version);       // "1.4"
  console.log(abi.abi);           // ABI array
  console.log(abi.bytecode);      // Optional bytecode
}

// Default version (1.4)
const defaultAbi = artifacts.getEvmAbi("B2BSplitterV14");

// Get all ABIs
const allAbis = artifacts.getAllEvmAbis();

// Returns null if not found
const unknown = artifacts.getEvmAbi("UnknownContract"); // null
```

### Solana IDL

```typescript
const artifacts = ArtifactRegistry.load();

// Get IDL by cluster
const mainnetIdl = artifacts.getSolanaIdl("mainnet");
const devnetIdl = artifacts.getSolanaIdl("devnet");

if (mainnetIdl) {
  console.log(mainnetIdl.programName);  // "splitter"
  console.log(mainnetIdl.version);      // "1.4"
  console.log(mainnetIdl.cluster);      // "mainnet"
  console.log(mainnetIdl.idl);          // Full IDL object
}

// Get all IDLs
const allIdls = artifacts.getAllSolanaIdls();
```

### Casper IDL

```typescript
const artifacts = ArtifactRegistry.load();

// Get IDL by network
const testnetIdl = artifacts.getCasperIdl("testnet");
const mainnetIdl = artifacts.getCasperIdl("mainnet");

// Get all Casper IDLs
const allIdls = artifacts.getAllCasperIdls();
```

### Aptos IDL

```typescript
const artifacts = ArtifactRegistry.load();

// Get IDL by contract name
const splitterIdl = artifacts.getAptosIdl("splitter");

// Get specific version
const versionedIdl = artifacts.getAptosIdl("splitter", "1.4");

// Get all Aptos IDLs
const allIdls = artifacts.getAllAptosIdls();
```

### Tron ABI

```typescript
const artifacts = ArtifactRegistry.load();

// Get ABI by contract name
const splitterAbi = artifacts.getTronAbi("B2BSplitter");

// Get specific version
const versionedAbi = artifacts.getTronAbi("B2BSplitter", "1.4");

// Get all Tron ABIs
const allAbis = artifacts.getAllTronAbis();
```

---

## Complete Example

```typescript
import { AifinpayRegistry, ArtifactRegistry } from "@aifinpay/deployments";

async function setupPayment(chainId: number) {
  // Load registries
  const evmRegistry = AifinpayRegistry.loadEvm();
  const artifacts = ArtifactRegistry.load();

  // Get deployment
  const deployment = evmRegistry.getEvmDeployment(chainId);
  if (!deployment) {
    throw new Error(`No deployment for chain ${chainId}`);
  }

  // Check settlement status
  if (!evmRegistry.isSettlementEnabled(chainId)) {
    throw new Error(`Settlement disabled on chain ${chainId}`);
  }

  // Get contract addresses
  const splitterAddress = evmRegistry.getSplitterAddress(chainId);
  const tokenListAddress = evmRegistry.getTokenListAddress(chainId);

  // Get stablecoins
  const stablecoins = evmRegistry.getStablecoins(chainId);
  console.log(`Available stablecoins: ${stablecoins.map(s => s.symbol).join(", ")}`);

  // Get ABI for contract interaction
  const abi = artifacts.getEvmAbi("B2BSplitterV14", "1.4");
  if (!abi) {
    throw new Error("ABI not found");
  }

  // Get governance info
  const prodSafe = evmRegistry.getGovernanceSafe("prod");
  console.log(`Governance Safe: ${prodSafe}`);

  return {
    deployment,
    splitterAddress,
    tokenListAddress,
    stablecoins,
    abi: abi.abi,
  };
}

// Usage
const config = await setupPayment(10); // Optimism
console.log(config);
```

---

## Error Handling

```typescript
const registry = AifinpayRegistry.loadEvm();

// Methods return null for not found
const deployment = registry.getEvmDeployment(99999);
if (deployment === null) {
  console.log("Chain not supported");
}

// Methods return empty arrays for not found
const stablecoins = registry.getStablecoins(99999);
if (stablecoins.length === 0) {
  console.log("No stablecoins configured");
}

// Settlement returns false for unknown chains
const enabled = registry.isSettlementEnabled(99999);
if (!enabled) {
  console.log("Settlement not available");
}
```

---

## TypeScript Types

```typescript
import type {
  EvmDeploymentRecord,
  SolanaDeploymentRecord,
  EvmAbiArtifact,
  SolanaIdlArtifact,
} from "@aifinpay/deployments";

// EVM deployment record
interface EvmDeploymentRecord {
  chain: string;
  chainId: number;
  environment: "dev" | "prod";
  testnet: boolean;
  status: "enabled" | "disabled" | "invalid" | "retired";
  settlementEnabled: boolean;
  contracts: {
    splitter: string;
    tokenList: string;
    profiles: string;
    admin: string;
    signer: string;
    pauser: string;
    treasury: string;
  };
  assets: Array<{
    symbol: string;
    name: string;
    address: string;
  }>;
  safe: {
    address: string;
    version: string;
    threshold: number;
  };
}

// EVM ABI artifact
interface EvmAbiArtifact {
  contractName: string;
  version: string;
  abi: unknown[];
  bytecode?: string;
}

// Solana IDL artifact
interface SolanaIdlArtifact {
  programName: string;
  version: string;
  cluster: "mainnet" | "devnet";
  idl: unknown;
}
```

---

## Registry Structure

The package ships with pre-built registry files:

```
registry/
├── splitter/
│   ├── evm/
│   │   ├── v1.4/deployments.json  # Latest EVM
│   │   ├── v1.3/deployments.json  # Historical
│   │   ├── v1.2/deployments.json  # Historical
│   │   └── v1.1/deployments.json  # Historical
│   └── solana/
│       └── deployments.json       # Solana v1.4
├── abi/
│   ├── evm/
│   │   ├── B2BSplitterV14/
│   │   └── TimelockWrapper/
│   └── tron/
└── idl/
    ├── solana/splitter-v14/
    ├── casper/
    └── aptos/
```

Use `loadEvm("1.4")` for the latest EVM version, or specify an older version for legacy deployments.
