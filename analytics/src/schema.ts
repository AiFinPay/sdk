/**
 * Schema v1 event catalog. The telemetry gateway refuses any other name with
 * `400 unknown_event`, so the SDK drops unknown names locally instead of
 * sending a batch that would be rejected whole. Adding a name is additive and
 * needs the gateway's list updated in the same release; renaming or removing
 * one is a breaking change (ADR 0001, 90-day freeze window).
 */
const expand = (prefix: string, suffixes: string[]): string[] => suffixes.map((s) => `${prefix}_${s}`);

export const EVENT_NAMES: ReadonlySet<string> = new Set([
  // Install / first run
  "agent_sdk_install_completed",
  "agent_sdk_first_invocation",
  // Identity / Agent Passport
  ...expand("passport_resolve", ["started", "succeeded", "failed"]),
  ...expand("passport_issue", ["started", "succeeded", "failed"]),
  ...expand("passport_wallet_binding", ["challenge_requested", "confirmed", "failed"]),
  ...expand("passport_issuer_signature", ["verified", "invalid"]),
  // Settlement
  ...expand("settlement", [
    "invoice_validated",
    "route_pin_validated",
    "route_verified_onchain",
    "execute_started",
    "execute_dispatched",
    "execute_confirmed",
    "execute_failed",
  ]),
  ...expand("v14_call", ["validated", "submittable", "rejected"]),
  // Unified surface
  ...expand("unified", [
    "agent_constructed",
    "session_started",
    "session_expired",
    "quote_requested",
    "quote_returned",
    "call_started",
    "call_succeeded",
    "call_failed",
  ]),
  "budget_cap_exceeded",
  // AIFP-1 merchant paywall
  ...expand("aifp1", [
    "challenge_received",
    "quote_obtained",
    "payment_authorized",
    "pay_succeeded",
    "pay_failed",
    "receipt_cached_hit",
    "receipt_cached_miss",
    "recovery_attempted",
    "recovery_succeeded",
    "recovery_failed",
  ]),
  // Cross-chain bridge
  ...expand("bridge", [
    "quote_requested",
    "quote_returned",
    "execute_started",
    "execute_dispatched",
    "execute_arrived",
    "execute_failed",
  ]),
  // Splitter / deployment resolution
  ...expand("splitter_route", ["resolved", "not_found", "not_settling"]),
  ...expand("deployment", ["resolved", "fallback", "disabled", "version_unavailable"]),
  "no_deployment",
  "dev_network_used",
  // Wallet
  ...expand("wallet", ["derived_standard", "derived_legacy_solana", "load_succeeded", "load_failed", "decrypt_failed"]),
  "external_wallet_attached",
  // Spend ledger
  ...expand("spend_ledger", ["initialized", "appended", "overflow_blocked"]),
  // History / quota
  "agent_history_fetched",
  ...expand("quota_check", ["within", "exceeded"]),
  // Legacy facilitators
  ...expand("facilitator", ["detected", "unsupported"]),
  ...expand("x402", ["challenge_seen", "settled", "failed"]),
  // Errors and recovery
  "runtime_verify_failed",
  "payment_too_expensive",
  "funding_timeout",
  "seat_not_found",
  "safe_error_shaped",
]);

export function isKnownEvent(name: unknown): name is string {
  return typeof name === "string" && EVENT_NAMES.has(name);
}
