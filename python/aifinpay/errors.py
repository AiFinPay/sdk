class AiFinPayError(Exception):
    """Base class for all SDK errors."""


class X402Error(AiFinPayError):
    """Raised when the x402 challenge/response flow fails."""


class FundingTimeoutError(AiFinPayError):
    """Raised when polling for funding exceeds the timeout."""


class SeatNotFoundError(AiFinPayError):
    """Raised when the agent has no Seat PDA on-chain."""


class UnsupportedFacilitatorError(X402Error):
    """The 402 response did not match any known facilitator flavor."""


class UntrustedPaymentTargetError(X402Error):
    """Payment metadata did not resolve to a trusted canonical target."""


class PaymentTooExpensiveError(X402Error):
    """Required payment exceeds the caller's max_amount_usd budget."""


class FacilitatorNotImplementedError(X402Error):
    """Detected a known facilitator we can't pay yet (e.g. EVM not wired)."""
