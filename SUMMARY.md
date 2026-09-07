Ось компактний **SUMMARY** по репозиторію AiFinPay SDK.

---

# AiFinPay SDK — SUMMARY

## 1. Що це
**AiFinPay** — платіжний рельс для автономних AI-агентів. SDK дозволяє агенту в один рядок (`agent.pay(url)` або `agent.call({provider})`) оплатити та отримати доступ до API, захищеного протоколом **x402** (HTTP 402 Payment Required). Non-custodial: приватний ключ агента ніколи не покидає процес.

## 2. Архітектура та протокол

### Протокольний потік
1. Агент робить запит до API.
2. Сервер повертає **402** з JSON-челенджем: chain, asset, payTo, amount, nonce.
3. SDK будує та підписує платіж:
    - **Solana** — Ed25519-підпис, інструкція `b2b_pay_with_split` на Anchor-програмі.
    - **EVM** — транзакція `B2BSplitter.payMatic` / `payNative` з нативним токеном (POL/ETH/BOT/XRP).
4. SDK повторює запит із proof-заголовками (`x-tx-hash`, `x-solana-tx`, `x-order-id`).
5. Сервер верифікує on-chain і повертає gated-відповідь.

### Спліт коштів (atomic)
Кожен платіж розподіляється через смарт-контракт:
- **98.99%** — гаманець мерчанта
- **1.00%** — treasury AiFinPay
- **0.01%** — ipCreator (або treasury)

### Facilitators
SDK авто-детектить смак x402:
- **AiFinPay native**
- **Coinbase x402**
- (future) generic schemes

## 3. Структура репозиторію

```
sdk/
├── python/                 # aifinpay-agent (PyPI), v1.4.0
│   ├── aifinpay/
│   │   ├── __init__.py
│   │   ├── client.py       # legacy Agent (Solana-only x402)
│   │   ├── unified_agent.py # AiFinPayAgent (dual-chain)
│   │   ├── cross_chain.py  # LiFi bridge primitives
│   │   ├── errors.py
│   │   └── facilitators/
│   ├── pyproject.toml
│   └── tests/
├── node/                   # @aifinpay/agent (npm), v1.8.1
│   ├── src/
│   │   ├── index.ts        # public exports
│   │   ├── unifiedAgent.ts # AiFinPayAgent (Phase 1+)
│   │   ├── agent.ts        # legacy chain-aware Agent
│   │   ├── aifp1.ts        # AIFP-1 merchant paywall client
│   │   ├── crossChain.ts   # EVM↔EVM LiFi orchestration
│   │   ├── crypto.ts
│   │   ├── errors.ts
│   │   ├── spendLedger.ts
│   │   └── facilitators/
│   ├── tests/
│   ├── package.json
│   └── tsconfig.json
├── mcp/                    # @aifinpay/mcp (npm), v1.5.1
│   ├── src/
│   │   ├── index.ts
│   │   ├── server.ts       # MCP server wrapper
│   │   ├── config.ts
│   │   ├── safe-fetch.ts   # SSRF guard
│   │   └── tools/          # 7 MCP tools
│   ├── bin/aifinpay-mcp.js
│   └── tests/
├── mcp-http/               # HTTP/Streamable transport wrapper (private)
│   └── server.js           # OAuth 2.1 + rate limit + catalog toolspec
├── examples/               # Framework bridges & partner examples
│   ├── _generic-x402-bridge/
│   ├── openai-agent/
│   ├── claude-mcp/
│   ├── langchain/
│   ├── crewai/
│   ├── flowise/
│   ├── autogpt/
│   ├── echo-x402-server/
│   ├── io-net-x402-bridge/
│   ├── exa-x402-bridge/
│   ├── venice-x402-bridge/
│   ├── gcore-x402-bridge/
│   └── new-wallet/
├── docs/                   # README.md, QUICKSTART.md, MCP_CONFIG.md, PARTNER_ONBOARDING.md
├── CHANGELOG.md
├── LICENSE (MIT)
└── scripts/                # helper scripts
```

## 4. Пакети та версії

| Пакет | Шлях | Версія | Опис |
|---|---|---|---|
| `aifinpay-agent` | `python/` | `1.4.0` | Python SDK |
| `@aifinpay/agent` | `node/` | `1.8.1` | Node/TypeScript SDK |
| `@aifinpay/mcp` | `mcp/` | `1.5.1` | MCP сервер |
| `@aifinpay/mcp-http` | `mcp-http/` | `1.0.0` (private) | HTTP transport для каталогів |

## 5. Key classes / API surfaces

### Python
- `Agent` — legacy Solana-only x402 клієнт.
- `AiFinPayAgent` — unified dual-chain: `from_seed()`, `call({provider})`, `balance()`, `bridge_quote()`, `bridge_execute()`.
- `NetworkAgent` — lazy import у `__init__.py`.

### Node/TypeScript
- `AiFinPayAgent` — рекомендований unified surface:
    - `new()`, `fromSeed()`, `fromSolanaSecret()`
    - `call({ provider, body })`
    - `openSession()`, `closeSession()`
    - `balance()`, `verify()`, `reputation()`
    - `bridgeQuote()`, `bridgeExecute()`, `bridgeWaitForArrival()`
    - `setBudget({ daily_usd, per_call_usd })`
- `Agent` — legacy chain-aware surface.
- `aifp1Fetch` — AIFP-1 merchant paywall client.
- `bridgeQuote/bridgeExecute/bridgeWaitForArrival` — LiFi cross-chain.

### MCP tools (7 штук)
| Tool | Призначення |
|---|---|
| `agent_address` | Показує EVM + Solana адреси для фандингу |
| `agent_call` | Registry-resolved paid call |
| `agent_quote` | Preview вартості 402 URL |
| `payable_fetch` | Raw URL paid fetch (legacy path) |
| `pay_with_split` | Прямий B2B split payment |
| `quote_split` | Fee breakdown |
| `agent_claim_self` | Self-claim інструмент |

## 6. Підтримувані мережі

### EVM chains (direct native-token settlement)
- Polygon (default, `payMatic` v1.1 / `payNative` v1.2)
- Base
- Optimism
- Unichain
- BOT Chain
- XRPL EVM

### Solana
- Mainnet-beta Anchor program: `5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2`

### Casper
- Identity derivation included, but SDK does **not** sign Casper deploys.

## 7. Контракти (Polygon mainnet)

| Контракт | Адреса |
|---|---|
| `AiFinPayCore` | `0x24Bee0dfCD4d2f481E2f49A339F1C105a1611C7b` |
| `AgentPassport` | `0xB385Cc32fe39CF5B5778DF0Df0e8E9978b5F662a` |
| `MSECCOToken` | `0x1Fe2021336596655Fac72bC7bC40F7FFFA501d55` |
| `AiFinPaySplitter` v1.1/v1.2 | `0xE34Fc0E6694821c600Fa0955C0F74720ea6d8440` |
| Gnosis Safe owner | `0xD31d82c4b35DABaA2ad7023C89A78A052D1f3c8e` |

## 8. Ключові технічні деталі

### Key derivation
- Один 32-байтовий seed → deterministic EVM, Solana **і** Casper адреси.
- EVM: `SHA256("aifinpay:evm:v1\0" || seed)`
- Casper: `SHA256("aifinpay:casper:v1\0" || seed)` → Ed25519 → account hash via blake2b256.

### Provider registry
- Registry endpoint: `https://aifinpay.io/api/providers` або `https://api.aifinpay.io/providers`.
- Fallback-логіка з валідацією JSON, щоб SPA catch-all не ламав парсинг.
- Провайдери (bridges) описують `preferred_chain`, `accepted_chains`, `merchant_wallet`, `price_usd`, `bridge_url`.

### SSRF захист (MCP)
- `safe-fetch.ts` блокує private-range IP, loopback, link-local, метадата-ендпоінти.
- Тільки `https` до публічних адрес; redirects перевіряються на кожному хопі.
- `AIFINPAY_ALLOW_PRIVATE_FETCH=1` знімає guard для локальних бриджів.

### AIFP-1 merchant paywall
- Gateway: `gateway.aifinpay.io`.
- Prepaid batch receipt (JWT) з `unit_quota`, а не per-call ticket.
- Кешування receipt'ів у `Aifp1ReceiptCache` для повторного використання.

### Cross-chain
- LiFi public API (`li.quest/v1`).
- EVM↔EVM USDC bridging.
- Solana↔EVM планується (Phase 1.5b).

## 9. Тестування
- Python: pytest у `python/tests/` — identity, cross-chain, facilitators, network, wallet recovery.
- Node: vitest у `node/tests/` — aifp1, bridge guards, cross-chain, facilitators, funding, network, spend ledger, splitter deployments/versions.
- MCP: vitest у `mcp/tests/` — safe-fetch SSRF, claim-self SSRF.

## 10. Інтеграції та приклади

| Framework | Шлях |
|---|---|
| OpenAI Agents SDK | `examples/openai-agent/` |
| LangChain | `examples/langchain/` |
| CrewAI | `examples/crewai/` |
| Flowise | `examples/flowise/` |
| AutoGPT/AutoGen | `examples/autogpt/` |
| Claude MCP | `examples/claude-mcp/` |

| Live bridges | Шлях |
|---|---|
| io.net | `examples/io-net-x402-bridge/` |
| Exa | `examples/exa-x402-bridge/` |
| Venice | `examples/venice-x402-bridge/` |
| GCore | `examples/gcore-x402-bridge/` |
| Generic template | `examples/_generic-x402-bridge/` |

## 11. Лайфстатус
- Live з 2026.
- MIT license.
- Canonical домен: **aifinpay.io** (`aifinpay.company` retired).
- Верифіковані mainnet платежі: Exa Search, io.net inference.