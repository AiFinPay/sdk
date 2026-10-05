"""Public settlement and retained quota metadata; never return bearer receipts."""

import re
import time
from datetime import datetime, timezone
from urllib.parse import urlencode

import requests

RECEIPT_FIELDS = (
    "receipt_id",
    "merchant_id",
    "resource",
    "scope",
    "tier",
    "quota",
    "used",
    "remaining",
    "amount",
    "currency",
    "exp",
    "chain",
    "tx_ref",
    "payer",
    "network_mode",
    "settled_at",
    "expires_at",
    "unit_quota",
    "metering_version",
    "asset",
    "network",
    "program",
)
TRANSACTION_FIELDS = (
    "tx_hash",
    "log_index",
    "chain",
    "payment_id",
    "block_number",
    "block_ts",
    "agent_address",
    "merchant_address",
    "token_address",
    "total_amount",
    "merchant_amount",
    "treasury_fee",
    "ip_creator_fee",
    "network",
    "program",
    "block_hash",
    "nonce",
    "treasury_address",
    "fee_lamports",
    "nonce_rent_lamports",
    "ata_rent_lamports",
    "cost_allocation",
    "order_id_hash",
    "route_id",
)


def _identity(address, chain, network):
    if chain == "solana":
        from .settlement_solana_v14 import _key, inventory

        if network not in ("mainnet", "devnet"):
            raise ValueError("Solana history requires explicit solana_network")
        d = inventory("prod" if network == "mainnet" else "dev", network)
        _key(address)
        return address, {"chain": "solana", "network": network, "program": d["programId"]}
    if network is not None:
        raise ValueError("solana_network requires chain=solana")
    if not isinstance(address, str) or not re.fullmatch("0x[0-9a-fA-F]{40}", address):
        raise ValueError("History requires an EVM address")
    from .payment_chains import PAYMENT_CHAINS

    if chain not in PAYMENT_CHAINS:
        raise ValueError("Unknown history chain")
    return address.lower(), {}


def _context(value, selected, address=None, identity_field="address"):
    if not isinstance(value, dict):
        raise ValueError("Invalid history response")
    if selected and (
        any(value.get(k) != selected[k] for k in ("network", "program", "chain"))
        or value.get(identity_field) != address
    ):
        raise ValueError("History response changed the selected Solana network/program")


def _coverage(value):
    if (
        not isinstance(value, dict)
        or value.get("coverage_kind") != "retained_rpc_inventory"
        or value.get("archive_complete") is not False
        or not (
            "coverage_start" in value
            and (
                value["coverage_start"] is None or type(value["coverage_start"]) is int and value["coverage_start"] > 0
            )
        )
    ):
        raise ValueError("Invalid retained Solana history coverage")
    return {k: value[k] for k in ("coverage_kind", "coverage_start", "archive_complete")}


def get_agent_history(
    address,
    *,
    chain="polygon",
    solana_network=None,
    source="transactions",
    limit=25,
    offset=0,
    api_base="https://aifinpay.io",
    session=None,
):
    """Non-signing read, explicitly partitioned by Solana cluster/program."""
    if type(limit) is not int or not 1 <= limit <= 100 or type(offset) is not int or not 0 <= offset <= 100000:
        raise ValueError("History limit must be 1..100 and offset 0..100000")
    if source not in ("transactions", "receipts"):
        raise ValueError("Unknown history source")
    address, selected = _identity(address, chain, solana_network)
    query = {"limit": limit, "offset": offset, **selected}
    if source == "transactions":
        query["chain"] = chain
    r = (session or requests.Session()).get(
        f"{api_base.rstrip('/')}/v1/agents/{address}/{source}?{urlencode(query)}",
        headers={"accept": "application/json"},
        timeout=15,
        allow_redirects=False,
    )
    if not r.ok:
        raise ValueError(f"Payment history unavailable: HTTP {r.status_code}; source={source}; chain={chain}")
    body = r.json()
    _context(body, selected, address)
    if not isinstance(body.get(source), list):
        raise ValueError("Invalid history response")
    fields = RECEIPT_FIELDS if source == "receipts" else TRANSACTION_FIELDS
    items = []
    for row in body[source]:
        _context(row, selected, address, "payer" if source == "receipts" else "agent_address")
        items.append({k: row[k] for k in fields if k in row})
    return {
        "address": address,
        **selected,
        "source": source,
        "items": items,
        "limit": limit,
        "offset": offset,
        "next_offset": body.get("next_offset") if type(body.get("next_offset")) is int else None,
        **({"indexing": _coverage(body["indexing"])} if selected and "indexing" in body else {}),
        "coverage": (
            "Retained AiFinPay receipts only; external merchant quota may lag"
            if source == "receipts"
            else (
                "Verified AiFinPay settlements from retained RPC inventory only; partial history, no archive/full-wallet attestation. Shared transaction costs may be unallocated."
                if selected
                else f"Indexed AiFinPay {chain} settlements only; excludes arbitrary wallet transfers and may lag the chain"
            )
        ),
    }


def get_quota(
    address,
    *,
    chain=None,
    solana_network=None,
    merchant_id=None,
    include_exhausted=False,
    api_base="https://aifinpay.io",
    session=None,
):
    """Retained active prepaid batches, grouped by merchant without bearer JWTs."""
    address, selected = _identity(address, chain or "polygon", solana_network)
    query = {**({"chain": chain} if chain else {}), **selected}
    suffix = "?" + urlencode(query) if query else ""
    r = (session or requests.Session()).get(
        f"{api_base.rstrip('/')}/v1/agents/{address}/receipts{suffix}",
        headers={"accept": "application/json"},
        timeout=15,
        allow_redirects=False,
    )
    if not r.ok:
        raise ValueError(f"Quota lookup failed: HTTP {r.status_code}")
    body = r.json()
    _context(body, selected, address)
    if not isinstance(body.get("receipts"), list):
        raise ValueError("Invalid quota response")
    batches, totals = [], {}

    def number(x, default=0):
        return x if type(x) in (float, int) and x >= 0 and x < float("inf") else default

    for r in body["receipts"]:
        _context(r, selected, address, "payer")
        if selected and (
            not all(type(r.get(k)) is int and 0 <= r[k] <= 2**53 - 1 for k in ("used", "remaining", "unit_quota"))
            or r["used"] + r["remaining"] != r["unit_quota"]
            or (r.get("exp") is not None and (type(r["exp"]) is not int or not 0 < r["exp"] <= 253402300799))
        ):
            raise ValueError("Malformed Solana unit quota, usage or expiry")
        remaining = number(r.get("remaining"))
        if (
            (r.get("exp") is not None and number(r.get("exp")) <= time.time())
            or (merchant_id and r.get("merchant_id") != merchant_id)
            or (not include_exhausted and remaining <= 0)
        ):
            continue
        b = {
            k: r[k]
            for k in ("merchant_id", "resource", "tier", "receipt_id", "chain", "asset")
            if isinstance(r.get(k), str)
        }
        b.update(
            {
                "scope": r.get("scope") if isinstance(r.get("scope"), str) else "exact",
                "used": number(r.get("used")),
                "remaining": remaining,
                "quota": r["unit_quota"] if selected else number(r.get("quota"), 1),
                **({"network": selected["network"], "program": selected["program"]} if selected else {}),
            }
        )
        if r.get("amount") is not None:
            b["paid"] = f"{r['amount']} {r.get('currency', 'USD')}"
        if type(r.get("exp")) in (int, float):
            b["expires"] = datetime.fromtimestamp(r["exp"], timezone.utc).isoformat().replace("+00:00", "Z")
        batches.append(b)
        key = b.get("merchant_id", "unknown")
        total = totals.setdefault(key, {"remaining": 0, "batches": 0})
        total["remaining"] += remaining
        total["batches"] += 1
        if selected and max(total["remaining"], total["batches"]) > 2**53 - 1:
            raise ValueError("Solana quota totals exceed safe integer bounds")
    batches.sort(key=lambda b: b["remaining"], reverse=True)
    return {"agent": address, "totals": totals, "batches": batches}
