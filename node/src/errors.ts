export class AiFinPayError extends Error {
  constructor(message: string) {
    super(message);
    this.name = this.constructor.name;
  }
}

export class X402Error extends AiFinPayError {}

export class FundingTimeoutError extends AiFinPayError {}

export class SeatNotFoundError extends AiFinPayError {}

/** The 402 response did not match any known facilitator flavor. */
export class UnsupportedFacilitatorError extends X402Error {}

/** Required payment exceeds the caller's maxAmountUsd budget. */
export class PaymentTooExpensiveError extends X402Error {}

/** Detected a known facilitator we can't pay yet (e.g. EVM not wired). */
export class FacilitatorNotImplementedError extends X402Error {}

/**
 * Shape safe to cross a process boundary (MCP tool result, logs, chat).
 * Only the error name, message, and explicitly allowlisted public fields —
 * never seeds, secret keys, keystore JSON, bearer JWTs, or signatures.
 */
export interface SafeErrorShape {
  name: string;
  message: string;
  code?: string;
  kind?: string;
  stage?: string;
  txHash?: string;
  txRef?: string;
  quoteId?: string;
}

const SAFE_ERROR_STRING_FIELDS = [
  "code",
  "kind",
  "stage",
  "txHash",
  "txRef",
  "quoteId",
] as const;

/** Serialize any thrown value to SafeErrorShape. Non-Errors become UnknownError. */
export function toSafeError(err: unknown): SafeErrorShape {
  if (!(err instanceof Error)) return { name: "UnknownError", message: String(err) };
  const rec = err as unknown as Record<string, unknown>;
  const shape: SafeErrorShape = { name: err.name, message: err.message };
  for (const field of SAFE_ERROR_STRING_FIELDS) {
    const value = rec[field];
    if (typeof value === "string" && value) shape[field] = value;
  }
  return shape;
}
