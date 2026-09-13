# AIFINP-223 / AIFINP-224 — отчёт по исправлениям

Дата: 13 сентября 2026
Статус: pull requests опубликованы; production settlement v1.4 остаётся выключенным

## Что сделано

### AIFINP-223 — EVM

- Импортированы v1.4 deployments из `AiFinPay/evm-contract@78240ec` и последующие безопасные исправления из `a54a4c107de7bb42f54e411e621d3897938bfc31`.
- Добавлен единый статический SDK registry для EVM и Solana:
  - `node/registry/payment-deployments.json`;
  - `node/registry/payment-deployments.schema.json`;
  - детерминированный генератор `node/scripts/generate-payment-deployments.mjs`;
  - CI drift-check через `registry:check`.
- `auto` больше не делает скрытый downgrade `v1.4 → v1.2`. Legacy v1.2 доступен только при явном `version: "v1.2"`.
- Добавлена типизированная ошибка `DeploymentDisabledError` для quarantined deployment.
- В SDK добавлены v1.4 records: Polygon, Arbitrum, Avalanche, BNB, Base, Optimism, Unichain, XRPL EVM и Robinhood. Все production records выключены.
- Botchain исключён из v1.4 registry и из production deploy-конфига по ADR-0001. Legacy v1.3 таблицы не менялись.
- Robinhood chain ID `4663` добавлен как метаданные. Settlement выключен.
- Схема активов заменена на универсальный массив `assets[]`; поля `usdc/usdt` сохранены на один compatibility-релиз.

### AIFINP-224 — Solana

- Обновлены program ID из `AiFinPay/solana-contract@e5df8f5436cf646ab495381eee04e0d1a10b4e2f`:
  - devnet: `8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y`;
  - mainnet: `724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD`.
- Обновлены ссылки на IDL snapshots от 11 сентября 2026.
- Добавлена типизированная ошибка `SolanaDeploymentDisabledError`.
- Оба Solana deployment сохранены как метаданные, но settlement выключен: backend пока не верифицирует Solana receipts.

### Исправления в evm-contract

- Base latest record помечен `invalid`: splitter и TokenList указывали на один адрес; Profiles и ожидаемый splitter не имеют runtime code.
- Polygon `0x2791…` исправлен с ошибочного `USDT` на `USDC.e`; legacy `usdt` обнулён.
- Robinhood latest record отражает фактический пустой TokenList. Deploy-скрипт теперь использует все configured assets (`USDe`, `USDG`), а не только USDC/USDT.
- Новый deployment всегда записывается `disabled` до независимой проверки.
- При повторном использовании TokenList/Profiles deploy-скрипт сверяет admin, allowlist и route economics до deploy splitter.
- On-chain checker теперь проверяет:
  - hash runtime-кода splitter;
  - ненулевые и разные адреса splitter/TokenList/Profiles;
  - запрет `address(0)` в TokenList;
  - универсальный список активов;
  - точный набор маршрутов;
  - `agent-x402 = 0/0 bps`;
  - `merchant-aifp1 = 100/0 bps`;
  - нулевой routeTreasury override.
- Read-only checker больше не требует private key. Проверка deployer role включается только через публичный `AIFINPAY_DEPLOYER_ADDRESS`.
- Robinhood добавлен в Safe checker.
- Сломанный CI, который ссылался на удалённый legacy `registry/registry.json`, заменён offline v1.4 artifact gate.

## Найденные ошибки и статус

| Проблема | Риск | Статус |
|---|---:|---|
| Base record указывал TokenList как splitter | P0 | Quarantine; нужен redeploy |
| Polygon USDC.e был подписан как USDT | P0 | Исправлено в config/SDK; on-chain allowlist требует решения Safe |
| Robinhood TokenList пустой из-за USDC/USDT-only deploy-кода | P0 | Код исправлен; сеть выключена; нужна Safe-транзакция |
| `auto` silently fallback на v1.2 | P0 | Исправлено: fail-closed |
| Старые Solana program ID в SDK | P0 | Исправлено |
| Botchain оставался доступен для v1.4 deploy | P1 | Заблокирован кодом |
| Checker не сверял runtime hash и точную экономику routes | P1 | Исправлено для splitter/routes |
| CI требовал удалённый и несовместимый legacy registry | P1 | Исправлено offline v1.4 gate |
| Solana backend verification отсутствует | P0 | Открыто; settlement выключен |
| Quote v1.4 не фиксирует fee-profile values; Profiles может измениться до settlement | P0 | Открыто; нужен новый contract/version design |
| Hash TokenList и Profiles не закреплён в deployment record | P1 | Открыто |
| Safe checker ещё не проверяет modules/guard/fallback handler/proxy singleton | P1 | Открыто |
| Solana upgrade authority остаётся у одиночных ключей deployer | P1 | Открыто; перенос в Squads/multisig |

## Результаты проверок

### SDK

- TypeScript build: PASS.
- Registry drift check: PASS.
- Целевые resolver/provenance тесты: **43/43 PASS**.
- Полный прогон: **356/357 PASS**. Один существующий network-path тест `funding.test.ts` превысил timeout 5 секунд.
- Изолированный повтор `funding.test.ts` с timeout 15 секунд: **8/8 PASS**.
- MCP TypeScript build после сборки SDK: PASS.

### EVM contract repo

- Offline deployment validator: **PASS, 10 records**.
- Новые production-config tests: **3/3 PASS**.
- Prettier check: PASS.
- GitHub Actions CI для опубликованного PR: **PASS**.
- `git diff --check`: PASS.
- Полная компиляция в текущем окружении заблокирована: Hardhat `HHE905` не смог скачать список версий компилятора. Запуск `--no-compile` подтвердил новые тесты, но полный contract suite без скомпилированных artifacts невалиден.

## Что нельзя включать до пилота

Production v1.4 нельзя активировать одним изменением флага. До включения каждой сети нужны:

1. Backend verifier для конкретных chain, route и asset.
2. Две независимые RPC-проверки runtime code, roles, Safe, TokenList и Profiles.
3. Проверка Safe modules, guard, fallback handler и singleton.
4. Один funded E2E для AIFP-1 и один для AIFP-2; затем replay/duplicate test.
5. Kill-switch и rollback test без перехода на v1.2.
6. Отдельный контрактный фикс fee-profile TOCTOU или письменное принятие риска CTO/security owner.

Отдельные on-chain действия:

- Base: новый deployment splitter + Profiles + корректный record.
- Robinhood: 3-of-4 Safe allowlist для USDe/USDG после проверки адресов.
- Polygon: решить, поддерживаем ли USDC.e; если нет — удалить из TokenList через Safe.
- Solana: перенести upgrade authority в Squads/multisig и подключить backend receipt verification.

## Коммиты и ветки

- `evm-contract`: PR [AiFinPay/evm-contract#33](https://github.com/AiFinPay/evm-contract/pull/33), branch `codex/aifinp-223-deployment-safety`, commits `a54a4c107de7bb42f54e411e621d3897938bfc31` и `726fb1d7b151b31f7ad9a2f95731496ef72463c2`.
- `sdk`: PR [AiFinPay/sdk#70](https://github.com/AiFinPay/sdk/pull/70), branch `codex/aifinp-223-224-payment-registry`.

Mainnet-транзакции, Safe-подписи и Jira-переходы не выполнялись.
