import pytest

from aifinpay.fee_bps import MAX_TREASURY_BPS, protocol_fee_units, quoted_fee_bps


def test_reads_the_fee_from_fee_bps_or_fee_policy():
    assert quoted_fee_bps({"fee_bps": 250}) == 250
    assert quoted_fee_bps({"fee_policy": {"treasury_bps": 175}}) == 175
    assert quoted_fee_bps({"fee_bps": 320, "fee_policy": {"treasury_bps": 320}}) == 320
    assert quoted_fee_bps({"fee_bps": MAX_TREASURY_BPS}) == MAX_TREASURY_BPS


@pytest.mark.parametrize("quote", [
    {},
    {"fee_bps": 0},
    {"fee_bps": MAX_TREASURY_BPS + 1},
    {"fee_bps": 1.5},
    {"fee_bps": "100"},
    {"fee_bps": True},
    {"fee_bps": 100, "fee_policy": {"treasury_bps": 250}},
    {"fee_bps": 100, "fee_policy": {"treasury_bps": -1}},
])
def test_refuses_an_unusable_fee(quote):
    assert quoted_fee_bps(quote) is None


def test_splits_with_integer_floor():
    assert protocol_fee_units(100_000, 250) == 2_500
    assert protocol_fee_units(399, 250) == 9
