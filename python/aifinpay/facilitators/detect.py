"""Pick the right facilitator adapter for a given 402 response."""

from __future__ import annotations

import requests

from ..errors import UnsupportedFacilitatorError
from .aifinpay import AiFinPayFacilitator
from .base import Facilitator
from .coinbase import CoinbaseX402Facilitator

# Order matters: most-specific detector first. A response that matches
# AiFinPay's body schema is *also* technically a 402, so we try AiFinPay
# before falling back to the generic header-based check.
REGISTERED: list[type[Facilitator]] = [
    AiFinPayFacilitator,
    CoinbaseX402Facilitator,
]


def detect_facilitator(
    resp: requests.Response,
    override: str = "auto",
) -> Facilitator:
    """Return the facilitator adapter for `resp`.

    Args:
        resp: the 402 response to inspect.
        override: `"auto"` runs detection. Any other string forces that
            facilitator by name (e.g. `"aifinpay"`).

    Raises:
        UnsupportedFacilitatorError: no registered facilitator matched.
    """
    if override and override != "auto":
        for cls in REGISTERED:
            if cls.name == override:
                return cls()  # type: ignore[abstract]
        raise UnsupportedFacilitatorError(
            f"unknown facilitator override: {override!r}. " f"known: {[c.name for c in REGISTERED]}"
        )

    for cls in REGISTERED:
        if cls.detect(resp):
            return cls()  # type: ignore[abstract]

    raise UnsupportedFacilitatorError(
        f"402 response did not match any known facilitator. "
        f"Status: {resp.status_code}. "
        f"Headers: {list(resp.headers.keys())[:8]}. "
        f"Body preview: {resp.text[:200]!r}"
    )
