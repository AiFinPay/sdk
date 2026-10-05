# AiFinPay — payment infrastructure for AI agents

AiFinPay provides payment and monetization infrastructure for autonomous AI agents.

- **Agent side:** identity, wallet discovery, payment history, route discovery, quotas and settlement preparation.
- **Merchant side:** HTTP 402 paywalls and per-request monetization for AI traffic.
- **Non-custodial design:** private keys remain with the agent/operator. Public MCP tools do not expose seeds or private keys.

Canonical domain: **https://aifinpay.io**

## Current package versions

| Package | Current source version | Install |
|---|---:|---|
| `aifinpay-agent` (Python) | `2.4.0` candidate | `pip install aifinpay-agent` |
| `aifinpay-gate` (Python merchant gate) | `0.1.1` | `pip install aifinpay-gate` |
| `@aifinpay/agent` (Node / TypeScript) | `2.4.0` candidate | `npm install @aifinpay/agent` |
| `@aifinpay/mcp` | `2.6.0` release candidate | `npx @aifinpay/mcp` |
| `@aifinpay/mcp-http` | `2.0.4` | Streamable HTTP wrapper |
| `@aifinpay/skill` | `2.7.0` coordinated target; existing registry lock pending refresh ([AiFinPay/skill](https://github.com/AiFinPay/skill); bundled by `@aifinpay/mcp`) | `npm install @aifinpay/skill` |
| `@aifinpay/gate` | `0.3.5` | `npm install @aifinpay/gate` |
| `@aifinpay/wallet` | `1.2.0` | `npm install @aifinpay/wallet` |
| `@aifinpay/deployments` | `1.1.3` | deployment registry package |

These are local manifest versions. Install commands resolve separately published versions. The Node/Python2.4.0 and MCP2.6.0 changes in this checkout are release candidates. MCP release requires real agent2.4.0 and canonical skill2.7.0 publication, a registry dependency/lock refresh and standalone CI. The retained old lock is not publishable; no registry entry is fabricated. Same-commit source-cohort CI validates the candidate without pretending that the new Node exports are already published.

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

## MCP: current tool surface

The current `@aifinpay/mcp` source registers these tools:

| Tool | Purpose |
|---|---|
| `agent_address` | Read the current EVM, Solana and Casper public addresses. |
| `agent_reload` | Reload configured local wallet files without starting a new conversation. |
| `agent_claim_self` | Link the agent to its owner's dashboard with a one-time URL from dash.aifinpay.io. Signs only an AiFinPay claim challenge for the agent's own address; moves no funds. |
| `payable_fetch` | **Only when the owner enables payments.** Fetch a GET resource from an owner-approved AIFP-1 merchant, buying a prepaid batch on the explicitly configured EVM v1.4 chain within owner limits; Polygon remains the default. |
| `agent_quota` | Read the agent's quota. |
| `agent_history` | Read indexed AiFinPay payment history or retained receipt history. |
| `agent_passport_resolve` | Resolve a public Agent Passport identity and verified wallet bindings. |
| `settlement_routes` | Read currently runtime-verified AIFP-1 / AIFP-2 settlement routes. |
| `settlement_invoice` | Build and validate a **non-signing** EVM settlement invoice. |
| `settlement_solana` | Build and validate a **non-signing** Solana settlement invoice. |
| `settlement_casper` | Build and validate a **non-signing** Casper settlement invoice. |
| `deployment_info` | Read deployment addresses, program IDs and settlement status across supported ecosystems. |

With `AIFINPAY_MODE=dev`, an additional `dev_payment_quote` tool is available for dev-only quote inspection.

**Without owner payment configuration the MCP server is read-only:** it signs no payment, and creating an invoice or quote is not a completed payment. `payable_fetch` is registered — and signs and broadcasts locally — only when the owner sets `AIFINPAY_PAYMENTS_ENABLED=1` together with `AIFINPAY_MAX_USD`, `AIFINPAY_DAILY_USD`, `AIFINPAY_GATEWAY_ORIGINS` and a native gas cap (`AIFINPAY_MAX_GAS`; legacy `AIFINPAY_MAX_GAS_POL` is Polygon-only). Incomplete enabled configuration refuses startup. See [mcp/README.md](./mcp/README.md).

Legacy tools such as `agent_call`, `agent_quote`, `pay_with_split` and `quote_split` are not registered by the current MCP server.

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

For a persistent local identity, initialize the keystore once. `init` creates an encrypted keystore and refuses to create one without a passphrase unless you ask for a plaintext test wallet:

```bash
AIFINPAY_WALLET_PASSPHRASE='<a long passphrase>' npx @aifinpay/mcp init
# disposable test wallet only:
npx @aifinpay/mcp init --plaintext
```

Then use `agent_reload` and `agent_address` to verify the selected public wallet. Do not paste seeds or private keys into chat, issues, logs or shared configuration.

Full client setup: [MCP_CONFIG.md](./MCP_CONFIG.md)

## SDK payment status

The SDK surfaces have different execution status. Do not treat them as interchangeable.

### Node / TypeScript

`@aifinpay/agent` includes the AIFP-1 `fetchPaid` path. The 2.4.0 source candidate supports Polygon, Base, Optimism, Arbitrum, Avalanche, BNB, Unichain, XRPL EVM and Robinhood. Every non-Polygon rail requires explicit owner selection. Paid execution validates the selected chain, deployment/runtime/signer/profile, pinned token and RPC before signing; native payments require a fresh independent price. Durable bound reservations prevent unresolved payments from resetting the daily cap or buying the same access on another rail. Legacy Polygon v1.3 still requires its separately reviewed settlement pin. Source support does not activate a production route or publish a package.

See [node/README.md](./node/README.md) and [node/PAYMENT_RECEIPTS.md](./node/PAYMENT_RECEIPTS.md).

### Python

The Python 2.4.0 source candidate uses `AiFinPayAgent.fetch_paid` for the same nine EVM mainnets, pinned native/stable assets and exact six/eighteen-decimal token amounts. Every non-Polygon chain requires an explicit native gas budget in wei. Shared local-file reservations serialize concurrent processes, survive unknown broadcasts and reconcile recovered receipts once. Its legacy paid `call()` settlement path stays disabled. The MCP candidate consumes the Node source cohort with explicit owner chain/asset configuration and private durable recovery.

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

The merchant package can return HTTP 402 challenges, expose discovery metadata and meter paid access. See [gate/README.md](./gate/README.md). Python servers (FastAPI, Starlette, Flask, Django) use `pip install aifinpay-gate`, the same gate as ASGI/WSGI middleware — see [python-gate/README.md](./python-gate/README.md) and the `aifinpay-merchant` skill in the [AiFinPay/skill](https://github.com/AiFinPay/skill/blob/main/agent/skills/aifinpay-merchant/SKILL.md) repository.

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
├── skill/         pointer only — @aifinpay/skill moved to github.com/AiFinPay/skill
├── gate/          merchant HTTP 402 paywall (Node)
├── python-gate/   aifinpay-gate, merchant HTTP 402 paywall (Python)
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
