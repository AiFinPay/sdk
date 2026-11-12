"""AIFP-1 protocol fee as stated by a quote."""

from typing import Any, Mapping, Optional

MAX_TREASURY_BPS = 500  # contract cap (Profiles.MAX_TREASURY_BPS); a bound, not a price


def valid_fee_bps(value: Any) -> Optional[int]:
    return value if type(value) is int and 1 <= value <= MAX_TREASURY_BPS else None


def quoted_fee_bps(quote: Mapping[str, Any]) -> Optional[int]:
    """Fee in bps from fee_bps and fee_policy.treasury_bps; None when absent, out of range or contradictory."""
    policy = quote.get("fee_policy")
    stated = [
        v
        for v in (quote.get("fee_bps"), policy.get("treasury_bps") if isinstance(policy, dict) else None)
        if v is not None
    ]
    if not stated or any(valid_fee_bps(v) is None for v in stated) or any(v != stated[0] for v in stated):
        return None
    return stated[0]


def protocol_fee_units(gross: int, bps: int) -> int:
    return gross * bps // 10_000
