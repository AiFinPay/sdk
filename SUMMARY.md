# AiFinPay SDK — SUMMARY

Актуальний стан публічних SDK/MCP поверхонь у репозиторії.

## 1. Що це

AiFinPay — інфраструктура платежів і монетизації для автономних AI-агентів.

- Agent side: identity, wallet discovery, history, quotas, route/deployment discovery, settlement preparation.
- Merchant side: HTTP 402 paywall та монетизація AI-трафіку.
- Non-custodial: приватні ключі залишаються у власника/агента.

## 2. Поточні версії в source

| Пакет | Версія |
|---|---:|
| `aifinpay-agent` | `2.3.0` |
| `aifinpay-gate` | `0.1.0` |
| `@aifinpay/agent` | `2.3.0` |
| `@aifinpay/mcp` | `2.4.1` |
| `@aifinpay/mcp-http` | `2.0.4` |
| `@aifinpay/skill` | `2.5.1` (source: github.com/AiFinPay/skill; MCP bundle-ить `^2.5.1`) |
| `@aifinpay/gate` | `0.3.4` |
| `@aifinpay/wallet` | `1.1.0` |
| `@aifinpay/deployments` | `1.1.3` |

Пакети versioned independently. Для точного latest треба дивитися package manifests + npm/PyPI.

## 3. Поточна MCP surface

`@aifinpay/mcp` у `main` реєструє:

| Tool | Призначення |
|---|---|
| `agent_address` | Публічні EVM / Solana / Casper адреси |
| `agent_reload` | Reload локальної persistent wallet identity |
| `agent_claim_self` | Прив'язка агента до dashboard власника; підписує лише AiFinPay claim challenge для власної адреси |
| `payable_fetch` | Лише коли власник вмикає платежі: купівля AIFP-1 batch на Polygon v1.4 у межах лімітів власника |
| `agent_quota` | Квота агента |
| `agent_history` | Indexed settlement / receipt history |
| `agent_passport_resolve` | Resolve Agent Passport і verified wallet bindings |
| `settlement_routes` | Runtime-verified AIFP-1 / AIFP-2 routes |
| `settlement_invoice` | Non-signing EVM settlement invoice |
| `settlement_solana` | Non-signing Solana settlement invoice |
| `settlement_casper` | Non-signing Casper settlement invoice |
| `deployment_info` | Deployment addresses / program IDs / settlement status |

`dev_payment_quote` додається тільки при `AIFINPAY_MODE=dev`.

Legacy tools `agent_call`, `agent_quote`, `pay_with_split`, `quote_split` не реєструються.

Без payment-конфігурації власника MCP **не підписує і не broadcast'ить платежі**. `payable_fetch` реєструється (і підписує локально) лише з `AIFINPAY_PAYMENTS_ENABLED=1` разом з `AIFINPAY_MAX_USD`, `AIFINPAY_DAILY_USD`, `AIFINPAY_GATEWAY_ORIGINS` і `AIFINPAY_MAX_GAS_POL`. Invoice/quote ≠ completed payment.

## 4. SDK execution status

### Node / TypeScript

`@aifinpay/agent` містить AIFP-1 `fetchPaid` path на v1.4: Polygon за замовчуванням, Base — через `v14.chain: "base"`, native asset або pinned stablecoin.

Перед підписом перевіряються pinned deployment, runtime, signer, profile, token і RPC chain; native-платежі потребують fresh independent `nativeUsdPrice`. Legacy Polygon v1.3 route і далі потребує окремого reviewed settlement pin.

Не можна робити production claim тільки на основі contract address, runtime hash, quote або invoice.

### Python

Python package платить AIFP-1 merchants через `AiFinPayAgent.fetch_paid` (Polygon v1.4 за замовчуванням, POL або pinned stablecoin; Base — через `chain="base"` з явним `max_gas_wei`).

Legacy paid `call()` settlement disabled.

## 5. Economics

Актуальна v2 модель:

- AIFP-1: payer = quoted gross; merchant **99%**; AiFinPay **1%**; creator/referral **0%**.
- AIFP-2 / x402: provider **100%**; AiFinPay protocol fee **0%**.

Стара модель 98.99% / 1% / 0.01% — retired і не повинна подаватися як current.

## 6. Solana

Старий program:

`5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2`

закритий і не є current deployment.

Current registry:

| Network | Program ID | Status |
|---|---|---|
| Devnet | `8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y` | settlement disabled |
| Mainnet | `724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD` | settlement disabled |

Причини:
- devnet: backend receipt verification not implemented;
- mainnet: receipt verification not implemented + upgrade authority not multisig.

Canonical source:
`deployments/registry/splitter/solana/deployments.json`

## 7. Historical Polygon evidence

Історичні транзакції — не proof current production readiness.

- Exa:
  `0xeb13c5eddf645b3e5b5e5db82d8b19d301a4c0c8593f6e7dce9cd4c3359c8700`
- io.net:
  `0x7c6ca0ffcf75b1ca3ade4800fb896c4bb08bc5f1a91916dc2cf4918f16129f0a`

## 8. Security rules

- Не друкувати і не логувати seed/private key/keystore JSON/signing secret.
- Не вставляти recovery material у chat, issue або shared config.
- Перед funding перевіряти public address.
- При payment recovery зберігати original quote, tx reference та idempotency context.
- Не робити повторну paid спробу навмання після partial failure.

## 9. Основні entry points

- Root docs: `README.md`
- Quick start: `QUICKSTART.md`
- MCP config: `MCP_CONFIG.md`
- Node SDK: `node/README.md`
- Python SDK: `python/README.md`
- MCP source: `mcp/src/server.ts`
- Deployment registry: `deployments/registry/`
- Agent skill: https://github.com/AiFinPay/skill (`agent/skills/aifinpay/SKILL.md`)
- Merchant skill: https://github.com/AiFinPay/skill (`agent/skills/aifinpay-merchant/SKILL.md`)
