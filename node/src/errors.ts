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

/** Payment metadata did not resolve to a trusted, canonical target. */
export class UntrustedPaymentTargetError extends X402Error {}

/** Required payment exceeds the caller's maxAmountUsd budget. */
export class PaymentTooExpensiveError extends X402Error {}

/** Detected a known facilitator we can't pay yet (e.g. EVM not wired). */
export class FacilitatorNotImplementedError extends X402Error {}
