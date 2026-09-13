# @aifinpay/deployments

## Deployment registry grabber

`src/grabber.ts` pulls the latest deployment records from the canonical
upstream repositories and produces `registry/deployments.json`:

- EVM v1.2/v1.4: `https://github.com/AiFinPay/evm-contract/tree/dev/deployments`
- Solana v1.4/v1.4.1: `https://github.com/AiFinPay/solana-contract/tree/dev/deployments/splitter_v14`

For each chain/cluster it keeps only the latest record by (version desc,
timestamp desc), so lookup by `chainId` or `cluster` is O(1).

```bash
cd deployments
npm ci --no-audit --no-fund
npm run build          # compile TypeScript
npm run registry:build # fetch upstream + write registry/deployments.json
npm test               # offline unit tests
```

## Registry layout

`registry/deployments.json` is the main artifact shipped in the package
tarball. ABI and IDL subdirectories are kept for downstream consumers
that need raw contract artifacts:

```
registry/
├── deployments.json   # combined EVM + Solana latest records
├── abi/
│   ├── evm/         # EVM ABI bundles (manual or build-copied)
│   └── tron/        # Tron ABI bundles when applicable
└── idl/
    ├── solana/      # Solana IDL copies from upstream
    ├── aptos/       # Aptos IDL artifacts
    └── casper/      # Casper IDL artifacts
```

## Usage

```ts
import {
  buildRegistry,
  getEvmDeployment,
  getSolanaDeployment,
} from "@aifinpay/deployments";

const registry = await buildRegistry();
const polygon = getEvmDeployment(registry, 137);
const solanaMainnet = getSolanaDeployment(registry, "mainnet");
```

## Exports

- `buildRegistry()` — fetch upstream EVM + Solana records and return a typed `DeploymentRegistry`.
- `grabEvmDeployments()` / `grabSolanaDeployments()` — grab only one chain family.
- `getEvmDeployment(registry, chainId)` / `getSolanaDeployment(registry, cluster)` — O(1) lookup helpers.
- `isEvmDeployment(d)` / `isSolanaDeployment(d)` — type guards.
- Types: `DeploymentRegistry`, `Deployment`, `EvmDeployment`, `SolanaDeployment`, `Stablecoin`.
