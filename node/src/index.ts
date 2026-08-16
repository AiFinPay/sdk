/**
 * AiFinPay agent SDK — Unified Agent Economy layer for AI agents.
 *
 * Production-RC note: new value movement must use the canonical v1.3
 * SettlementClient / executeSettlementInvoice flow exported below. Legacy
 * B2BSplitter helpers remain only for source compatibility and fail closed
 * against the production backend unless explicitly re-enabled there.
 */

// ── Canonical route-specific v1.3 settlement ─────────────────────────────
export {
  SettlementClient,
  SettlementProtocolError,
  validateSettlementInvoice,
  verifySettlementRouteOnChain,
  executeSettlementInvoice,
  SETTLEMENT_CHAIN_IDS,
  SETTLEMENT_EXPECTED_BPS,
} from "./settlement.js";
export type {
  SettlementRouteClass,
  SettlementEvmNetwork,
  SettlementRoute,
  SettlementInvoiceInput,
  SettlementInvoice,
  NativeSettlementInvoice,
  StableSettlementInvoice,
  SettlementExecution,
} from "./settlement.js";

// ── Unified surface (Phase 1+) ───────────────────────────────────────────
export { AiFinPayAgent, SPLITTER_DEPLOYMENTS, paymentIdFor } from "./unifiedAgent.js";
export type {
  AiFinPayAgentOptions,
  CallOptions,
  ChainId,
  SplitterChainName,
  SplitterDeployment,
  AnyEvmChainName,
  ProviderEntry,
  BalanceSnapshot,
  ReputationSnapshot,
  BudgetCaps,
  SessionHandle,
  SessionReceipt,
  NetworkAgent,
} from "./unifiedAgent.js";
export {
  ProviderUnknownError,
  WrongChainBalanceError,
  InsufficientFundsError,
  BudgetCapExceededError,
  SettlementError,
  SessionExpiredError,
} from "./unifiedAgent.js";

// ── AIFP-1 merchant paywall (gateway.aifinpay.io) ────────────────────────
export {
  aifp1Fetch,
  Aifp1ReceiptCache,
  scopeCovers,
  prefixHint,
  parseGatewayUrl,
  idempotencyKeyFor,
} from "./aifp1.js";
export type {
  Aifp1Scope,
  Aifp1Challenge,
  Aifp1Quote,
  Aifp1PayResult,
  Aifp1CachedReceipt,
  Aifp1FetchOptions,
  Aifp1Deps,
} from "./aifp1.js";
export {
  Aifp1Error,
  Aifp1QuoteError,
  Aifp1PayError,
  Aifp1SettlementUnsupportedError,
  Aifp1ReceiptRejectedError,
} from "./aifp1.js";

// ── Cross-chain orchestration ─────────────────────────────────────────────
export {
  bridgeQuote,
  bridgeExecute,
  bridgeWaitForArrival,
  EVM_CHAINS,
  USDC_NATIVE,
  USDC_BRIDGED,
} from "./crossChain.js";
export type {
  BridgeQuote,
  BridgeReceipt,
  BridgeQuoteOptions,
  EvmChainName,
} from "./crossChain.js";

// ── Legacy chain-aware surface (back-compat; do not use for new settlement) ─
export { Agent } from "./agent.js";
export type { AgentOptions, Invoice, PayInit } from "./agent.js";
export {
  AiFinPayError,
  FacilitatorNotImplementedError,
  FundingTimeoutError,
  PaymentTooExpensiveError,
  SeatNotFoundError,
  UnsupportedFacilitatorError,
  X402Error,
} from "./errors.js";
export {
  AiFinPayFacilitator,
  CoinbaseX402Facilitator,
  REGISTERED,
  detectFacilitator,
} from "./facilitators/index.js";
export type {
  AuthPayload,
  Facilitator,
  FacilitatorClass,
  PayOptions,
} from "./facilitators/index.js";

export {
  type SpendLedger,
  MemorySpendLedger,
  FileSpendLedger,
} from "./spendLedger.js";

export { deriveWallet, newWallet } from "./wallet.js";
export type { DerivedWallet } from "./wallet.js";
