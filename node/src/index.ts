/**
 * AiFinPay agent SDK — Unified Agent Economy layer for AI agents.
 *
 * Recommended (Phase 1+): the chain-opaque AiFinPayAgent surface.
 *
 *   import { AiFinPayAgent } from "@aifinpay/agent";
 *
 *   const agent = await AiFinPayAgent.new();
 *   const res = await agent.call({ provider: "exa", body: { query: "..." } });
 *   const data = await res.json();
 *
 * Legacy (still supported, but @deprecated for new code): the chain-aware
 * Agent class with explicit Solana primitives.
 *
 *   import { Agent } from "@aifinpay/agent";
 *
 *   const agent = Agent.new();
 *   await agent.reserveSeatInvoice({ amountUsd: 1.0, asset: "USDC" });
 *   const res = await agent.pay("https://aifinpay.io/api/stats");
 */

// ── Unified surface (Phase 1+) ───────────────────────────────────────────
export { AiFinPayAgent, SPLITTER_DEPLOYMENTS, paymentIdFor } from "./unifiedAgent.js";
export {
  validateQuotedNativePayment,
  validateRuntimePaymentTarget,
} from "./paymentRegistry.js";
export type {
  QuotedNativePayment,
  TrustedPaymentTarget,
  ValidatedNativePayment,
} from "./paymentRegistry.js";
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

// ── Cross-chain orchestration (Phase 1.5a — EVM↔EVM via LiFi) ────────────
// Standalone primitives — also exposed as methods on AiFinPayAgent.
// Use the methods (agent.bridgeQuote / agent.bridgeExecute) unless you
// need to orchestrate from a wallet that isn't an AiFinPayAgent instance.
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

// ── Legacy chain-aware surface (kept for back-compat) ───────────────────
export { Agent } from "./agent.js";
export type { AgentOptions, Invoice, PayInit } from "./agent.js";
export {
  AiFinPayError,
  FacilitatorNotImplementedError,
  FundingTimeoutError,
  PaymentTooExpensiveError,
  SeatNotFoundError,
  UnsupportedFacilitatorError,
  UntrustedPaymentTargetError,
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
