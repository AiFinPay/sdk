"""Fail-closed payment-target validation for wallet signing."""

from __future__ import annotations

from datetime import datetime, timezone
import hashlib
import math
import os
import struct
from typing import Any

import base58
from web3 import Web3
from solders.pubkey import Pubkey

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
    "native_usd_env": "AIFINPAY_MATIC_USD",
    "valid_from": "2026-08-04T00:00:00+00:00",
    "valid_until": "2026-09-03T00:00:00+00:00",
    "enabled": False,
}

SOLANA_TARGET = {
    "chain": "solana",
    "program_id": "5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2",
    "instruction": "b2b_pay_with_split",
    "treasury_bps": 100,
    "ip_creator_bps": 1,
    "valid_from": "2026-08-04T00:00:00+00:00",
    "valid_until": "2026-09-03T00:00:00+00:00",
    "enabled": False,
}


def _reject(reason: str) -> None:
    raise UntrustedPaymentTargetError(f"[PAY_TARGET_UNTRUSTED] {reason}")


def _address(value: Any, expected: str) -> bool:
    return isinstance(value, str) and Web3.is_address(value) and Web3.to_checksum_address(value) == Web3.to_checksum_address(expected)


def _uint(value: Any, label: str) -> int:
    if not isinstance(value, str) or not value.isdigit() or (len(value) > 1 and value[0] == "0"):
        _reject(f"{label}_invalid")
    return int(value)


def _pubkey(value: Any, label: str) -> str:
    if not isinstance(value, str):
        _reject(f"solana_{label}_invalid")
    try:
        decoded = base58.b58decode(value)
    except Exception:
        _reject(f"solana_{label}_invalid")
    if len(decoded) != 32 or base58.b58encode(decoded).decode("ascii") != value:
        _reject(f"solana_{label}_invalid")
    return value


def require_native_usd_price(target: dict) -> float:
    """C-2: never let a USD-denominated spend guard fail open on unknown price."""
    env_name = target.get("native_usd_env")
    if not isinstance(env_name, str) or not env_name:
        _reject("native_price_policy_missing")
    raw = os.environ.get(env_name)
    try:
        value = float(raw) if raw is not None else float("nan")
    except (TypeError, ValueError):
        value = float("nan")
    if not math.isfinite(value) or value <= 0:
        _reject(f"native_price_unavailable:{env_name}")
    return value


def validate_solana_quote(
    ps: dict,
    registered_merchant: str,
    expected_agent: str,
    *,
    now: datetime | None = None,
) -> dict:
    """Validate every bridge-controlled Solana field before wallet signing."""
    target = SOLANA_TARGET
    now = now or datetime.now(timezone.utc)
    valid_from = datetime.fromisoformat(target["valid_from"])
    valid_until = datetime.fromisoformat(target["valid_until"])
    if not target["enabled"]:
        _reject("solana_route_disabled_pending_v0_6_upgrade")
    if now < valid_from or now >= valid_until:
        _reject("solana_registry_entry_expired")
    if ps.get("chain") != target["chain"]:
        _reject("solana_chain_mismatch")
    if _pubkey(ps.get("program_id"), "program_id") != target["program_id"]:
        _reject("solana_program_not_registered")
    if ps.get("instruction") != target["instruction"]:
        _reject("solana_instruction_mismatch")
    agent = _pubkey(ps.get("agent_pubkey"), "agent")
    if agent != _pubkey(expected_agent, "expected_agent"):
        _reject("solana_agent_mismatch")
    merchant = _pubkey(ps.get("merchant_wallet"), "merchant")
    if merchant != _pubkey(registered_merchant, "registered_merchant"):
        _reject("solana_merchant_mismatch")
    treasury = _pubkey(ps.get("treasury"), "treasury")
    creator = _pubkey(ps.get("ip_creator"), "ip_creator")
    creator_enabled = ps.get("creator_fee_enabled") is True
    if merchant in (agent, treasury):
        _reject("solana_invalid_merchant")
    if creator_enabled:
        if creator in (agent, merchant, treasury):
            _reject("solana_invalid_creator")
    elif creator != treasury:
        _reject("solana_invalid_creator")
    order_id = ps.get("order_id")
    if not isinstance(order_id, str) or not order_id or len(order_id.encode("utf-8")) > 64:
        _reject("solana_order_id_invalid")

    merchant_amount = _uint(ps.get("merchant_amount_lamports"), "solana_merchant_amount_lamports")
    if merchant_amount == 0 or merchant_amount > 0xFFFFFFFFFFFFFFFF:
        _reject("solana_merchant_amount_lamports_invalid")
    treasury_amount = merchant_amount * target["treasury_bps"] // 10_000
    creator_amount = merchant_amount * target["ip_creator_bps"] // 10_000 if creator_enabled else 0
    if treasury_amount == 0 or (creator_enabled and creator_amount == 0):
        _reject("solana_amount_below_fee_floor")
    total = merchant_amount + treasury_amount + creator_amount
    for key, expected in (
        ("treasury_fee_lamports", treasury_amount),
        ("ip_creator_fee_lamports", creator_amount),
        ("total_lamports", total),
    ):
        if _uint(ps.get(key), f"solana_{key}") != expected:
            _reject(f"solana_{key}_mismatch")

    payment_id = hashlib.sha256(
        b"AiFinPay-solana-payment-v1"
        + base58.b58decode(agent)
        + base58.b58decode(merchant)
        + struct.pack("<Q", merchant_amount)
        + base58.b58decode(creator)
        + bytes([1 if creator_enabled else 0])
        + order_id.encode("utf-8")
    ).digest()
    supplied_payment_id = ps.get("payment_id")
    if not isinstance(supplied_payment_id, str) or not supplied_payment_id.startswith("0x"):
        _reject("solana_payment_id_invalid")
    try:
        supplied_payment_id_bytes = bytes.fromhex(supplied_payment_id[2:])
    except ValueError:
        _reject("solana_payment_id_invalid")
    if len(supplied_payment_id_bytes) != 32 or supplied_payment_id_bytes != payment_id:
        _reject("solana_payment_id_mismatch")
    expected_receipt, _ = Pubkey.find_program_address(
        [b"b2b-payment", bytes(Pubkey.from_string(agent)), payment_id],
        Pubkey.from_string(target["program_id"]),
    )
    receipt = _pubkey(ps.get("payment_receipt"), "payment_receipt")
    if receipt != str(expected_receipt):
        _reject("solana_payment_receipt_mismatch")
    return {
        "program_id": target["program_id"],
        "agent_pubkey": agent,
        "merchant_wallet": merchant,
        "treasury": treasury,
        "ip_creator": creator,
        "payment_receipt": receipt,
        "payment_id": payment_id,
        "merchant_amount_lamports": merchant_amount,
        "creator_fee_enabled": creator_enabled,
        "order_id": order_id,
        "total_lamports": total,
    }


def validate_polygon_quote(pm: dict, registered_merchant: str, *, now: datetime | None = None) -> dict:
    target = POLYGON_TARGET
    now = now or datetime.now(timezone.utc)
    valid_from = datetime.fromisoformat(target["valid_from"])
    valid_until = datetime.fromisoformat(target["valid_until"])
    if not target["enabled"]:
        _reject("route_disabled")
    if target["version"] != "1.3":
        _reject("fee_inclusive_splitter_disabled")
    if now < valid_from or now >= valid_until:
        _reject("registry_entry_expired")

    # No explicit operator price means no wallet signing. The old code used a
    # stale $0.70 default and therefore mis-valued every payment.
    require_native_usd_price(target)

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
    if signature is not None and signature != "payNative(bytes32,address,uint256,address,string)":
        _reject("function_signature_mismatch")
    if pm.get("ip_creator") is not None and not _address(pm["ip_creator"], target["treasury"]):
        _reject("ip_creator_not_registered")

    merchant = _uint(pm.get("merchant_amount_wei"), "merchant_amount_wei")
    if merchant == 0:
        _reject("merchant_amount_wei_zero")
    treasury = merchant * target["treasury_bps"] // 10_000
    creator = merchant * target["ip_creator_bps"] // 10_000
    total = merchant + treasury + creator
    for key, expected in (
        ("treasury_amount_wei", treasury),
        ("ip_creator_amount_wei", creator),
        ("total_wei", total),
    ):
        if _uint(pm.get(key), key) != expected:
            _reject(f"{key}_mismatch")
    return {
        "splitter": Web3.to_checksum_address(target["splitter"]),
        "merchant": Web3.to_checksum_address(registered_merchant),
        "ip_creator": Web3.to_checksum_address(target["treasury"]),
        "order_id": order_id,
        "merchant_amount_wei": merchant,
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
