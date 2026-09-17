# MCP Server Improvement Plan

## Proposed Improvements

### 1. Resources (данные, а не действия)
- `aifinpay://deployments` — EVM/Solana/Casper deployment data как resource (модели могут читать без вызова tools)
- `aifinpay://routes` — settlement routes table

### 2. Prompts (диалоговые шаблоны)
- `/pay` — пошаговый wizard для создания payment
- `/setup` — onboarding prompt для нового агента

### 3. Кеширование
- `deployment_info` — данные статичные, кешировать при старте (сейчас каждый вызов парсит)

### 4. Валидация входных данных
- Использовать Zod схемы вместо ручной проверки (MCP SDK поддерживает)

### 5. Health check tool
- `system_status` — версия SDK, connectivity, wallet balance summary

### 6. Logging
- Structured JSON logging для observability

## Priority (рекомендация)

| # | Направление | Приоритет | Обоснование |
|---|-------------|-----------|-------------|
| 4 | Zod валидация | High | Снижает runtime-ошибки, MCP SDK поддерживает из коробки |
| 3 | Кеш | High | Статические данные парсятся при каждом вызове — easy win |
| 6 | Logging | Medium | Фундамент для observability, делать до остальных фич |
| 1 | Resources | Medium | Models читают данные без tools, удобно для RAG |
| 5 | Health check | Low |nice-to-have для мониторинга |
| 2 | Prompts | Low | Wizard-ы, пока не критично |
