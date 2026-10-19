# AiFinPay — payment infrastructure for AI agents

AiFinPay provides payment and monetization infrastructure for autonomous AI agents.

- **Agent side:** identity, wallet discovery, payment history, route discovery, quotas and settlement preparation.
- **Merchant side:** HTTP 402 paywalls and per-request monetization for AI traffic.
- **Non-custodial design:** private keys remain with the agent/operator. Public MCP tools do not expose seeds or private keys.

Canonical domain: **https://aifinpay.io**

## Package versions and evidence

Source versions are defined in each package's `package.json` or `pyproject.toml`;
installed dependency versions and integrity hashes are in its lockfile. Check
npm/PyPI for published versions and CI artifacts for the exact source/pack inputs
that were exercised. Neither a source version nor this README proves publication
or production readiness.

## Solana paid access

The `fetchPaid` / `fetch_paid` Solana adapters provide conditional execution for
native SOL and classic SPL USDC/USDT. Owners select Solana and its cluster/mode
explicitly, supply a fee **plus rent** budget and keep the keys locally. The same
local wallet ledger covers EVM and Solana unresolved purchases. Quote, signed
transaction, receipt and public history bind the exact network/program; base58
addresses retain their case.

High-level payment checks the selected registry record before quote signing or
HTTP. Read availability and its recorded reason from the
[Solana registry](deployments/registry/splitter/solana/deployments.json);
do not infer them from this document. Source tests using synthetic records do
not activate a network or establish deployed-program/funded acceptance. See
[node payment instructions](node/PAYMENT_RECEIPTS.md),
[Python instructions](python/README.md), and
[Solana decision and acceptance](docs/adr/0004-solana-payment-flow.md).

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

| Tool                     | Purpose                                                                                                                                                                                                                     |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent_address`          | Read the current EVM, Solana and Casper public addresses.                                                                                                                                                                   |
| `agent_reload`           | Reload configured local wallet files without starting a new conversation.                                                                                                                                                   |
| `agent_claim_self`       | Link the agent to its owner's dashboard with a one-time URL from dash.aifinpay.io. Signs only an AiFinPay claim challenge for the agent's own address; moves no funds.                                                      |
| `payable_fetch`          | **Only when the owner enables payments.** Fetch a GET resource from an owner-approved AIFP-1 merchant, buying a prepaid batch on the explicitly configured EVM v1.4 chain within owner limits; Polygon remains the default. |
| `agent_quota`            | Read the agent's quota.                                                                                                                                                                                                     |
| `agent_history`          | Read indexed AiFinPay payment history or retained receipt history.                                                                                                                                                          |
| `agent_passport_resolve` | Resolve a public Agent Passport identity and verified wallet bindings.                                                                                                                                                      |
| `settlement_routes`      | Read currently runtime-verified AIFP-1 / AIFP-2 settlement routes.                                                                                                                                                          |
| `settlement_invoice`     | Build and validate a **non-signing** EVM settlement invoice.                                                                                                                                                                |
| `settlement_solana`      | Build and validate a **non-signing** Solana settlement invoice.                                                                                                                                                             |
| `settlement_casper`      | Build and validate a **non-signing** Casper settlement invoice.                                                                                                                                                             |
| `deployment_info`        | Read deployment addresses, program IDs and settlement status across supported ecosystems.                                                                                                                                   |

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

## SDK payment execution

The SDK surfaces have different configuration boundaries. Do not treat them as interchangeable.

### Node / TypeScript

`@aifinpay/agent` includes the AIFP-1 `fetchPaid` path. Read supported EVM descriptors from [paymentChains.ts](node/src/paymentChains.ts). Every non-Polygon rail requires explicit owner selection. Paid execution validates the selected chain, deployment/runtime/signer/profile, pinned token and RPC before signing; native payments require a fresh independent price. Durable bound reservations prevent unresolved payments from resetting the daily cap or buying the same access on another rail. Legacy Polygon v1.3 still requires its separately reviewed settlement pin. Source support does not activate a production route or publish a package.

See [node/README.md](./node/README.md) and [node/PAYMENT_RECEIPTS.md](./node/PAYMENT_RECEIPTS.md).

### Python

Python uses `AiFinPayAgent.fetch_paid` with the descriptors in [payment_chains.py](python/aifinpay/payment_chains.py), pinned native/stable assets and exact token amounts. Every non-Polygon EVM chain requires an explicit native gas budget in wei. Shared local-file reservations serialize concurrent processes, survive unknown broadcasts and reconcile recovered receipts once. Use the documented paid-access API, not legacy `call()` settlement. MCP consumes the Node SDK with explicit owner chain/asset configuration and private durable recovery.

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

## Deployment and payment evidence

Read addresses, program IDs, runtime hashes, provenance and settlement flags from
the [deployment registry](deployments/registry/splitter/INDEX.md), or inspect
the installed SDK's metadata through MCP `deployment_info`. Registry metadata
is necessary but does not replace fresh executor checks, backend
`/api/payment-capabilities`, merchant authorization and a matching signed quote.

For a payment claim, verify the original transaction on the selected network,
its settlement event and the verified receipt for that purchase. A copied
historical transaction hash or a passing offline test is not current readiness
evidence.

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
