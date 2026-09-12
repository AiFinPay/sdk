# Доступні мережі та константи AiFinPay SDK

## 1. Settlement мережі (B2BSplitter native-token path)

Ось **точний реєстр** з `node/src/unifiedAgent.ts` (`SPLITTER_DEPLOYMENTS`):

| Chain | chainId | Версія splitter | Splitter address | Native token | USDC address | Default RPC | Explorer | Env для USD ціни |
|---|---|---|---|---|---|---|---|---|
| **polygon** | 137 | 1.2 | `0xbD1fa5453f212F096c0213788a645eC597FB4DDe` | POL | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | `https://polygon.drpc.org` | `https://polygonscan.com` | `AIFINPAY_MATIC_USD` |
| **base** | 8453 | 1.1 | `0x8Ad9830D16b1f10333866a3f38C949CbB19f4BAD` | ETH | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | `https://mainnet.base.org` | `https://basescan.org` | `AIFINPAY_ETH_USD` |
| **optimism** | 10 | 1.2 | `0xF03B3387415D557b6ab709D06E8aF0b4ABD6Eb74` | ETH | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | `https://mainnet.optimism.io` | `https://optimistic.etherscan.io` | `AIFINPAY_ETH_USD` |
| **unichain** | 130 | 1.1 | `0xeE92807decAa3A02F1e165dd7Efcd92ab9aA83CB` | ETH | `0x078D782b760474a361dDA0AF3839290b0EF57AD6` | `https://mainnet.unichain.org` | `https://uniscan.xyz` | `AIFINPAY_ETH_USD` |
| **botchain** | 677 | 1.2 | `0x147d8fF8c027E24303b5B99CbC8843e1D3dF94cC` | BOT | — (немає) | `https://rpc.botchain.ai` | `https://scan.botchain.ai` | `AIFINPAY_BOT_USD` |
| **xrplevm** | 1440000 | 1.2 | `0x147d8fF8c027E24303b5B99CbC8843e1D3dF94cC` | XRP | — (немає) | `https://rpc.xrplevm.org` | `https://explorer.xrplevm.org` | `AIFINPAY_XRP_USD` |

**Примітки:**
- Polygon — єдина мережа, де Python SDK робить direct settlement (`_settle_polygon`); Node SDK підтримує всі 6 мереж direct.
- Base/Unichain ще працюють на старій версії splitter 1.1 (`payMatic`).
- Polygon/Optimism/BOT Chain/XRPL EVM вже на v1.2 (`payNative` з `bytes32 paymentId` replay guard).
- BOT Chain і XRPL EVM не мають verified USDC, тільки native token.

## 2. Cross-chain bridge мережі (LiFi)

Реєстр з `node/src/crossChain.ts` і `python/aifinpay/cross_chain.py` (`EVM_CHAINS`):

| Chain | chainId | Native USDC address | Bridged USDC.e |
|---|---|---|---|
| **ethereum** | 1 | `0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48` | — |
| **polygon** | 137 | `0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359` | `0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174` |
| **bsc** | 56 | `0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d` | — |
| **arbitrum** | 42161 | `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` | `0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8` |
| **optimism** | 10 | `0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85` | — |
| **base** | 8453 | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` | — |

LiFi API endpoint: `https://li.quest/v1`

## 3. Solana

| Константа | Значення |
|---|---|
| Solana network | mainnet-beta |
| Default RPC | `https://api.mainnet-beta.solana.com` |
| Anchor program ID | `5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2` |
| USDC SPL mint (Circle native) | `EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v` |
| Instruction discriminator (`b2b_pay_with_split`) | `sha256(b"global:b2b_pay_with_split").digest()[:8]` |

## 4. Legacy Polygon контракти (README/Marketing)

| Контракт | Адреса |
|---|---|
| `AiFinPayCore` | `0x24Bee0dfCD4d2f481E2f49A339F1C105a1611C7b` |
| `AgentPassport` | `0xB385Cc32fe39CF5B5778DF0Df0e8E9978b5F662a` |
| `MSECCOToken` | `0x1Fe2021336596655Fac72bC7bC40F7FFFA501d55` |
| `AiFinPaySplitter` (old v1.1 marketing address) | `0xE34Fc0E6694821c600Fa0955C0F74720ea6d8440` |
| Gnosis Safe (multisig owner) | `0xD31d82c4b35DABaA2ad7023C89A78A052D1f3c8e` |

> Увага: актуальний Polygon splitter для direct settlement у `SPLITTER_DEPLOYMENTS` — `0xbD1fa5453f212F096c0213788a645eC597FB4DDe`, не `0xE34F…8440`. Стару адресу залишено у маркетингових документах.

## 5. Standard x402 facilitator — підтримувані мережі

Реєстр `CHAIN_IDS` з `node/src/facilitators/standard-x402.ts`:

| Network | chainId |
|---|---|
| base | 8453 |
| base-sepolia | 84532 |
| ethereum / mainnet | 1 |
| polygon | 137 |
| polygon-amoy | 80002 |
| arbitrum | 42161 |
| optimism | 10 |
| avalanche | 43114 |
| bsc | 56 |

## 6. RPC defaults та URL-константи

| Константа | Значення |
|---|---|
| Node default base URL | `https://aifinpay.io` |
| Python default base URL | `https://aifinpay.io` |
| Python API base URL | `https://api.aifinpay.io` |
| Node default timeout | 30 000 ms |
| Python default timeout | 30 s |
| Registry paths | `/api/providers`, `/providers` |
| Gateway (AIFP-1) | `gateway.aifinpay.io` |
| Node default Polygon RPC | `https://polygon.drpc.org` |
| Python default Polygon RPC | `https://polygon.drpc.org` |
| Node default Solana RPC | `https://api.mainnet-beta.solana.com` |
| Python default Solana RPC | `https://api.mainnet-beta.solana.com` |

## 7. Environment variables

| Змінна | Призначення |
|---|---|
| `AIFINPAY_AGENT_SECRET` | base58 Solana secret для MCP |
| `AIFINPAY_MAX_USD` | hard cap на одну оплату |
| `AIFINPAY_BASE_URL` | кастомний backend URL |
| `AIFINPAY_TIMEOUT_MS` | timeout MCP |
| `AIFINPAY_REGISTRY_URL` | pinned provider registry URL |
| `AIFINPAY_POLYGON_RPC` | override Polygon RPC |
| `AIFINPAY_SOLANA_RPC` | override Solana RPC |
| `AIFINPAY_MATIC_USD` | POL/USD price для guard |
| `AIFINPAY_ETH_USD` | ETH/USD price для guard |
| `AIFINPAY_BOT_USD` | BOT/USD price для guard |
| `AIFINPAY_XRP_USD` | XRP/USD price для guard |
| `AIFINPAY_SOL_USD` | SOL/USD price для guard (default ~$200) |
| `AIFINPAY_ALLOW_PRIVATE_FETCH` | зняти SSRF guard у MCP (`1`) |
| `AIFINPAY_AUTH_REQUIRED` | увімкнути OAuth для MCP HTTP |
| `AIFINPAY_OAUTH_ISSUER` | OAuth issuer URL |
| `AIFINPAY_OAUTH_SCOPES` | OAuth scopes |

## 8. Key derivation constants

| Шлях | Алгоритм |
|---|---|
| EVM | `SHA256("aifinpay:evm:v1\0" \|\| seed)` |
| Casper | `SHA256("aifinpay:casper:v1\0" \|\| seed)` → Ed25519 → `blake2b256("ed25519" \|\| 0x00 \|\| pubkey)` |
| Solana | `nacl.sign.keyPair.fromSeed(seed)` |

## 9. B2BSplitter split percentages

- Merchant: **98.99%**
- Treasury: **1.00%**
- ipCreator: **0.01%** (fallback — treasury, якщо не задано)

## 10. Підсумок по мережах

**Direct native-token settlement (B2BSplitter):**
- Polygon, Base, Optimism, Unichain, BOT Chain, XRPL EVM

**Standard x402 EIP-3009:**
- Base, Base-Sepolia, Ethereum, Polygon, Polygon-Amoy, Arbitrum, Optimism, Avalanche, BSC

**Cross-chain bridging (LiFi):**
- Ethereum, Polygon, BSC, Arbitrum, Optimism, Base

**Solana settlement:**
- Solana mainnet-beta (Anchor program)

**Identity-only (no signing):**
- Casper