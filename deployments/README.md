# @aifinpay/deployments

## Deployment registry grabber

`src/grabber.ts` pulls the latest deployment records from the canonical
upstream repositories and produces `registry/deployments.json`:

- EVM v1.2/v1.4 only: `https://github.com/AiFinPay/evm-contract/tree/dev/deployments`
- Solana v1.4/v1.4.1: `https://github.com/AiFinPay/solana-contract/tree/dev/deployments/splitter_v14`

For each chain/cluster it keeps only the latest record by (version desc,
timestamp desc), so lookup by `chainId` or `cluster` is O(1).

```bash
npm run build          # compile TypeScript
npm run registry:build # fetch upstream + write registry/deployments.json
npm test               # offline unit tests
```

## Usage

```ts
import { buildRegistry, getEvmDeployment, getSolanaDeployment } from "@aifinpay/internal-tokenlist";

const registry = await buildRegistry();
const polygon = getEvmDeployment(registry, 137);
const solanaMainnet = getSolanaDeployment(registry, "mainnet");
```