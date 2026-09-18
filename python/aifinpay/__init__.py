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

# Cross-chain orchestration (Phase 1.5a — EVM↔EVM via LiFi).
# Standalone primitives — also exposed as methods on AiFinPayAgent.
from .cross_chain import (
    EVM_CHAINS,
    USDC_BRIDGED,
    USDC_NATIVE,
    BridgeQuote,
    BridgeQuoteFees,
    BridgeQuoteFrom,
    BridgeQuoteTo,
    BridgeReceipt,
    bridge_execute,
    bridge_quote,
    bridge_wait_for_arrival,
)
from .errors import (
    AiFinPayError,
    FacilitatorNotImplementedError,
    FundingTimeoutError,
    PaymentTooExpensiveError,
    SeatNotFoundError,
    UnsupportedFacilitatorError,
    X402Error,
)
from .facilitators import (
    AiFinPayFacilitator,
    CoinbaseX402Facilitator,
    Facilitator,
    PayOptions,
)


# Phase 1+ unified surface — at parity with @aifinpay/agent JS SDK.
# Lazy import so installs without the EVM/Solana extras keep working with
# the legacy Agent class.
def __getattr__(name: str):
    if name in (
        "AiFinPayAgent",
        "NetworkAgent",
        "CHAIN_IDS",
        "NATIVE_ASSETS",
        "EXPECTED_BPS",
        "SPLITTER_DEPLOYMENTS",
        "GOVERNANCE_SAFE",
        "V13_PAY_NATIVE_ABI",
        "V13_PAY_STABLE_ABI",
    ):
        from . import unified_agent

        return getattr(unified_agent, name)
    raise AttributeError(name)


# Read from the installed package metadata rather than written here.
#
# The literal that used to sit on this line said "2.0.0rc1" while
# pyproject.toml said 2.1.0 — so `pip show` and `aifinpay.__version__`
# disagreed, and the one a user can print from their own process was the wrong
# one. pyproject.toml is what gets built and uploaded, so it is the version.
#
# The fallback is for a source tree that was never installed (running tests from
# a checkout without `pip install -e .`). It is deliberately not a version
# number: an unknown version must look unknown rather than plausible.
try:  # pragma: no cover - trivial
    from importlib.metadata import PackageNotFoundError
    from importlib.metadata import version as _pkg_version

    __version__ = _pkg_version("aifinpay-agent")
except (ImportError, PackageNotFoundError):  # pragma: no cover - trivial
    __version__ = "0+unknown"
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
