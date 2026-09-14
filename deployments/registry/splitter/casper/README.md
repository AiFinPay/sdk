# Casper Splitter v1 — Contract Deployments

## Overview

Casper settlement contract (Rust → Wasm) for AI agent payments. Agents self-register on-chain identities, then `pay_agent` atomically records settlement and emits `PaymentSettled` events.

**Status:** Live on Casper testnet. Mainnet v1 is historical (payment recording only, no atomic transfer).

## Deployments

| Network | Contract Package Hash | Status | Notes |
|---------|----------------------|--------|-------|
| Casper Testnet | `hash-47df409829ddf0612617460293ba591a19b26fa0c06918878204088d3eb9b78a` | ✅ **live** | v2 — verified deployment |
| Casper Mainnet | `hash-7ad34a204952eef63d5dcf5159fb7d009e85dea4f49cbdf73dde190652dfa375` | ⚠️ **historical** | v1 — `pay_agent` recorded amount but did NOT transfer; separate transfer required |

## Contract Details

### Entry Points

| Entry Point | Args | Description |
|-------------|------|-------------|
| `register_agent` | `agent_id: String, wallet: String` | Self-register caller wallet → `AgentRegistered` event |
| `pay_agent` | `from_agent: String, to_agent: String, amount: U512, request_id: String` | Record settlement → `PaymentSettled` event (v2); v1 recorded only |
| `get_payment_count` | — | Total settled payments |

### Events

- `AgentRegistered` — `agent_id`, `wallet`
- `PaymentSettled` — `from`, `to`, `amount` (motes), `request_id`

## Live Testnet Deployment

**Contract Package Hash:**
```
hash-47df409829ddf0612617460293ba591a19b26fa0c06918878204088d3eb9b78a
```

**Explorer:** [cspr.live testnet](https://testnet.cspr.live/contract/47df409829ddf0612617460293ba591a19b26fa0c06918878204088d3eb9b78a)

**Network:** `casper-test` (Casper 2.0)

**Public RPC:** `https://node.testnet.casper.network/rpc`

### Sample Transactions (Testnet)

| Action | Deploy Hash | Explorer |
|--------|-------------|----------|
| Register agent (buyer) | `d4b7d0ad3b59a97a1165eab1dbc36dbee56ccf8a4bc48f3507071682427d23e0` | [view](https://testnet.cspr.live/deploy/d4b7d0ad3b59a97a1165eab1dbc36dbee56ccf8a4bc48f3507071682427d23e0) |
| Register agent (provider) | `6c41c8858f95af24afaf1267dcb8ced93c654f9a8bddfc722c6638825faac4e8` | [view](https://testnet.cspr.live/deploy/6c41c8858f95af24afaf1267dcb8ced93c654f9a8bddfc722c6638825faac4e8) |
| **PaymentSettled** (`pay_agent`) | `0b55b516058a3482beef0dac2d6997d84b402f82f71a97b3098e2aadaffb0137` | [view](https://testnet.cspr.live/deploy/0b55b516058a3482beef0dac2d6997d84b402f82f71a97b3098e2aadaffb0137) |

## Historical Mainnet Deployment (v1)

> ⚠️ **Warning:** The mainnet v1 deployment is **not valid settlement proof**. The `pay_agent` call recorded a receipt, but value was moved via a separate native transfer. Do not reproduce this flow.

**Contract Hash:** `contract-9903a5e3948e799196df54b17270bc6769338ac1cc36c9eb47e113f88d23f019`

**Package Hash:** `hash-7ad34a204952eef63d5dcf5159fb7d009e85dea4f49cbdf73dde190652dfa375`

**Explorer:** [cspr.live mainnet](https://cspr.live/contract/9903a5e3948e799196df54b17270bc6769338ac1cc36c9eb47e113f88d23f019)

## Key Differences from EVM/Solana

| Feature | EVM v1.4 | Solana v1.4 | Casper v1/v2 |
|---------|----------|-------------|--------------|
| Architecture | 7-contract suite | Single program | Single Wasm contract |
| Language | Solidity | Rust (Anchor) | Rust (Casper SDK) |
| Execution | EVM | SVM (Sealevel) | Casper Wasm |
| Identity | Contract addresses | Program-derived addresses | Account hashes |
| Settlement | Atomic transfer + receipt | Atomic transfer + receipt | v2: atomic; v1: receipt only |

## Source

Data sourced from upstream `AiFinPay/casper-contract` repository.

**Upstream repo:** https://github.com/AiFinPay/casper-contract

**Submission:** https://github.com/AiFinPay/casper-contract/blob/main/SUBMISSION.md

**Architecture docs:** https://github.com/AiFinPay/casper-contract/blob/main/docs/ARCHITECTURE.md

## Integration

Small, runnable examples live in [`examples/`](https://github.com/AiFinPay/casper-contract/tree/main/examples):

- `register-agent.js` — register an agent
- `pay-agent.js` — settle a payment
- `ai-agent-buys-compute.md` — x402 → Casper flow
- `merchant-integration.md` — gate an endpoint behind settlement
- `mcp-server.md` — drive settlements from Claude via MCP

## Reproduce Demo

```bash
git clone https://github.com/AiFinPay/casper-contract.git
cd casper-contract
make setup
make keygen
# Fund key at https://testnet.cspr.live/tools/faucet
make agent-demo
```
