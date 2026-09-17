# BOT Chain Deprecation Notice

**Deprecation Date:** 2026-09-15  
**Status:** Deprecated (backward compatible)  
**Removal:** Next major version (TBD)

## Summary

BOT Chain (chainId: 677, symbol: BOT) is deprecated in favor of **Robinhood Chain** (chainId: 4663, symbol: ETH). This deprecation is non-breaking — all existing functionality remains available, but TypeScript will emit deprecation warnings to guide migration.

## Why This Change

The deprecation aligns the SDK with the canonical deployment registry, which has transitioned to Robinhood Chain as the preferred L2 network. BOT Chain deployments remain functional for backward compatibility but will not receive new features or deployment updates.

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

The following types and exports are marked as `@deprecated`:

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

| Phase | Status | Description |
|-------|--------|-------------|
| Deprecation | ✅ Complete (2026-09-15) | `@deprecated` annotations added, docs published |
| Warning Period | 🟡 Active | TypeScript emits deprecation warnings |
| Removal | ⚪ Pending | Will be removed in next major version (TBD) |

## Backward Compatibility

**All botchain functionality remains fully operational.** The deprecation is communicated via:

1. TypeScript `@deprecated` JSDoc annotations
2. This documentation
3. CHANGELOG.md entry

Existing code will continue to work without modification. Deprecation warnings can be suppressed in TypeScript using `// @ts-ignore` comments (not recommended) or by migrating to Robinhood Chain.

## Support

- BOT Chain (chainId: 677) deployments remain accessible
- Existing settlements and payment flows continue to work
- No breaking changes until the next major version
- Migration support available via standard channels

## Questions?

If you have questions about this deprecation or need assistance migrating to Robinhood Chain, please open an issue or contact the AiFinPay team.
