"""Fail-closed payment-target validation for wallet signing."""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Any

from web3 import Web3

from .errors import UntrustedPaymentTargetError


POLYGON_TARGET = {
    "chain": "polygon",
    "chain_id": 137,
    "version": "1.2",
    "splitter": "0xbD1fa5453f212F096c0213788a645eC597FB4DDe",
    "runtime_codehash": "0x9001fbb7ec70097909415325dc70c5b2102c4312dcd8e01e7495cfcaca2edaff",
    "treasury": "0xD31d82c4b35DABaA2ad7023C89A78A052D1f3c8e",
    "treasury_bps": 100,
    "ip_creator_bps": 1,
    "valid_from": "2026-08-04T00:00:00+00:00",
    "valid_until": "2026-09-03T00:00:00+00:00",
    "enabled": True,
}


def _reject(reason: str) -> None:
    raise UntrustedPaymentTargetError(f"[PAY_TARGET_UNTRUSTED] {reason}")


def _address(value: Any, expected: str) -> bool:
    return isinstance(value, str) and Web3.is_address(value) and Web3.to_checksum_address(value) == Web3.to_checksum_address(expected)


def _uint(value: Any, label: str) -> int:
    if not isinstance(value, str) or not value.isdigit() or (len(value) > 1 and value[0] == "0"):
        _reject(f"{label}_invalid")
    return int(value)


def validate_polygon_quote(pm: dict, registered_merchant: str, *, now: datetime | None = None) -> dict:
    target = POLYGON_TARGET
    now = now or datetime.now(timezone.utc)
    valid_from = datetime.fromisoformat(target["valid_from"])
    valid_until = datetime.fromisoformat(target["valid_until"])
    if not target["enabled"]:
        _reject("route_disabled")
    if target["version"] != "1.2":
        _reject("legacy_v1_1_disabled")
    if now < valid_from or now >= valid_until:
        _reject("registry_entry_expired")
    if pm.get("chain") != target["chain"]:
        _reject("chain_mismatch")
    if not _address(pm.get("splitter"), target["splitter"]):
        _reject("splitter_not_registered")
    if pm.get("splitter_version") != target["version"]:
        _reject("version_mismatch")
    if not _address(pm.get("merchant_wallet"), registered_merchant):
        _reject("merchant_mismatch")
    order_id = pm.get("order_id")
    if not isinstance(order_id, str) or not order_id or len(order_id) > 256:
        _reject("order_id_invalid")
    signature = pm.get("function_signature")
    if signature is not None and signature != "payNative(bytes32,address,address,string)":
        _reject("function_signature_mismatch")
    if pm.get("ip_creator") is not None and not _address(pm["ip_creator"], target["treasury"]):
        _reject("ip_creator_not_registered")

    total = _uint(pm.get("total_wei"), "total_wei")
    if total == 0:
        _reject("total_wei_zero")
    treasury = total * target["treasury_bps"] // 10_000
    creator = total * target["ip_creator_bps"] // 10_000
    merchant = total - treasury - creator
    for key, expected in (
        ("treasury_amount_wei", treasury),
        ("ip_creator_amount_wei", creator),
        ("merchant_amount_wei", merchant),
    ):
        if key in pm and _uint(pm[key], key) != expected:
            _reject(f"{key}_mismatch")
    return {
        "splitter": Web3.to_checksum_address(target["splitter"]),
        "merchant": Web3.to_checksum_address(registered_merchant),
        "ip_creator": Web3.to_checksum_address(target["treasury"]),
        "order_id": order_id,
        "total_wei": total,
    }


_TARGET_ABI = [
    {"type": "function", "name": name, "stateMutability": "view", "inputs": [], "outputs": [{"type": output}]}
    for name, output in (("treasury", "address"), ("owner", "address"), ("treasuryBps", "uint256"), ("ipCreatorBps", "uint256"))
]


def validate_polygon_runtime(w3: Web3) -> None:
    target = POLYGON_TARGET
    try:
        chain_id = w3.eth.chain_id
        code = bytes(w3.eth.get_code(Web3.to_checksum_address(target["splitter"])))
    except Exception:
        _reject("rpc_unavailable")
    if chain_id != target["chain_id"]:
        _reject("rpc_chain_mismatch")
    if not code:
        _reject("splitter_has_no_code")
    if Web3.keccak(code).hex().lower() != target["runtime_codehash"]:
        _reject("runtime_codehash_mismatch")
    try:
        contract = w3.eth.contract(address=Web3.to_checksum_address(target["splitter"]), abi=_TARGET_ABI)
        treasury = contract.functions.treasury().call()
        owner = contract.functions.owner().call()
        treasury_bps = contract.functions.treasuryBps().call()
        creator_bps = contract.functions.ipCreatorBps().call()
    except Exception:
        _reject("contract_introspection_failed")
    if not _address(treasury, target["treasury"]):
        _reject("treasury_mismatch")
    if not _address(owner, target["treasury"]):
        _reject("governance_not_approved")
    if treasury_bps != target["treasury_bps"]:
        _reject("treasury_fee_mismatch")
    if creator_bps != target["ip_creator_bps"]:
        _reject("royalty_fee_mismatch")
