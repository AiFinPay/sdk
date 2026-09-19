# QUICKSTART — install and verify AiFinPay

This guide reflects the current v2 package surfaces. It intentionally separates identity/control-plane functions from payment execution so a developer does not mistake a quote or invoice for a completed payment.

## Current package line

- Python SDK: `aifinpay-agent 2.1.0`
- Node / TypeScript SDK: `@aifinpay/agent 2.0.1`
- MCP: `@aifinpay/mcp 2.1.0`

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

For a persistent local wallet, initialize once:

```bash
npx @aifinpay/mcp init
```

Then ask the MCP client to call `agent_reload` and `agent_address`.

### Current production MCP tools

- `agent_address`
- `agent_reload`
- `agent_quota`
- `agent_history`
- `agent_passport_resolve`
- `settlement_routes`
- `settlement_invoice`
- `settlement_solana`
- `settlement_casper`
- `deployment_info`

`dev_payment_quote` is available only when `AIFINPAY_MODE=dev`.

The production MCP tools above do **not** sign or broadcast a payment. Settlement invoice tools prepare and validate non-signing instructions only.

Legacy `payable_fetch`, `agent_call`, `agent_quote`, `pay_with_split`, `quote_split` and `agent_claim_self` are not registered by the current production MCP server.

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

Paid AIFP-1 execution is available only through the reviewed Node `fetchPaid` path and remains gated by runtime checks including the reviewed Polygon v1.3 deployment/profile and a fresh trusted native/USD price.

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

The Python package does not currently expose the Node `fetchPaid` executor. Legacy paid `call()` settlement is disabled; do not present Python as a one-line production paid-settlement path.

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
