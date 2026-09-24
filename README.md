# AiFinPay — financial rails for AI agents

AiFinPay provides payment and monetization infrastructure for autonomous AI agents.

- **Agent side:** identity, wallet discovery, payment history, route discovery, quotas and settlement preparation.
- **Merchant side:** HTTP 402 paywalls and per-request monetization for AI traffic.
- **Non-custodial design:** private keys remain with the agent/operator. Public MCP tools do not expose seeds or private keys.

Canonical domain: **https://aifinpay.io**

## Current package versions

| Package | Current source version | Install |
|---|---:|---|
| `aifinpay-agent` (Python) | `2.2.1` | `pip install aifinpay-agent` |
| `aifinpay-gate` (Python merchant gate) | `0.1.0` | `pip install aifinpay-gate` |
| `@aifinpay/agent` (Node / TypeScript) | `2.2.0` | `npm install @aifinpay/agent` |
| `@aifinpay/mcp` | `2.3.0` | `npx @aifinpay/mcp` |
| `@aifinpay/mcp-http` | `2.0.4` | Streamable HTTP wrapper |
| `@aifinpay/skill` | `2.3.0` | `npm install @aifinpay/skill` |
| `@aifinpay/gate` | `0.3.4` | `npm install @aifinpay/gate` |
| `@aifinpay/wallet` | `1.1.0` | `npm install @aifinpay/wallet` |
| `@aifinpay/deployments` | `1.1.2` | deployment registry package |

Package lines are versioned independently. The package manifests in this repository and the corresponding npm/PyPI registries are the source of truth.

## Install

```bash
# MCP
npx @aifinpay/mcp

# Node / TypeScript SDK
npm install @aifinpay/agent

# Python SDK
pip install aifinpay-agent

# Merchant paywall
npm install @aifinpay/gate

# Agent skills
npm install @aifinpay/skill
```

## MCP: current production surface

The current `@aifinpay/mcp` source exposes the following production tools:

| Tool | Purpose |
|---|---|
| `agent_address` | Read the current EVM, Solana and Casper public addresses. |
| `agent_reload` | Reload configured local wallet files without starting a new conversation. |
| `agent_quota` | Read the agent's quota. |
| `agent_history` | Read indexed AiFinPay payment history or retained receipt history. |
| `agent_passport_resolve` | Resolve a public Agent Passport identity and verified wallet bindings. |
| `settlement_routes` | Read currently runtime-verified AIFP-1 / AIFP-2 settlement routes. |
| `settlement_invoice` | Build and validate a **non-signing** EVM settlement invoice. |
| `settlement_solana` | Build and validate a **non-signing** Solana settlement invoice. |
| `settlement_casper` | Build and validate a **non-signing** Casper settlement invoice. |
| `deployment_info` | Read deployment addresses, program IDs and settlement status across supported ecosystems. |

With `AIFINPAY_MODE=dev`, an additional `dev_payment_quote` tool is available for dev-only quote inspection.

**The public MCP surface does not sign or broadcast payments.** Creating an invoice or quote is not a completed payment.

Legacy tools such as `payable_fetch`, `agent_call`, `agent_quote`, `pay_with_split`, `quote_split` and `agent_claim_self` are not registered by the current production MCP server.

### MCP client configuration

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

For a persistent local identity, initialize the keystore once:

```bash
npx @aifinpay/mcp init
```

Then use `agent_reload` and `agent_address` to verify the selected public wallet. Do not paste seeds or private keys into chat, issues, logs or shared configuration.

Full client setup: [MCP_CONFIG.md](./MCP_CONFIG.md)

## SDK payment status

The SDK surfaces have different execution status. Do not treat them as interchangeable.

### Node / TypeScript

`@aifinpay/agent` includes the reviewed AIFP-1 `fetchPaid` path. Paid execution is gated by runtime checks, including the reviewed Polygon v1.3 deployment/profile and a fresh trusted native/USD price. A quote, invoice or matching runtime hash alone is not proof that a route is production-enabled.

See [node/README.md](./node/README.md) and [node/PAYMENT_RECEIPTS.md](./node/PAYMENT_RECEIPTS.md).

### Python

The Python package pays AIFP-1 merchants with `AiFinPayAgent.fetch_paid` (2.2.0+; use 2.2.1 or later for USDC at current Polygon gas prices; Polygon v1.4, POL or USDC), at parity with Node `fetchPaid`. Its legacy paid `call()` settlement path stays disabled.

See [python/README.md](./python/README.md).

## Economics

Current protocol economics documented in the v2 line:

- **AIFP-1:** payer pays the quoted gross amount; merchant receives **99%**; AiFinPay receives **1%**; creator/referral receives **0%**.
- **AIFP-2 / x402:** provider receives **100%**; AiFinPay protocol fee is currently **0%**.

Older 98.99% / 1% / 0.01% examples belong to a retired fee model and must not be used as current economics.

## Merchant monetization

For a site or API that wants to monetize AI-agent traffic:

```bash
npm install @aifinpay/gate
```

The merchant package can return HTTP 402 challenges, expose discovery metadata and meter paid access. See [gate/README.md](./gate/README.md). Python servers (FastAPI, Starlette, Flask, Django) use `pip install aifinpay-gate`, the same gate as ASGI/WSGI middleware — see [python-gate/README.md](./python-gate/README.md) and the `aifinpay-merchant` skill in [skill/skills/aifinpay-merchant/SKILL.md](./skill/skills/aifinpay-merchant/SKILL.md).

## Deployment status

Deployment addresses and program IDs are registry data; they are not, by themselves, proof that settlement is enabled. Use `deployment_info` or the deployment registry and check `settlementEnabled` / `status` before presenting a network as active.

### Solana

The old Solana program `5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2` was closed and is not the current program.

The current registry contains the redeployed v1.4.1 programs below, both currently disabled for settlement:

| Network | Program ID | Settlement status | Reason |
|---|---|---|---|
| Devnet | `8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y` | Disabled | Backend receipt verification is not implemented. |
| Mainnet | `724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD` | Disabled | Backend receipt verification is not implemented and upgrade authority is not multisig. |

Canonical registry source: [deployments/registry/splitter/solana/deployments.json](./deployments/registry/splitter/solana/deployments.json)

## Historical mainnet evidence

These are **historical transactions only**. They do not certify the current release, fee model or current production readiness.

| Provider | Asset | Historical use | Transaction |
|---|---|---|---|
| Exa Search | POL | SDK call via Exa | [`0xeb13c5eddf645b3e5b5e5db82d8b19d301a4c0c8593f6e7dce9cd4c3359c8700`](https://polygonscan.com/tx/0xeb13c5eddf645b3e5b5e5db82d8b19d301a4c0c8593f6e7dce9cd4c3359c8700) |
| io.net | POL | Llama-3.3-70B inference, $0.025 | [`0x7c6ca0ffcf75b1ca3ade4800fb896c4bb08bc5f1a91916dc2cf4918f16129f0a`](https://polygonscan.com/tx/0x7c6ca0ffcf75b1ca3ade4800fb896c4bb08bc5f1a91916dc2cf4918f16129f0a) |

## Repository layout

```text
sdk/
├── node/          @aifinpay/agent
├── python/        aifinpay-agent
├── mcp/           @aifinpay/mcp
├── mcp-http/      Streamable HTTP wrapper
├── skill/         @aifinpay/skill
├── gate/          merchant HTTP 402 paywall
├── wallet/        lightweight agent wallet / keystore
├── deployments/   deployment registry
└── examples/      integrations and reference examples
```

## Security rules

- Never print, log or publish a seed, private key, keystore JSON or signing secret.
- Public addresses and transaction hashes are safe to display.
- Do not infer production readiness from a contract address, program ID, quote or invoice alone.
- Retain the original quote, transaction reference and idempotency context when recovering from a settlement error to avoid accidental duplicate payment attempts.

## Links

- Website: https://aifinpay.io
- Documentation: https://aifinpay.io/docs
- Quick start: [QUICKSTART.md](./QUICKSTART.md)
- MCP configuration: [MCP_CONFIG.md](./MCP_CONFIG.md)
- Issues: https://github.com/AiFinPay/sdk/issues
- MCP specification: https://modelcontextprotocol.io
- x402: https://www.x402.org

## License

MIT — see [LICENSE](./LICENSE).
