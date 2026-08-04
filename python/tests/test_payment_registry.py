from datetime import datetime, timezone
from unittest.mock import patch

import pytest
from web3 import Web3

from aifinpay.errors import UntrustedPaymentTargetError
from aifinpay.payment_registry import (
    POLYGON_TARGET,
    validate_polygon_quote,
    validate_polygon_runtime,
)


MERCHANT = "0x1111111111111111111111111111111111111111"
NOW = datetime(2026, 8, 5, tzinfo=timezone.utc)


def quote(**overrides):
    value = {
        "chain": "polygon",
        "splitter": POLYGON_TARGET["splitter"],
        "splitter_version": "1.2",
        "merchant_wallet": MERCHANT,
        "total_wei": "100000",
        "merchant_amount_wei": "98990",
        "treasury_amount_wei": "1000",
        "ip_creator_amount_wei": "10",
        "ip_creator": POLYGON_TARGET["treasury"],
        "order_id": "order-1",
        "function_signature": "payNative(bytes32,address,address,string)",
    }
    value.update(overrides)
    return value


@pytest.mark.parametrize("patch_value,reason", [
    ({"splitter": "0x2222222222222222222222222222222222222222"}, "splitter_not_registered"),
    ({"chain": "base"}, "chain_mismatch"),
    ({"splitter_version": "1.1"}, "version_mismatch"),
    ({"splitter_version": None}, "version_mismatch"),
    ({"merchant_wallet": "0x3333333333333333333333333333333333333333"}, "merchant_mismatch"),
    ({"ip_creator": "0x3333333333333333333333333333333333333333"}, "ip_creator_not_registered"),
    ({"treasury_amount_wei": "999"}, "treasury_amount_wei_mismatch"),
    ({"function_signature": "payMatic(address,address,string)"}, "function_signature_mismatch"),
])
def test_quote_rejects_untrusted_metadata(patch_value, reason):
    with pytest.raises(UntrustedPaymentTargetError, match=reason):
        validate_polygon_quote(quote(**patch_value), MERCHANT, now=NOW)


def test_quote_accepts_canonical_terms():
    result = validate_polygon_quote(quote(), MERCHANT, now=NOW)
    assert result["splitter"] == POLYGON_TARGET["splitter"]
    assert result["merchant"] == Web3.to_checksum_address(MERCHANT)
    assert result["ip_creator"] == POLYGON_TARGET["treasury"]
    assert result["total_wei"] == 100000


def test_expired_registry_blocks_payment():
    with pytest.raises(UntrustedPaymentTargetError, match="registry_entry_expired"):
        validate_polygon_quote(
            quote(), MERCHANT,
            now=datetime(2026, 9, 3, tzinfo=timezone.utc),
        )


class _Call:
    def __init__(self, value):
        self.value = value

    def call(self):
        if isinstance(self.value, Exception):
            raise self.value
        return self.value


class _Functions:
    def __init__(self, values):
        self.values = values

    def treasury(self):
        return _Call(self.values["treasury"])

    def owner(self):
        return _Call(self.values["owner"])

    def treasuryBps(self):
        return _Call(self.values["treasury_bps"])

    def ipCreatorBps(self):
        return _Call(self.values["creator_bps"])


class _Contract:
    def __init__(self, values):
        self.functions = _Functions(values)


class _Eth:
    def __init__(self, *, chain_id=137, code=b"\x60\x00", values=None, error=None):
        self.chain_id = chain_id
        self.code = code
        self.values = values or {
            "treasury": POLYGON_TARGET["treasury"],
            "owner": POLYGON_TARGET["treasury"],
            "treasury_bps": 100,
            "creator_bps": 1,
        }
        self.error = error

    def get_code(self, _address):
        if self.error:
            raise self.error
        return self.code

    def contract(self, **_kwargs):
        return _Contract(self.values)


class _Web3:
    def __init__(self, eth):
        self.eth = eth


def test_runtime_accepts_exact_code_and_config():
    code = b"\x60\x00"
    with patch.dict(POLYGON_TARGET, {"runtime_codehash": Web3.keccak(code).hex()}):
        validate_polygon_runtime(_Web3(_Eth(code=code)))


@pytest.mark.parametrize("eth,reason", [
    (_Eth(error=TimeoutError()), "rpc_unavailable"),
    (_Eth(chain_id=1), "rpc_chain_mismatch"),
    (_Eth(code=b""), "splitter_has_no_code"),
    (_Eth(code=b"\x60\x01"), "runtime_codehash_mismatch"),
    (_Eth(values={"treasury": POLYGON_TARGET["treasury"], "owner": POLYGON_TARGET["treasury"], "treasury_bps": 999, "creator_bps": 1}), "treasury_fee_mismatch"),
])
def test_runtime_fails_closed(eth, reason):
    code = b"\x60\x00"
    with patch.dict(POLYGON_TARGET, {"runtime_codehash": Web3.keccak(code).hex()}):
        with pytest.raises(UntrustedPaymentTargetError, match=reason):
            validate_polygon_runtime(_Web3(eth))
