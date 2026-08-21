// ──────────────────────────────────────────────────────────────────────────
// @aifinpay/gate — put your own API behind AIFP-1, in your own process.
//
//   const merchant = new AifpMerchant();                       // env: AIFP_MERCHANT_ID / _SECRET
//   await merchant.ensureResources([{ route_pattern: "/api/search", type: "api", tier: "complex" }]);
//   const registry = new ResourceRegistry({ merchant }); registry.start();
//   app.use(aifpGate({ merchantId: merchant.merchantId, registry, store: redisStore(redis) }));
//
// Line 2 also makes the endpoint appear in the AiFinPay dashboard — the SDK
// and the panel write the same registry, so there is nothing to sync.
//
// This package moves no money and holds no keys. It verifies a signed receipt
// locally and counts prepaid billing units down; settlement happens on-chain
// between the agent and the merchant's own wallet.
// ──────────────────────────────────────────────────────────────────────────

export { createGate, refundUnits } from "./core.js";
export type { GateOptions } from "./core.js";
export {
  DETAIL_QUOTA_EXHAUSTED,
  DETAIL_RECEIPT_EXPIRED,
  DETAIL_VERIFY_FAILED,
  HEADER_QUOTA_REMAINING,
} from "./core.js";

export { aifpGate } from "./express.js";

export { MemoryStore } from "./stores/memory.js";
export { redisStore, primeRedisStore, REDIS_INCRBY_SCRIPT } from "./stores/redis.js";
export type { GateStore } from "./stores/types.js";
export type { MemoryStoreOptions } from "./stores/memory.js";
export type { RedisLike, RedisStoreOptions } from "./stores/redis.js";

export { AifpMerchant } from "./management.js";
export type { AifpMerchantOptions } from "./management.js";
export { ResourceRegistry } from "./registry.js";
export type { ResourceRegistryOptions } from "./registry.js";

export { knownAiAgent, AI_AGENT_UA_MARKERS } from "./agents.js";
export { scopeCovers } from "./scope.js";
export { matchResource } from "./match.js";
export { buildChallenge } from "./challenge.js";
export { createVerifier } from "./verify.js";
export type { VerifyResult, VerifierOptions } from "./verify.js";

export {
  TIER_WEIGHTS,
  UNIT_PRICE_USD,
  BASE_UNIT_PRICE_USD,
  PROTOCOL_FEE_BPS,
  weightForTier,
  minRequestsForTier,
  unitPriceUsd,
} from "./pricing.js";

export {
  AifpGateError,
  AifpAuthError,
  AifpConflictError,
  AifpValidationError,
  AifpMeterError,
  StoreCapacityError,
} from "./errors.js";

export type {
  AifpContext,
  AifpReceiptClaims,
  AifpResource,
  GateErrorBody,
  GateEvent,
  GateEventKind,
  GateRequest,
  GateResult,
  MerchantPublicView,
  MerchantStats,
  ResourceInput,
  ResourceType,
  Scope,
  SettlementRecord,
  Tier,
} from "./types.js";
