from datetime import datetime, timezone
import hashlib
from pathlib import Path
import struct
from unittest.mock import patch

import base58
import pytest
from solders.pubkey import Pubkey
from web3 import Web3

from aifinpay.errors import UntrustedPaymentTargetError
from aifinpay.payment_registry import (
    POLYGON_TARGET,
    SOLANA_TARGET,
    require_native_usd_price,
    validate_polygon_quote,
    validate_polygon_runtime,
    validate_solana_quote,
)


MERCHANT = "0x1111111111111111111111111111111111111111"
NOW = datetime(2026, 8, 5, tzinfo=timezone.utc)
SOLANA_MERCHANT = "11111111111111111111111111111112"
SOLANA_TREASURY = "SysvarRent111111111111111111111111111111111"
SOLANA_AGENT = "BPFLoaderUpgradeab1e11111111111111111111111"


@pytest.fixture(autouse=True)
def _operator_native_price(monkeypatch):
    monkeypatch.setenv("AIFINPAY_MATIC_USD", "0.10")
    monkeypatch.setitem(POLYGON_TARGET, "enabled", True)
    monkeypatch.setitem(POLYGON_TARGET, "version", "1.3")


def quote(**overrides):
    value = {
        "chain": "polygon",
        "splitter": POLYGON_TARGET["splitter"],
        "splitter_version": "1.3",
        "merchant_wallet": MERCHANT,
        "total_wei": "101010",
        "merchant_amount_wei": "100000",
        "treasury_amount_wei": "1000",
        "ip_creator_amount_wei": "10",
        "ip_creator": POLYGON_TARGET["treasury"],
        "order_id": "order-1",
        "function_signature": "payNative(bytes32,address,uint256,address,string)",
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
    assert result["merchant_amount_wei"] == 100000
    assert result["total_wei"] == 101010


def test_deployed_fee_inclusive_polygon_target_is_quarantined():
    with patch.dict(POLYGON_TARGET, {"enabled": False, "version": "1.2"}):
        with pytest.raises(UntrustedPaymentTargetError, match="route_disabled"):
            validate_polygon_quote(quote(), MERCHANT, now=NOW)


def test_native_price_missing_fails_closed(monkeypatch):
    monkeypatch.delenv("AIFINPAY_MATIC_USD", raising=False)
    with pytest.raises(UntrustedPaymentTargetError, match="native_price_unavailable"):
        validate_polygon_quote(quote(), MERCHANT, now=NOW)


@pytest.mark.parametrize("value", ["0", "-1", "nan", "inf", "not-a-price"])
def test_invalid_native_price_fails_closed(monkeypatch, value):
    monkeypatch.setenv("AIFINPAY_MATIC_USD", value)
    with pytest.raises(UntrustedPaymentTargetError, match="native_price_unavailable"):
        require_native_usd_price(POLYGON_TARGET)


def test_missing_native_price_policy_fails_closed():
    target = dict(POLYGON_TARGET)
    target.pop("native_usd_env", None)
    with pytest.raises(UntrustedPaymentTargetError, match="native_price_policy_missing"):
        require_native_usd_price(target)


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


def solana_quote(**overrides):
    merchant_amount = 1_000_000
    order_id = "order-1"
    payment_id = hashlib.sha256(
        b"AiFinPay-solana-payment-v1"
        + base58.b58decode(SOLANA_AGENT)
        + base58.b58decode(SOLANA_MERCHANT)
        + struct.pack("<Q", merchant_amount)
        + base58.b58decode(SOLANA_TREASURY)
        + b"\x00"
        + order_id.encode()
    ).digest()
    receipt, _ = Pubkey.find_program_address(
        [b"b2b-payment", bytes(Pubkey.from_string(SOLANA_AGENT)), payment_id],
        Pubkey.from_string(SOLANA_TARGET["program_id"]),
    )
    value = {
        "chain": "solana",
        "program_id": SOLANA_TARGET["program_id"],
        "instruction": "b2b_pay_with_split",
        "agent_pubkey": SOLANA_AGENT,
        "merchant_wallet": SOLANA_MERCHANT,
        "treasury": SOLANA_TREASURY,
        "ip_creator": SOLANA_TREASURY,
        "merchant_amount_lamports": str(merchant_amount),
        "treasury_fee_lamports": "10000",
        "ip_creator_fee_lamports": "0",
        "total_lamports": "1010000",
        "payment_id": "0x" + payment_id.hex(),
        "payment_receipt": str(receipt),
        "creator_fee_enabled": False,
        "order_id": order_id,
    }
    value.update(overrides)
    return value


def test_solana_quote_accepts_v06_candidate_terms():
    with patch.dict(SOLANA_TARGET, {"enabled": True}):
        result = validate_solana_quote(solana_quote(), SOLANA_MERCHANT, SOLANA_AGENT, now=NOW)
    assert result["program_id"] == SOLANA_TARGET["program_id"]
    assert result["merchant_wallet"] == SOLANA_MERCHANT
    assert result["treasury"] == SOLANA_TREASURY
    assert result["agent_pubkey"] == SOLANA_AGENT
    assert result["merchant_amount_lamports"] == 1_000_000
    assert result["total_lamports"] == 1_010_000


@pytest.mark.parametrize("patch_value,reason", [
    ({"chain": "polygon"}, "solana_chain_mismatch"),
    ({"program_id": SOLANA_MERCHANT}, "solana_program_not_registered"),
    ({"instruction": "b2b_pay"}, "solana_instruction_mismatch"),
    ({"instruction": None}, "solana_instruction_mismatch"),
    ({"merchant_wallet": SOLANA_TREASURY}, "solana_merchant_mismatch"),
    ({"agent_pubkey": SOLANA_TREASURY}, "solana_agent_mismatch"),
    ({"total_lamports": None}, "solana_total_lamports_invalid"),
    ({"treasury_fee_lamports": "999"}, "solana_treasury_fee_lamports_mismatch"),
    ({"ip_creator_fee_lamports": "9"}, "solana_ip_creator_fee_lamports_mismatch"),
    ({"payment_id": "0x" + "00" * 32}, "solana_payment_id_mismatch"),
    ({"order_id": ""}, "solana_order_id_invalid"),
])
def test_solana_quote_rejects_untrusted_metadata(patch_value, reason):
    with patch.dict(SOLANA_TARGET, {"enabled": True}):
        with pytest.raises(UntrustedPaymentTargetError, match=reason):
            validate_solana_quote(solana_quote(**patch_value), SOLANA_MERCHANT, SOLANA_AGENT, now=NOW)


def test_solana_registry_expiry_blocks_payment():
    with patch.dict(SOLANA_TARGET, {"enabled": True}):
        with pytest.raises(UntrustedPaymentTargetError, match="solana_registry_entry_expired"):
            validate_solana_quote(
                solana_quote(), SOLANA_MERCHANT, SOLANA_AGENT,
                now=datetime(2026, 9, 3, tzinfo=timezone.utc),
            )


def test_solana_signing_route_is_quarantined():
    with pytest.raises(
        UntrustedPaymentTargetError,
        match="solana_route_disabled_pending_v0_6_upgrade",
    ):
        validate_solana_quote(solana_quote(), SOLANA_MERCHANT, SOLANA_AGENT, now=NOW)


def test_solana_builder_matches_v06_anchor_accounts():
    source = (Path(__file__).parents[1] / "aifinpay" / "unified_agent.py").read_text()
    assert 'hashlib.sha256(b"global:b2b_pay_with_split")' in source
    assert 'hashlib.sha256(b"global:b2b_pay")' not in source
    account_lines = [
        "pubkey=config_pda",
        "pubkey=vault_pda",
        "pubkey=agent_pubkey",
        "pubkey=payment_receipt",
        "pubkey=treasury",
        "pubkey=ip_creator",
        "pubkey=merchant",
        "pubkey=SolPubkey.from_string(str(SYSTEM_PROGRAM_ID))",
    ]
    positions = [source.index(line) for line in account_lines]
    assert positions == sorted(positions)
    assert "passport_pda" not in source
    assert "partner_pda" not in source
