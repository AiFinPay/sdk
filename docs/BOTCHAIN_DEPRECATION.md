# BOT Chain Deprecation Notice

**Deprecation Date:** 2026-09-15  
**Scope:** Historical deprecation notice; not current compatibility or availability evidence.

Current supported chain names, exports and route approval must be checked in
[chain definitions](../node/src/chains.ts), [SDK exports](../node/src/index.ts),
[the registry](../deployments/registry/splitter/evm/v1.4/deployments.json) and
[CI](../.github/workflows/ci.yml). The examples below record the historical
migration intent, not a guarantee that old APIs or BOT settlement remain usable.

## Summary

The dated notice deprecated BOT Chain (chainId: 677, symbol: BOT) in favor of
**Robinhood Chain** (chainId: 4663, symbol: ETH). These are distinct networks;
historical BOT state must not be silently mapped to Robinhood.

## Why This Change

The deprecation aligned chain naming with the canonical deployment registry.
Deployment availability is determined by that registry and runtime verification,
not this notice.

## Migration Guide

### 1. Update Chain Imports

**Before:**
```typescript
import { botchain } from "@aifinpay/agent";
```

**After:**
```typescript
import { robinhood } from "@aifinpay/agent";
```

### 2. Update Type References

**Before:**
```typescript
const chain: "botchain" | "polygon" = "botchain";
```

**After:**
```typescript
const chain: "robinhood" | "polygon" = "robinhood";
```

### 3. Update Configuration

**Before:**
```env
AIFINPAY_CHAIN=botchain
```

**After:**
```env
AIFINPAY_CHAIN=robinhood
```

### 4. Update Settlement Code

**Before:**
```typescript
await agent.payWithSplitInvoice({
  chain: "botchain",
  merchantWallet: "...",
  merchantAmount: 1000000n,
  orderId: "order-123",
});
```

**After:**
```typescript
await agent.payWithSplitInvoice({
  chain: "robinhood",
  merchantWallet: "...",
  merchantAmount: 1000000n,
  orderId: "order-123",
});
```

## Affected APIs

The original review identified these types and exports for deprecation:

### Node SDK (`@aifinpay/agent`)

- `botchain` export from `src/chains.ts`
- `botchain` entry in `SPLITTER_DEPLOYMENTS`
- `SplitterChainName` type (union member)
- `SettlementEvmNetwork` type (union member)
- `AgentPassportNetwork` type (union member)
- `SplitterRouteChain` type (union member)
- Chain parameter in `Agent.quoteSplit()`
- Chain parameter in `Agent.payWithSplitInvoice()`

### MCP (`@aifinpay/mcp`)

- `botchain` in production control tool chain set

## Timeline

| Phase | Historical plan | Description |
|-------|--------|-------------|
| Deprecation | ✅ Complete (2026-09-15) | `@deprecated` annotations added, docs published |
| Warning Period | Planned at notice date | TypeScript deprecation warnings |
| Removal | Unscheduled in original notice | Consult current exports and changelogs |

## Backward Compatibility

The original compatibility plan used:

1. TypeScript `@deprecated` JSDoc annotations
2. This documentation
3. [Changelog entries](../node/CHANGELOG.md)

Do not suppress type errors or infer settlement support from this historical
plan. Validate explicit chain configuration, route approval and recovery bindings
against the current source before migration.

## Support

No deployment or payment-support status is asserted here. Consult current source,
registry approval, runtime verification and release evidence before attempting
settlement; historical recovery must retain its original chain binding.

## Questions?

If you have questions about this deprecation or need assistance migrating to Robinhood Chain, please open an issue or contact the AiFinPay team.
