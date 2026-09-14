# @aifinpay/deployments

## Deployment registry grabber

`src/grabber.ts` pulls the latest deployment records from the canonical
upstream repositories and produces per-ecosystem split registry files:

- EVM v1.4: `registry/evm-splitter-v1.4.json`
- Solana v1.4.1: `registry/solana-splitter-v1.4.json`

For each chain/cluster it keeps only the latest record by (version desc,
timestamp desc), so lookup by `chainId` or `cluster` is O(1). A combined
`registry/deployments.json` is also emitted for backward compatibility.

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
├── evm-splitter-v1.4.json     # EVM v1.4 deployments (includes Safe info)
├── solana-splitter-v1.4.json  # Solana v1.4.1 deployments
├── deployments.json           # combined EVM + Solana (backward-compat)
├── reference/                 # historical / upstream copies
│   ├── evm-splitter-v1.3.json      # historical v1.3 route table
│   ├── payment-deployments.json    # upstream v1.4 combined registry
│   ├── payment-deployments.schema.json
│   ├── splitter-table.json         # upstream v1.2/v1.3 route table
│   └── splitter-table-source.json  # provenance for splitter-table.json
├── abi/
│   ├── evm/         # EVM ABI bundles (manual or build-copied)
│   └── tron/        # Tron ABI bundles when applicable
└── idl/
    ├── solana/      # Solana IDL copies from upstream
    ├── aptos/       # Aptos IDL artifacts
    └── casper/      # Casper IDL artifacts
```

### Version history

| Registry | Location | Versions | Status |
|---|---|---|---|
| Legacy route table | `registry/reference/splitter-table.json` (`node/registry/splitter-table.json` is authoritative) | v1.2 `legacy`, v1.3 `merchant-aifp1` / `agent-x402` | Superseded; kept for `node/` SDK generation |
| Historical v1.3 split | `registry/reference/evm-splitter-v1.3.json` | v1.3 EVM routes | Historical snapshot; no upstream fetcher |
| This package | `registry/evm-splitter-v1.4.json`, `registry/solana-splitter-v1.4.json` | v1.4 EVM + Solana | Active grabber output |
| v1.4 combined reference | `registry/reference/payment-deployments.json` | v1.4 only | Upstream copy; only **Amoy** enabled; mainnets disabled/invalid until backend v1.4 verification is complete |

v1.4 status at a glance (from `evm-splitter-v1.4.json`):
- `amoy` — enabled, settlement on.
- `polygon`, `arbitrum`, `avalanche`, `bnb`, `optimism`, `unichain`, `xrplevm`, `robinhood` — disabled (backend v1.4 receipt verification / settlement gate incomplete).
- `base` — invalid (splitter address collides with TokenList; Profiles has no runtime code; redeploy required).
- Solana `devnet` + `mainnet` — disabled (receipt verification not implemented; mainnet upgrade authority not multisig).

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
- `writeSplitRegistries(registry, outDir)` — write `evm-splitter-v1.4.json` + `solana-splitter-v1.4.json` from a combined registry.
- `grabEvmDeployments()` / `grabSolanaDeployments()` — grab only one chain family.
- `getEvmDeployment(registry, chainId)` / `getSolanaDeployment(registry, cluster)` — O(1) lookup helpers.
- `isEvmDeployment(d)` / `isSolanaDeployment(d)` — type guards.
- Types: `DeploymentRegistry`, `EcosystemRegistry`, `Deployment`, `EvmDeployment`, `SolanaDeployment`, `Stablecoin`.
