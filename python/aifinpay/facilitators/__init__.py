"""Facilitator adapters — one per x402 flavor.

A facilitator implements a single 402 wire format. The SDK detects the
flavor of an incoming 402 response, picks the right adapter, and uses
it to build the auth payload for the retry request.
"""

from .aifinpay import AiFinPayFacilitator
from .base import Facilitator, PayOptions
from .coinbase import CoinbaseX402Facilitator
from .detect import REGISTERED, detect_facilitator

__all__ = [
    "Facilitator",
    "PayOptions",
    "AiFinPayFacilitator",
    "CoinbaseX402Facilitator",
    "detect_facilitator",
    "REGISTERED",
]
