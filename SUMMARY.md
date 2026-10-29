# AiFinPay SDK — навігація

AiFinPay — інфраструктура платежів і монетизації для автономних AI-агентів.
Цей файл посилається на джерела, а не дублює версії, адреси, хеші чи статуси.

| Питання | Джерело |
|---|---|
| Встановлення та API | [README](README.md), [QUICKSTART](QUICKSTART.md) |
| Версії source | `package.json` відповідного пакета, [Python manifest](python/pyproject.toml) |
| Встановлені залежності | Lockfile відповідного пакета |
| Опубліковані релізи | npm / PyPI; manifest не доводить публікацію |
| MCP tools та payment gates | [server.ts](mcp/src/server.ts), [config.ts](mcp/src/config.ts), [налаштування](mcp/README.md) |
| Node payment API | [інструкції та recovery](node/PAYMENT_RECEIPTS.md) |
| Python payment API | [Python README](python/README.md) |
| Мережі й активи | [Node descriptors](node/src/paymentChains.ts), [Python descriptors](python/aifinpay/payment_chains.py) |
| Deployment pins і provenance | [реєстр](deployments/registry/splitter/INDEX.md) |
| Архітектура | [ARCHITECTURE](ARCHITECTURE.md), [ADR](docs/adr/) |
| Перевірки та їх результати | Тести відповідного пакета, workflow та артефакти конкретного CI run |
| Merchant integration | [Node gate](gate/README.md), [Python gate](python-gate/README.md) |

Доступність платежів потребує узгоджених registry flags, backend capabilities,
авторизації merchant, signed quote та runtime-перевірок executor. Адреса гаманця,
запис у реєстрі або offline test окремо не доводять production readiness.
Факт платежу підтверджують original transaction, settlement event та verified receipt
у вибраній мережі, а не історичний хеш у документації.

Не публікуйте seed, private key, keystore або bearer receipt. При recovery
зберігайте original quote, transaction reference та idempotency context приватно;
невідомий результат не дозволяє повторний платіж.

Канонічні skills: [AiFinPay/skill](https://github.com/AiFinPay/skill).
