"""Pricing constants — a port of gate/src/pricing.ts (itself transcribed from
backend/aifp/pricing.js). weight == unit price / base price for every tier;
tests/test_parity.py checks these against the Node package."""

import math
from typing import Optional

TIER_WEIGHTS = {"standard": 1, "complex": 4, "premium": 10}
UNIT_PRICE_USD = {"standard": "0.0005", "complex": "0.002", "premium": "0.005"}
BASE_UNIT_PRICE_USD = "0.0005"

_UNIT_PRICE_UNITS = {"standard": 500, "complex": 2000, "premium": 5000}
MIN_BATCH_UNITS = 20_000  # $0.02 in 6-dp minor units (server AIFP_MIN_BATCH_UNITS)


def weight_for_tier(tier: Optional[str]) -> int:
    """Billing units per call; unknown or absent → 1, as on the server."""
    return TIER_WEIGHTS.get(tier or "", 1)


def min_requests_for_tier(tier: Optional[str], min_batch_units: int = MIN_BATCH_UNITS) -> int:
    unit = _UNIT_PRICE_UNITS.get(tier or "standard", _UNIT_PRICE_UNITS["standard"])
    return math.ceil(min_batch_units / unit)


def unit_price_usd(tier: Optional[str]) -> str:
    return UNIT_PRICE_USD.get(tier or "", BASE_UNIT_PRICE_USD)
