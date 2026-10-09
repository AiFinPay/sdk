# QUICKSTART — install and verify AiFinPay

This guide reflects the current v2 package surfaces. It intentionally separates identity/control-plane functions from payment execution so a developer does not mistake a quote or invoice for a completed payment.

## Current package line

- Python SDK: `aifinpay-agent 2.3.0`
- Node / TypeScript SDK: `@aifinpay/agent 2.3.0`
- MCP: `@aifinpay/mcp 2.4.1`

## Path 1 — MCP

Install / launch:

```bash
npx @aifinpay/mcp
```

Client config:

```json
{
  "mcpServers": {
    "aifinpay": {
      "command": "npx",
      "args": ["-y", "@aifinpay/mcp"]
    }
  }
}
```

For a persistent local wallet, initialize once. `init` creates an encrypted keystore and refuses to create one without a passphrase unless you ask for a plaintext test wallet:

```bash
AIFINPAY_WALLET_PASSPHRASE='<a long passphrase>' npx @aifinpay/mcp init
# disposable test wallet only:
npx @aifinpay/mcp init --plaintext
```

Then ask the MCP client to call `agent_reload` and `agent_address`.

### Current MCP tools

- `agent_address`
- `agent_reload`
- `agent_claim_self` — link the agent to its owner's dashboard; signs only an AiFinPay claim challenge for its own address
- `payable_fetch` — registered only when the owner enables payments (see below)
- `agent_quota`
- `agent_history`
- `agent_passport_resolve`
- `settlement_routes`
- `settlement_invoice`
- `settlement_solana`
- `settlement_casper`
- `deployment_info`

`dev_payment_quote` is available only when `AIFINPAY_MODE=dev`.

Without owner payment configuration no MCP tool signs or broadcasts a payment, and the settlement invoice tools only prepare and validate non-signing instructions. `payable_fetch` is registered, and pays AIFP-1 merchants on Polygon v1.4 by signing locally, only when the owner sets `AIFINPAY_PAYMENTS_ENABLED=1` with `AIFINPAY_MAX_USD`, `AIFINPAY_DAILY_USD`, `AIFINPAY_GATEWAY_ORIGINS` and `AIFINPAY_MAX_GAS_POL` ([mcp/README.md](./mcp/README.md)).

Legacy `agent_call`, `agent_quote`, `pay_with_split` and `quote_split` are not registered by the current MCP server.

Full client matrix: [MCP_CONFIG.md](./MCP_CONFIG.md)

## Path 2 — Node / TypeScript SDK

Install:

```bash
npm install @aifinpay/agent
```

Load an existing configured wallet without printing private material:

```ts
import { AiFinPayAgent } from "@aifinpay/agent";

const agent = await AiFinPayAgent.fromEnvironment();

console.log({
  evm: agent.evmAddress,
  solana: agent.solanaAddress,
  casper: agent.casperAddress,
});
```

`fromEnvironment()` is load-only. It does not create or overwrite a wallet.

Paid AIFP-1 execution goes through `fetchPaid`, which settles on v1.4 — Polygon by default, Base when selected with `v14.chain: "base"` — in the native asset or a pinned stablecoin. Before signing it checks the selected chain, the pinned deployment and its runtime, signer and profile, the token and the RPC; native payments also need a fresh independent `nativeUsdPrice`, and every v1.4 payment needs an explicit `maxGasWei`. The legacy Polygon v1.3 route still requires its separately reviewed settlement pin.

Read before using paid execution:

- [node/README.md](./node/README.md)
- [node/PAYMENT_RECEIPTS.md](./node/PAYMENT_RECEIPTS.md)
- [examples/agent-snippets](./examples/agent-snippets)

Do not retry a paid request blindly after a settlement/receipt error; retain the original quote, transaction reference and idempotency context and use the recovery path.

## Path 3 — Python SDK

Install:

```bash
pip install aifinpay-agent
```

Load an existing seed from the environment without printing it:

```python
import os
from aifinpay import AiFinPayAgent

agent = AiFinPayAgent.from_seed(os.environ["SEED_HASH"])

print({
    "evm": agent.evm_address,
    "solana": agent.solana_address,
})
```

Python pays AIFP-1 merchants with `AiFinPayAgent.fetch_paid(url, allowed_origins=[...], max_amount_usd=..., daily_amount_usd=...)`: Polygon v1.4 by default, in POL or a pinned stablecoin (`asset="USDC"`), or Base with `chain="base"` and an explicit `max_gas_wei`. Legacy paid `call()` settlement stays disabled.

See [python/README.md](./python/README.md).

## Merchant side

Install the merchant paywall:

```bash
npm install @aifinpay/gate
```

Use it to challenge AI-agent requests with HTTP 402, publish discovery metadata and meter paid access.

See [gate/README.md](./gate/README.md).

## Economics

Current v2 economics:

- **AIFP-1:** payer total equals the quoted gross amount; merchant receives **99%**; AiFinPay receives **1%**; creator/referral receives **0%**.
- **AIFP-2 / x402:** provider receives **100%**; AiFinPay protocol fee is currently **0%**.

The older 98.99% / 1% / 0.01% split is retired and must not be used as current economics.

## Solana status

The old Solana program `5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2` was closed and is not current.

Registry programs:

- Devnet: `8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y` — settlement disabled.
- Mainnet: `724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD` — settlement disabled.

Check [deployments/registry/splitter/solana/deployments.json](./deployments/registry/splitter/solana/deployments.json) or use MCP `deployment_info` for the current status.

## Historical on-chain evidence

Historical evidence only; these transactions do not certify the current release or current network readiness.

- Exa Search:
  [`0xeb13c5eddf645b3e5b5e5db82d8b19d301a4c0c8593f6e7dce9cd4c3359c8700`](https://polygonscan.com/tx/0xeb13c5eddf645b3e5b5e5db82d8b19d301a4c0c8593f6e7dce9cd4c3359c8700)
- io.net inference:
  [`0x7c6ca0ffcf75b1ca3ade4800fb896c4bb08bc5f1a91916dc2cf4918f16129f0a`](https://polygonscan.com/tx/0x7c6ca0ffcf75b1ca3ade4800fb896c4bb08bc5f1a91916dc2cf4918f16129f0a)

## Security

- Never print or log seeds, private keys, keystore JSON or signing secrets.
- Do not paste recovery material into chat, GitHub issues or shared configs.
- An invoice, quote, address or deployment ID is not proof that a payment occurred.
- Verify settlement status and runtime/deployment checks before moving funds.

## Next

- Documentation: https://aifinpay.io/docs
- MCP configuration: [MCP_CONFIG.md](./MCP_CONFIG.md)
- Node SDK: [node/README.md](./node/README.md)
- Python SDK: [python/README.md](./python/README.md)
- Issues: https://github.com/AiFinPay/sdk/issues
