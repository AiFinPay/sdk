"""
AiFinPay agent SDK — non-custodial x402 payment client.

Quick start:

    from aifinpay import Agent

    agent = Agent.new()                 # generate fresh Ed25519 keypair locally
    print("Fund:", agent.address)

    # AiFinPay-native flow
    agent.wait_for_funding(min_usd_cents=100)
    invoice = agent.reserve_seat_invoice(amount_usd=1.00, asset="USDC")

    # Generic x402 — pays any supported facilitator
    resp = agent.pay("https://api.example.com/v1/data")

    # Convenience — same as pay() but pinned to GET / POST
    resp = agent.get("https://aifinpay.io/api/stats")
"""

from .client import Agent, Invoice
from .errors import (
    AiFinPayError,
    FacilitatorNotImplementedError,
    FundingTimeoutError,
    PaymentTooExpensiveError,
    SeatNotFoundError,
    UnsupportedFacilitatorError,
    UntrustedPaymentTargetError,
    X402Error,
)
from .facilitators import (
    AiFinPayFacilitator,
    CoinbaseX402Facilitator,
    Facilitator,
    PayOptions,
)

# Cross-chain orchestration (Phase 1.5a — EVM↔EVM via LiFi).
# Standalone primitives — also exposed as methods on AiFinPayAgent.
from .cross_chain import (
    EVM_CHAINS,
    USDC_NATIVE,
    USDC_BRIDGED,
    BridgeQuote,
    BridgeQuoteFees,
    BridgeQuoteFrom,
    BridgeQuoteTo,
    BridgeReceipt,
    bridge_quote,
    bridge_execute,
    bridge_wait_for_arrival,
)

# Phase 1+ unified surface — at parity with @aifinpay/agent JS SDK.
# Lazy import so installs without the EVM/Solana extras keep working with
# the legacy Agent class.
def __getattr__(name: str):
    if name in ("AiFinPayAgent", "NetworkAgent"):
        from . import unified_agent
        return getattr(unified_agent, name)
    raise AttributeError(name)

__version__ = "1.3.1"
__all__ = [
    "Agent",
    "AiFinPayAgent",
    "NetworkAgent",
    "Invoice",
    "AiFinPayError",
    "FundingTimeoutError",
    "SeatNotFoundError",
    "X402Error",
    "UnsupportedFacilitatorError",
    "UntrustedPaymentTargetError",
    "PaymentTooExpensiveError",
    "FacilitatorNotImplementedError",
    "PayOptions",
    "Facilitator",
    "AiFinPayFacilitator",
    "CoinbaseX402Facilitator",
    # Cross-chain (Phase 1.5a)
    "EVM_CHAINS",
    "USDC_NATIVE",
    "USDC_BRIDGED",
    "BridgeQuote",
    "BridgeQuoteFees",
    "BridgeQuoteFrom",
    "BridgeQuoteTo",
    "BridgeReceipt",
    "bridge_quote",
    "bridge_execute",
    "bridge_wait_for_arrival",
]
