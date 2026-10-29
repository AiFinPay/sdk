# QUICKSTART — install and verify AiFinPay

This guide reflects the current v2 package surfaces. It intentionally separates identity/control-plane functions from payment execution so a developer does not mistake a quote or invoice for a completed payment.

## Check package inputs

Read source versions from [Node](node/package.json), [MCP](mcp/package.json)
and [Python](python/pyproject.toml) manifests. Check the package registry for
published releases and your lockfile for the actual installed dependency.

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

Without owner payment configuration no MCP tool signs or broadcasts a payment, and the settlement invoice tools only prepare and validate non-signing instructions. `payable_fetch` signs locally only when the owner enables payments with exact origins, purchase/daily limits and the selected family's gas or fee/rent cap. Configuration does not activate a route; the SDK also checks deployment and quote bindings. See [mcp/README.md](./mcp/README.md) and [configuration validation](mcp/src/config.ts).

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

Python pays AIFP-1 merchants with `AiFinPayAgent.fetch_paid(url, allowed_origins=[...], max_amount_usd=..., daily_amount_usd=...)`: Polygon v1.4 by default, in POL or a pinned stablecoin (`asset="USDC"`), or Base with `chain="base"` and an explicit `max_gas_wei`. Use this paid-access API rather than legacy `call()` settlement; consult the package guide for other chain families.

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

## Verify availability and payment evidence

Use MCP `deployment_info` or the
[Solana registry](deployments/registry/splitter/solana/deployments.json) for
program IDs, settlement flags and recorded availability reasons. Follow the
[Solana payment configuration](node/PAYMENT_RECEIPTS.md); an environment setting
does not override deployment, backend or governance checks.

Verify a payment using its original transaction, settlement event and receipt
on the selected network. Historical examples do not certify the installed
release or current network readiness.

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
