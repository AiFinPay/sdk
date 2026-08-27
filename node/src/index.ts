/**
 * AiFinPay agent SDK — Unified Agent Economy layer for AI agents.
 *
 * Production-RC note: new value movement must use the canonical v1.3
 * SettlementClient / executeSettlementInvoice flow. Production signing
 * additionally requires an independently trusted deployment pin; a
 * backend-provided address/hash alone is never sufficient authority.
 */

// ── AIFP-3 global Agent Passport ─────────────────────────────────────────
export {
  AgentPassportError,
  normalizeAgentPassportIdentifier,
  resolveAgentPassport,
  agentPassportWallet,
} from "./agentPassport.js";
export type {
  AgentPassportNetwork,
  AgentPassportChainFamily,
  AgentPassportWalletBinding,
  AgentPassportIdentity,
} from "./agentPassport.js";

// ── Canonical route-specific v1.3 settlement ─────────────────────────────
export {
  SettlementClient,
  SettlementProtocolError,
  validateSettlementInvoice,
  validateTrustedSettlementRoutePin,
  verifySettlementRouteOnChain,
  executeSettlementInvoice,
  SETTLEMENT_CHAIN_IDS,
  SETTLEMENT_EXPECTED_BPS,
} from "./settlement.js";
export type {
  SettlementRouteClass,
  SettlementEvmNetwork,
  SettlementRoute,
  TrustedSettlementRoutePin,
  TrustedSettlementRouteRegistry,
  SettlementInvoiceInput,
  SettlementInvoice,
  NativeSettlementInvoice,
  StableSettlementInvoice,
  SettlementExecution,
} from "./settlement.js";

// ── Unified surface (Phase 1+ / legacy callers remain source-compatible) ──
export {
  SPLITTER_ROUTES,
  resolveSplitterRoute,
  resolveSettlingSplitterRoute,
  UnknownSplitterRouteError,
  SplitterRouteNotSettlingError,
} from "./splitterRoutes.js";
export type {
  SplitterRoute,
  SplitterRouteChain,
  SplitterRouteKey,
  SplitterRouteDeployment,
} from "./splitterRoutes.js";
export { botchain, xrplevm } from "./chains.js";

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

// ── Legacy chain-aware public API (back-compat only) ─────────────────────
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
