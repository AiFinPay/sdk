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
  generateAgentPassportHolderKeypair,
  signAgentPassportHolderMessage,
  issueAgentPassport,
  createAgentPassport,
  requestAgentPassportWalletBinding,
  confirmAgentPassportWalletBinding,
  verifyAgentPassportIssuerSignature,
  agentPassportWallet,
} from "./agentPassport.js";
export type {
  AgentPassportNetwork,
  AgentPassportChainFamily,
  AgentPassportStatus,
  AgentPassportWalletStatus,
  AgentPassportWalletBinding,
  AgentPassportIssuerProof,
  AgentPassportIdentity,
  AgentPassportHolderKeypair,
  AgentPassportWalletChallenge,
} from "./agentPassport.js";

// ── Canonical route-specific v1.3 settlement ─────────────────────────────
export {
  SettlementClient,
  SettlementProtocolError,
  SettlementConfirmationPendingError,
  validateSettlementInvoice,
  validateTrustedSettlementRoutePin,
  verifySettlementRouteOnChain,
  executeSettlementInvoice,
  SETTLEMENT_CHAIN_IDS,
  SETTLEMENT_EXPECTED_BPS,
} from "./settlement.js";
export * from "./settlementV14.js";
export type {
  SettlementRouteClass,
  SettlementClientOptions,
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
  SPLITTER_GOVERNANCE,
  SPLITTER_REGISTRY_SOURCE,
  resolveSplitterRoute,
  resolveSettlingSplitterRoute,
  UnknownSplitterRouteError,
  SplitterRouteNotSettlingError,
} from "./splitterRoutes.js";
export type { SplitterRoute, SplitterRouteChain, SplitterRouteKey, SplitterRouteDeployment } from "./splitterRoutes.js";
/** @deprecated botchain is deprecated. Use robinhood instead. */
export { botchain, robinhood, xrplevm } from "./chains.js";

// ── Environment & protocol-version resolver (AIFINP-223) ─────────────────
export {
  resolveDeployment,
  isV14Available,
  DeploymentResolverError,
  UnsupportedDevNetworkError,
  VersionUnavailableError,
  DeploymentDisabledError,
  NoDeploymentError,
} from "./deploymentResolver.js";
export type {
  SdkEnvironment,
  ProtocolVersion,
  RequestedVersion,
  ResolveDeploymentOptions,
  ResolvedDeployment,
} from "./deploymentResolver.js";
export { V14_DEPLOYMENTS, V14_DEPLOYMENTS_SOURCE, V14_DEV_NETWORKS } from "./generated/v14Deployments.generated.js";
export type { V14Deployment, V14Asset, V14Splitter, V14Safe } from "./generated/v14Deployments.generated.js";

// ── Solana environment & protocol-version resolver (AIFINP-224) ──────────
export {
  resolveSolanaDeployment,
  isSolanaV14Available,
  UnsupportedSolanaDevNetworkError,
  SolanaVersionUnavailableError,
  SolanaV12UnavailableError,
  SolanaDeploymentDisabledError,
  NoSolanaDeploymentError,
} from "./solanaDeploymentResolver.js";
export type {
  SolanaProtocolVersion,
  SolanaRequestedVersion,
  ResolveSolanaDeploymentOptions,
  ResolvedSolanaDeployment,
} from "./solanaDeploymentResolver.js";
export {
  SOLANA_V14_DEPLOYMENTS,
  SOLANA_V14_DEPLOYMENTS_SOURCE,
  SOLANA_DEV_NETWORKS,
} from "./generated/solanaV14Deployments.generated.js";
export type { SolanaV14Deployment, SolanaNetwork } from "./generated/solanaV14Deployments.generated.js";

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
  paymentAuthorizationMessage,
  recoverAifp1Payment,
  describeQuote,
} from "./aifp1.js";
export type {
  Aifp1PaymentRecovery,
  Aifp1PaymentSigner,
  Aifp1Scope,
  Aifp1Challenge,
  Aifp1Quote,
  Aifp1PayResult,
  Aifp1CachedReceipt,
  Aifp1FetchOptions,
  Aifp1Deps,
  QuoteSummary,
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
export type { BridgeQuote, BridgeReceipt, BridgeQuoteOptions, EvmChainName } from "./crossChain.js";

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
  toSafeError,
} from "./errors.js";
export type { SafeErrorShape } from "./errors.js";
/** @deprecated Legacy x402 facilitators — use AIFP-1/AIFP-2 settlement instead */
export { AiFinPayFacilitator, CoinbaseX402Facilitator, REGISTERED, detectFacilitator } from "./facilitators/index.js";
/** @deprecated Legacy x402 facilitators — use AIFP-1/AIFP-2 settlement instead */
export type { AuthPayload, Facilitator, FacilitatorClass, PayOptions } from "./facilitators/index.js";

export { type SpendLedger, MemorySpendLedger, FileSpendLedger } from "./spendLedger.js";

export { deriveWallet, newWallet } from "./wallet.js";
export { getAgentHistory, getQuota, AGENT_RECEIPT_FIELDS, AGENT_TRANSACTION_FIELDS } from "./agentHistory.js";
export type { AgentHistoryOptions, QuotaOptions, QuotaBatch, QuotaSummary } from "./agentHistory.js";
export type { DerivedWallet } from "./wallet.js";
