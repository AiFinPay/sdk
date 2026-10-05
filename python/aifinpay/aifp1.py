"""AIFP-1 paid access for Python agents: 402 → quote → v1.4 settlement → receipt.

A port of the paying half of ``node/src/aifp1.ts``. The byte formats the
server checks — the idempotency key, the receipt-authorization message — are
identical to Node's, and the receipt is verified the same way: an Ed25519 JWT
from the configured issuer's JWKS, bound to the exact purchase.

Safety properties kept from Node:

* only owner-listed HTTPS origins are paid;
* the signed call must match the quote (merchant, amount, expiry, asset);
* the caller authorizes the EVM chain; its native asset uses an independent price;
* a stablecoin quote must bind its gross exactly to the quoted dollars;
* per-payment and rolling-24h USD limits are enforced before anything is signed;
* the prepared transaction is journaled before it is sent, and an unknown
  outcome raises :class:`Aifp1PayError` carrying what is needed to recover it —
  never a second payment.

Most callers want :meth:`aifinpay.AiFinPayAgent.fetch_paid`, which supplies
the chain client, the durable journal and the persisted spend ledger.
"""

from __future__ import annotations

import base64
import contextlib
import copy
import hashlib
import json
import math
import os
import tempfile
import threading
import time
import uuid
from calendar import timegm
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

import nacl.exceptions
import nacl.signing
import requests
from eth_account.messages import encode_defunct
from eth_utils import keccak

from ._v14_deployments import V14_DEPLOYMENTS
from .payment_chains import PAYMENT_CHAINS, pinned_token_decimals
from .settlement_v14 import (
    SettlementConfirmationPending,
    V14ExecutionContext,
    V14SettlementError,
    execute_v14_settlement,
    validate_v14_settlement_call,
)

# Runtime aliases preserve Python 3.9 get_type_hints compatibility for new
# optional parameters without changing the existing public annotation policy.
_OptionalStr = Optional[str]
_OptionalInt = Optional[int]

DEFAULT_API_BASE = "https://api.aifinpay.io"
DEFAULT_BATCH_USD = Decimal("0.1")
FALLBACK_UNITS = 200
CHAINLINK_POL_USD_POLYGON = "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0"
MAX_FEED_AGE_S = 3600


class Aifp1Error(Exception):
    pass


class Aifp1QuoteError(Aifp1Error):
    """Purchase or recovery refused without authorizing another settlement."""


class Aifp1PayError(Aifp1Error):
    """Money may have moved. Recover with ``recovery``; do not pay again."""

    def __init__(self, message: str, tx_ref: str, quote_id: str, recovery: Dict[str, Any]):
        super().__init__(message)
        self.tx_ref = tx_ref
        self.quote_id = quote_id
        self.recovery = recovery


class Aifp1FinalizedFailureError(Aifp1PayError):
    """Canonical failed original signature reconciled to one fee-only debit."""

    code = "AIFP1_FINALIZED_FAILURE"

    def __init__(self, recovery, fee_amount_usd, actual_fee_lamports):
        super().__init__(
            "Original Solana transaction finalized with failure; fee-only debit reconciled without resending",
            recovery["tx_ref"],
            recovery["quote"]["quote_id"],
            recovery,
        )
        self.fee_amount_usd, self.actual_fee_lamports = fee_amount_usd, actual_fee_lamports


def _iso_to_unix(value: str) -> int:
    return timegm(time.strptime(str(value)[:19], "%Y-%m-%dT%H:%M:%S"))


# ── Wire formats (must match Node byte for byte) ────────────────────────────


def idempotency_key_for(quote_id: str, chain: str, asset: str, tx_ref: str) -> str:
    digest = hashlib.sha256(f"aifp1|{quote_id}|{asset}|{chain}|{tx_ref}".encode()).hexdigest()
    return f"aifp1-{digest}"


def payment_authorization_message(
    quote: Dict[str, Any],
    issuer: str,
    chain: str,
    tx_ref: str,
    asset: str,
    idempotency_key: str,
    payer: str,
    expires_at: int,
) -> str:
    # JSON.stringify of an array: no spaces, non-ASCII kept as-is.
    return json.dumps(
        [
            "AiFinPay receipt authorization v1",
            issuer,
            quote["quote_id"],
            quote.get("nonce"),
            quote["merchant_id"],
            quote.get("network_mode") or "live",
            chain,
            tx_ref,
            asset or "",
            idempotency_key,
            payer,
            expires_at,
        ],
        separators=(",", ":"),
        ensure_ascii=False,
    )


def solana_quote_authorization_message(body, auth, issuer):
    return json.dumps(
        [
            "AiFinPay quote authorization v1",
            issuer,
            auth["network"],
            auth["network_mode"],
            body["merchant_id"],
            body.get("resource"),
            body.get("tier", "standard"),
            body.get("requests"),
            body.get("units"),
            body.get("currency", "USD"),
            body.get("scope", "exact"),
            "solana",
            body.get("asset", "SOL"),
            auth["payer"],
            auth["nonce"],
            auth["expires_at"],
        ],
        separators=(",", ":"),
        ensure_ascii=False,
    )


def default_units_for(challenge: Dict[str, Any]) -> int:
    try:
        base = Decimal(str(challenge.get("base_unit_price_usd")))
    except (InvalidOperation, TypeError):
        return FALLBACK_UNITS
    if not base.is_finite() or base <= 0:
        return FALLBACK_UNITS
    return max(1, int((DEFAULT_BATCH_USD / base).to_integral_value(rounding=ROUND_CEILING)))


# ── Scope, ported from backend/aifp/scope.js (same as node/src/aifp1.ts) ────


def pattern_covers(pattern: str, path: str) -> bool:
    pat = str(pattern or "")
    if not pat.endswith("/*"):
        return path == pat
    return path == pat[:-2] or path.startswith(pat[:-1])


def scope_covers(scope: Optional[str], resource: str, path: str) -> bool:
    if scope == "merchant":
        return True
    if scope == "prefix":
        if resource == "/" or path == resource:
            return True
        # The trailing slash is what stops /articles covering /articles-internal.
        return path.startswith(resource if resource.endswith("/") else resource + "/")
    return pattern_covers(resource, path)


def prefix_hint(path: str) -> str:
    """/articles/2026/thing → /articles/; a single-segment path → "/" (the whole site)."""
    segs = [s for s in str(path or "/").split("/") if s]
    return f"/{segs[0]}/" if len(segs) > 1 else "/"


def _micro_usd(amount: Any) -> int:
    try:
        value = Decimal(str(amount))
    except (InvalidOperation, TypeError):
        raise Aifp1QuoteError(f"unusable amount {amount!r}")
    micro = value * 1_000_000
    if not micro.is_finite() or micro != micro.to_integral_value() or micro <= 0:
        raise Aifp1QuoteError(f"amount {amount!r} is not a whole number of micro-dollars")
    return int(micro)


# ── Independent native-asset/USD prices ─────────────────────────────────────


def _native_asset(chain: str) -> str:
    if chain == "solana":
        return "SOL"
    if chain not in PAYMENT_CHAINS:
        raise Aifp1QuoteError(f"unsupported explicitly selected AIFP-1 chain {chain!r}")
    return PAYMENT_CHAINS[chain]["native"]


def _merchant_address(quote: dict[str, Any], chain: str) -> str:
    pay_to = quote.get("pay_to") or {}
    if chain == "solana":
        return str(pay_to.get("solana", ""))
    if chain in pay_to and "evm" in pay_to and str(pay_to[chain]).lower() != str(pay_to["evm"]).lower():
        raise Aifp1QuoteError("chain and EVM merchant destinations disagree")
    return str(pay_to.get(chain, pay_to.get("evm", "")))


def _sane(usd: float, asset: str = "POL") -> bool:
    return 0 < usd < (1000 if asset in ("POL", "XRP") else 100_000)


def independent_pol_usd(session: requests.Session, polygon_rpc: str) -> Tuple[float, str]:
    """Chainlink on Polygon over the agent's own RPC, then Coinbase, then CoinGecko."""
    return independent_native_usd(session, polygon_rpc, "polygon")


def independent_native_usd(session: requests.Session, rpc: str, chain: str) -> tuple[float, str]:
    """Independent native-asset spot price; never substitute another chain's asset."""
    asset = _native_asset(chain)
    errors = []
    if chain == "polygon":
        try:
            r = session.post(
                rpc,
                json={
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "eth_call",
                    "params": [{"to": CHAINLINK_POL_USD_POLYGON, "data": "0xfeaf968c"}, "latest"],
                },
                timeout=10,
                allow_redirects=False,
            )
            hexdata = str(r.json().get("result", ""))[2:]
            if r.ok and len(hexdata) >= 64 * 5:
                answer = int(hexdata[64:128], 16)
                updated_at = int(hexdata[192:256], 16)
                usd = answer / 1e8
                if answer < 2**255 and _sane(usd) and -30 <= time.time() - updated_at <= MAX_FEED_AGE_S:
                    return usd, "chainlink-polygon"
            errors.append("chainlink: unusable answer")
        except Exception as e:  # noqa: BLE001 — every failure means "try the next source"
            errors.append(f"chainlink: {type(e).__name__}")
    try:
        r = session.get(f"https://api.coinbase.com/v2/prices/{asset}-USD/spot", timeout=10, allow_redirects=False)
        d = r.json().get("data") or {}
        usd = float(d.get("amount"))
        if r.ok and d.get("base") == asset and d.get("currency") == "USD" and _sane(usd, asset):
            return usd, "coinbase"
        errors.append("coinbase: invalid response")
    except Exception as e:  # noqa: BLE001
        errors.append(f"coinbase: {type(e).__name__}")
    try:
        coin_id = "solana" if chain == "solana" else PAYMENT_CHAINS[chain]["coingeckoId"]
        r = session.get(
            f"https://api.coingecko.com/api/v3/simple/price?ids={coin_id}"
            "&vs_currencies=usd&include_last_updated_at=true",
            timeout=10,
            allow_redirects=False,
        )
        entry = r.json().get(coin_id) or {}
        usd = float(entry.get("usd"))
        age = time.time() - int(entry.get("last_updated_at", 0))
        if r.ok and _sane(usd, asset) and -30 <= age <= MAX_FEED_AGE_S:
            return usd, "coingecko"
        errors.append("coingecko: invalid response")
    except Exception as e:  # noqa: BLE001
        errors.append(f"coingecko: {type(e).__name__}")
    raise Aifp1QuoteError(f"no independent {asset}/USD price is available (" + "; ".join(errors) + ")")


# ── Quote checks ────────────────────────────────────────────────────────────


def _pinned_stable(asset: str, chain: str = "polygon") -> str:
    _native_asset(chain)
    for a in V14_DEPLOYMENTS[chain]["splitter"]["assets"]:
        if a["symbol"] == asset and pinned_token_decimals(chain, a["address"]) is not None:
            return a["address"]
    raise Aifp1QuoteError(f'asset "{asset}" is not a stablecoin pinned for {chain} v1.4')


def validate_stable_quote(
    quote: Dict[str, Any],
    asset: str,
    payer: str,
    expiry_s: int,
    chain: str = "polygon",
) -> int:
    """Bind USD micro-units to exact pinned token minor units; return USD micro-units."""
    call = quote.get("settlement_call") or {}
    if call.get("splitter_version") != "1.4":
        raise Aifp1QuoteError("a stablecoin purchase requires a signed v1.4 quote")
    validate_v14_settlement_call(call, order_id=quote["quote_id"], payer=payer)
    q = call["args"]["quote"]
    token = _pinned_stable(asset, chain)
    micro = _micro_usd(quote.get("amount"))
    decimals = pinned_token_decimals(chain, token)
    gross = micro * 10 ** (decimals - 6)
    metadata = quote.get("token_settlement")
    treasury = gross // 100
    if (decimals == 18 and metadata is None) or (
        "token_settlement" in quote
        and (
            not isinstance(metadata, dict)
            or metadata.get("asset") != asset
            or str(metadata.get("token", "")).lower() != token.lower()
            or type(metadata.get("decimals")) is not int
            or metadata.get("decimals") != decimals
            or metadata.get("settlement_semantics") != "gross-inclusive"
            or metadata.get("total_units") != str(gross)
            or metadata.get("merchant_units") != str(gross - treasury)
            or metadata.get("protocol_fee_units") != str(treasury)
            or metadata.get("creator_units") != "0"
        )
    ):
        raise Aifp1QuoteError("token_settlement disagrees with pinned token, decimals or exact gross-inclusive split")
    approval = call.get("approval") or {}
    units = (quote.get("settlement") or {}).get("total_units")
    if (
        call.get("chain") != chain
        or call.get("asset") != asset
        or call.get("route") != "merchant-aifp1"
        or q["token"].lower() != token.lower()
        or quote.get("accepted_chains") != [chain]
        or not _merchant_address(quote, chain)
        or q["merchant"].lower() != _merchant_address(quote, chain).lower()
        or "native_settlement" in quote
        or quote.get("accepted_assets") != [asset]
        or units is None
        or units != str(micro)
        or q["grossAmount"] != str(gross)
        or gross >= 2**256
        or str(approval.get("token", "")).lower() != token.lower()
        or str(approval.get("spender", "")).lower() != call["contract"].lower()
        or str(approval.get("amount")) != q["grossAmount"]
        or int(q["validUntil"]) != expiry_s
    ):
        raise Aifp1QuoteError(
            "signed v1.4 stablecoin call disagrees with the requested asset, merchant, amount, approval or expiry"
        )
    return micro


def validate_native_quote(
    quote: Dict[str, Any],
    payer: str,
    expiry_s: int,
    native_usd: float,
    chain: str = "polygon",
) -> float:
    """Cross-check the selected native asset against its independent price."""
    native_asset = _native_asset(chain)
    call = quote.get("settlement_call") or {}
    if call.get("splitter_version") != "1.4":
        raise Aifp1QuoteError("a native purchase requires a signed v1.4 quote; no legacy fallback")
    validate_v14_settlement_call(call, order_id=quote["quote_id"], payer=payer)
    native = quote.get("native_settlement") or {}
    q = call["args"]["quote"]
    total = str(native.get("total_wei", ""))
    if not total.isdigit() or native.get("asset") != native_asset or native.get("decimals") != 18:
        raise Aifp1QuoteError(f"quote has no valid native {native_asset} debit")
    gross = int(total)
    treasury = int(native.get("treasury_wei", -1))
    if (
        call.get("chain") != chain
        or quote.get("accepted_chains") != [chain]
        or call.get("asset") != native_asset
        or call.get("route") != "merchant-aifp1"
        or quote.get("accepted_assets") != [native_asset]
        or q["merchant"].lower() != _merchant_address(quote, chain).lower()
        or q["grossAmount"] != total
        or int(q["validUntil"]) != expiry_s
        or "token_settlement" in quote
        or native.get("settlement_semantics") != "gross-inclusive"
        or int(native.get("creator_wei", -1)) != 0
        or treasury != gross // 100
        or int(native.get("merchant_wei", -1)) != gross - treasury
    ):
        raise Aifp1QuoteError("signed v1.4 call disagrees with the requested merchant, debit or expiry")
    amount_usd = _micro_usd(quote.get("amount")) / 1e6
    debit_usd = gross / 1e18 * native_usd
    if (
        not _sane(native_usd, native_asset)
        or debit_usd <= 0
        or abs(debit_usd - amount_usd) > max(0.02 * amount_usd, 1e-6)
    ):
        raise Aifp1QuoteError("native debit disagrees with the independent USD price")
    return max(amount_usd, debit_usd)


def validate_solana_quote(quote, asset, payer, expiry_s, native_usd, deployment, historical=False):
    from .settlement_solana_v14 import stable_mint, validate_call

    call = quote.get("settlement_call") or {}
    validate_call(call, deployment, payer, quote["quote_id"], historical=historical)
    q = call["args"]["quote"]
    gross, micro = int(q["grossAmount"]), _micro_usd(quote.get("amount"))
    fee = gross // 100
    s = quote.get("settlement") or {}
    if (
        quote.get("accepted_chains") != ["solana"]
        or quote.get("accepted_assets") != [asset]
        or quote.get("payer") != payer
        or call["asset"] != asset
        or q["merchant"] != _merchant_address(quote, "solana")
        or int(q["validUntil"]) != expiry_s
        or s.get("gross_units") != str(micro)
        or s.get("total_units") != str(micro)
        or s.get("payer_total_units") != str(micro)
        or s.get("protocol_fee_units") != str(micro // 100)
        or s.get("creator_units") != "0"
        or s.get("merchant_units") != str(micro - micro // 100)
        or s.get("settlement_semantics") != "gross-inclusive"
        or not (
            s.get("fee_on_top") is False
            or s.get("fee_on_top")
            == {"provider": str(micro - micro // 100), "treasury": str(micro // 100), "creator": "0"}
        )
        or not _sane(native_usd, "SOL")
    ):
        raise Aifp1QuoteError("Solana USD/payer/merchant/quote binding mismatch")
    amount = Decimal(micro) / Decimal(10**6)
    if asset == "SOL":
        n = quote.get("native_settlement") or {}
        if (
            n.get("asset") != "SOL"
            or n.get("decimals") != 9
            or n.get("settlement_semantics") != "gross-inclusive"
            or n.get("total_lamports") != str(gross)
            or n.get("merchant_lamports") != str(gross - fee)
            or n.get("treasury_lamports") != str(fee)
            or n.get("creator_lamports") != "0"
            or "token_settlement" in quote
            or ("valid_until" in n and str(n["valid_until"]) != q["validUntil"])
        ):
            raise Aifp1QuoteError("SOL9 amount/legs mismatch")
        debit = Decimal(gross) / Decimal(10**9) * Decimal(str(native_usd))
        quoted = Decimal(gross) / Decimal(10**9) * Decimal(n["rate_usd"])
        tolerance = max(amount * Decimal(".02"), Decimal(".000001"))
        if debit <= 0 or quoted <= 0 or abs(debit - amount) > tolerance or abs(quoted - amount) > tolerance:
            raise Aifp1QuoteError("SOL gross disagrees with independent/quoted USD price")
        amount = max(amount, debit)
    else:
        t = quote.get("token_settlement") or {}
        if (
            "native_settlement" in quote
            or gross != micro
            or t.get("asset") != asset
            or t.get("token") != stable_mint(deployment["network"], asset)
            or t.get("decimals") != 6
            or t.get("settlement_semantics") != "gross-inclusive"
            or t.get("total_units") != str(gross)
            or t.get("merchant_units") != str(gross - fee)
            or t.get("protocol_fee_units") != str(fee)
            or t.get("creator_units") != "0"
        ):
            raise Aifp1QuoteError("SPL6 exact token amount/legs mismatch")
    return float((amount * Decimal(10**6)).to_integral_value(rounding=ROUND_CEILING) / Decimal(10**6))


# ── Receipts ────────────────────────────────────────────────────────────────


def _b64url(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def verify_paid_receipt(
    paid: Dict[str, Any],
    quote: Dict[str, Any],
    asset: str,
    tx_ref: str,
    payer: str,
    issuer: str,
    session: requests.Session,
    chain: str = "polygon",
) -> None:
    """Ed25519 JWT from the configured issuer's JWKS, bound to this exact purchase."""

    def reject():
        raise Aifp1Error("invalid payment receipt")

    token = paid.get("receipt")
    if not isinstance(token, str) or len(token) > 32768 or token.count(".") != 2:
        reject()
    header_part, payload_part, sig_part = token.split(".")
    try:
        header = json.loads(_b64url(header_part))
        claims = json.loads(_b64url(payload_part))
        signature = _b64url(sig_part)
    except Exception:  # noqa: BLE001
        reject()
    if (
        header.get("alg") != "EdDSA"
        or header.get("typ") != "JWT"
        or not isinstance(header.get("kid"), str)
        or "crit" in header
    ):
        reject()
    r = session.get(issuer.rstrip("/") + "/.well-known/jwks.json", timeout=15, allow_redirects=False)
    if not r.ok:
        reject()
    keys = [
        k
        for k in (r.json().get("keys") or [])
        if k.get("kid") == header["kid"]
        and k.get("kty") == "OKP"
        and k.get("crv") == "Ed25519"
        and "d" not in k
        and k.get("alg") in (None, "EdDSA")
        and k.get("use") in (None, "sig")
        and ("key_ops" not in k or "verify" in (k.get("key_ops") or []))
    ]
    if len(keys) != 1:
        reject()
    try:
        nacl.signing.VerifyKey(_b64url(keys[0]["x"])).verify(f"{header_part}.{payload_part}".encode(), signature)
    except (nacl.exceptions.BadSignatureError, ValueError, KeyError):
        reject()
    now = int(time.time())
    try:
        paid_exp = _iso_to_unix(paid.get("expires_at"))
        amounts_match = Decimal(str(claims.get("amount"))) == Decimal(str(quote.get("amount"))) and Decimal(
            str(paid.get("amount"))
        ) == Decimal(str(claims.get("amount")))
    except (InvalidOperation, ValueError, TypeError):
        reject()
    if (
        claims.get("iss") != issuer
        or claims.get("aud") != quote["merchant_id"]
        or (
            str(claims.get("sub", "")) != payer
            if chain == "solana"
            else str(claims.get("sub", "")).lower() != payer.lower()
        )
        or claims.get("tx_ref") != tx_ref
        or claims.get("scope") != quote.get("scope")
        or claims.get("resource") != quote.get("resource")
        or claims.get("chain") != chain
        or (
            chain == "solana"
            and (
                claims.get("network") != quote["settlement_call"]["network"]
                or claims.get("program") != quote["settlement_call"]["contract"]
                or paid.get("network") != claims.get("network")
                or paid.get("program") != claims.get("program")
            )
        )
        or not isinstance(claims.get("asset"), str)
        or claims["asset"].upper() != asset.upper()
        or claims.get("currency") != "USD"
        or (claims.get("network_mode") or "live") != (quote.get("network_mode") or "live")
        or not amounts_match
        or claims.get("unit_quota") != quote.get("unit_quota")
        or not isinstance(claims.get("exp"), int)
        or claims["exp"] <= now
        or ("nbf" in claims and (not isinstance(claims["nbf"], int) or claims["nbf"] > now))
        or not isinstance(claims.get("iat"), int)
        or claims["iat"] > now + 30
        or not claims.get("receipt_id")
        or paid.get("receipt_id") != claims["receipt_id"]
        or paid.get("merchant_id") != claims["aud"]
        or paid.get("tx_ref") != claims["tx_ref"]
        or paid.get("scope") != claims["scope"]
        or paid.get("resource") != claims["resource"]
        or paid.get("unit_quota") != claims["unit_quota"]
        or paid.get("chain") != claims["chain"]
        or paid.get("asset") != claims["asset"]
        or paid.get("currency") != claims["currency"]
        or paid_exp != claims["exp"]
    ):
        reject()


def submit_payment(
    session: requests.Session,
    account: Any,
    recovery: Dict[str, Any],
    agent_id: Optional[str] = None,
    confirm_s: float = 60.0,
    sleep: Callable[[float], None] = time.sleep,
) -> Dict[str, Any]:
    """POST /v1/pay (idempotent), retrying 425/503 until confirmed; verify the receipt."""
    quote, tx_ref, asset = recovery["quote"], recovery["tx_ref"], recovery["asset"]
    api_base, issuer = recovery["api_base"].rstrip("/"), recovery["issuer"]
    # Older Polygon journals did not store a chain. Never derive authorization
    # from a mutable server quote when resuming a purchase.
    chain = recovery.get("chain", "polygon")
    native_asset = _native_asset(chain)
    call = quote.get("settlement_call") or {}
    signed = (call.get("args") or {}).get("quote") or {}
    if (
        call.get("chain") != chain
        or quote.get("accepted_chains") != [chain]
        or call.get("asset") != asset
        or quote.get("accepted_assets") != [asset]
        or (
            signed.get("payer") != account.address
            if chain == "solana"
            else str(signed.get("payer", "")).lower() != account.address.lower()
        )
        or (
            signed.get("merchant") != _merchant_address(quote, chain)
            if chain == "solana"
            else str(signed.get("merchant", "")).lower() != _merchant_address(quote, chain).lower()
        )
    ):
        raise Aifp1QuoteError("recovery chain or asset disagrees with the original purchase")
    if chain == "solana":
        from .settlement_solana_v14 import assert_prepared_recovery, inventory

        p = recovery.get("solana") or {}
        network = p.get("network")
        if recovery.get("family") != "solana" or recovery["tx_ref"] != p.get("hash"):
            raise Aifp1QuoteError("Solana recovery requires original family/signature")
        d = inventory("prod" if network == "mainnet" else "dev", network)
        assert_prepared_recovery(call, p, d, account.address, quote["quote_id"])
    elif asset != native_asset:
        token = _pinned_stable(asset, chain)
        if str(signed.get("token", "")).lower() != token.lower():
            raise Aifp1QuoteError("recovery token disagrees with the original purchase")
    elif (quote.get("native_settlement") or {}).get("asset") != native_asset or signed.get(
        "token"
    ) != "0x0000000000000000000000000000000000000000":
        raise Aifp1QuoteError("recovery native asset disagrees with the original purchase")
    idem = idempotency_key_for(quote["quote_id"], chain, asset, tx_ref)
    payer = account.address if chain == "solana" else account.address.lower()
    deadline = time.time() + confirm_s
    attempt = 0

    def failure(message):
        return Aifp1PayError(message, tx_ref, quote["quote_id"], recovery)

    while True:
        if attempt > 0 and time.time() >= deadline:
            raise failure("payment confirmation deadline elapsed; recover the existing transaction")
        expires_at = int(time.time()) + 240
        message = payment_authorization_message(quote, issuer, chain, tx_ref, asset, idem, payer, expires_at)
        if chain == "solana":
            signature = account.sign_authorization(message)
        else:
            signature = account.sign_message(encode_defunct(text=message)).signature.hex()
            signature = signature if signature.startswith("0x") else "0x" + signature
        try:
            r = session.post(
                f"{api_base}/v1/pay",
                headers={"Idempotency-Key": idem, **({"AIFP-Agent-Id": agent_id} if agent_id else {})},
                json={
                    "quote_id": quote["quote_id"],
                    "chain": chain,
                    "asset": asset,
                    "tx_ref": tx_ref,
                    **({"agent_id": agent_id} if agent_id else {}),
                    "payment_authorization": {"payer": payer, "expires_at": expires_at, "signature": signature},
                },
                timeout=15,
                allow_redirects=False,
            )
        except requests.RequestException as e:
            if time.time() >= deadline:
                raise failure(f"POST /v1/pay failed after settling: {type(e).__name__}")
            sleep(min(2**attempt, 8))
            attempt += 1
            continue
        if r.ok:
            paid = r.json()
            if not paid.get("receipt"):
                raise failure("/v1/pay returned no receipt after settlement")
            try:
                verify_paid_receipt(paid, quote, asset, tx_ref, payer, issuer, session, chain)
            except Aifp1Error:
                raise failure("receipt signature or purchase binding could not be verified; recover the payment")
            return paid
        if r.status_code not in (425, 503) or time.time() >= deadline:
            raise failure(f"POST /v1/pay → {r.status_code} after on-chain settlement {tx_ref}")
        sleep(min(2**attempt, 8))
        attempt += 1


# ── Budget ──────────────────────────────────────────────────────────────────


def _durable_directory(path: str) -> None:
    """Persist each newly created private directory and its parent entry."""
    directory = os.path.abspath(path)
    missing = []
    while not os.path.exists(directory):
        missing.append(directory)
        directory = os.path.dirname(directory)
    for created in reversed(missing):
        try:
            os.mkdir(created, mode=0o700)
        except FileExistsError:
            if not os.path.isdir(created):
                raise
    # Existing entries may come from a concurrent creator or an earlier failed
    # sync. Persist the ancestry too; existence alone is not durable evidence.
    directory = os.path.abspath(path)
    while True:
        fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(fd)
        finally:
            os.close(fd)
        parent = os.path.dirname(directory)
        if parent == directory:
            break
        directory = parent


def _write_private_json(path: str, data: Dict[str, Any]) -> None:
    """Durably replace an owner-only JSON file; callers hold the budget lock."""
    directory = os.path.dirname(os.path.abspath(path))
    fd, temporary = tempfile.mkstemp(prefix=f".{os.path.basename(path)}.", suffix=".tmp", dir=directory)
    try:
        with os.fdopen(fd, "w") as f:
            json.dump(data, f, allow_nan=False)
            f.flush()
            os.fsync(f.fileno())
        os.replace(temporary, path)
        directory_fd = os.open(directory, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
        try:
            os.fsync(directory_fd)
        finally:
            os.close(directory_fd)
    finally:
        with contextlib.suppress(FileNotFoundError):
            os.unlink(temporary)


def _budget_binding(
    quote: Dict[str, Any],
    payer: str,
    chain: str,
    asset: str,
    api_base: str,
    issuer: str,
    wallet_identity: _OptionalStr = None,
    solana_admission_rate_usd=None,
    solana_max_fee_lamports=None,
    solana_transaction_fee_lamports=None,
) -> Dict[str, str]:
    signed = quote["settlement_call"]["args"]["quote"]
    return {
        "api_base": api_base.rstrip("/"),
        "issuer": issuer,
        "payer": payer if chain == "solana" else payer.lower(),
        **({"wallet_identity": wallet_identity} if wallet_identity else {}),
        **(
            {
                "solana_admission_rate_usd": solana_admission_rate_usd,
                "solana_max_fee_lamports": solana_max_fee_lamports,
                "solana_transaction_fee_lamports": solana_transaction_fee_lamports,
            }
            if solana_admission_rate_usd is not None
            else {}
        ),
        "merchant_id": quote["merchant_id"],
        "scope": quote["scope"],
        "resource": quote["resource"],
        "network_mode": quote.get("network_mode") or "live",
        "chain": (
            f"solana:{quote['settlement_call']['network']}:{quote['settlement_call']['contract']}:{quote['settlement_call']['idl_sha256']}"
            if chain == "solana"
            else chain
        ),
        "asset": asset,
        "token": signed["token"] if chain == "solana" else signed["token"].lower(),
        "gross_amount": signed["grossAmount"],
        "quote_id": quote["quote_id"],
    }


def _prepared_hash(serialized: str) -> str:
    try:
        if not isinstance(serialized, str) or not serialized.startswith("0x"):
            raise ValueError()
        raw = bytes.fromhex(serialized[2:])
        if not raw:
            raise ValueError()
        return "0x" + keccak(raw).hex()
    except ValueError:
        raise Aifp1QuoteError("recovery transaction is not a serialized signed transaction") from None


class SpendLedger:
    """Atomic reserve/confirm/release across processes sharing one local journal.

    Unknown broadcasts do not expire. Confirmed debits follow the 24-hour
    window, but an unresolved receipt retains its purchase guard. ``check``
    is advisory; a payment must use ``reserve`` before signing. ``record``
    remains available for recording legacy actual debits, not authorization.
    """

    def __init__(self, per_payment_usd: Optional[float], daily_usd: Optional[float], path: Optional[str] = None):
        # Both absent is a reconciliation-only view, never payment authorization.
        if (per_payment_usd, daily_usd) != (None, None) and not all(
            self._positive(v) for v in (per_payment_usd, daily_usd)
        ):
            raise ValueError("spending limits must be finite and positive")
        self.per_payment_usd = per_payment_usd
        self.daily_usd = daily_usd
        self.path = os.path.abspath(path) if path else None
        self._lock = threading.RLock()
        self._memory: Dict[str, Any] = {"version": 3, "spend": [], "reservations": [], "quote_admissions": []}
        self.spend: List[Dict[str, float]] = []
        with self._state():
            pass  # Validate existing state without resetting malformed/unknown data.

    @staticmethod
    def _positive(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0

    @staticmethod
    def _valid_binding(binding: Any) -> bool:
        fields = {
            "api_base",
            "issuer",
            "payer",
            "merchant_id",
            "scope",
            "resource",
            "network_mode",
            "chain",
            "asset",
            "token",
            "gross_amount",
            "quote_id",
        }
        optional = {
            "wallet_identity",
            "solana_admission_rate_usd",
            "solana_max_fee_lamports",
            "solana_transaction_fee_lamports",
            "quote_admission_version",
        }
        if (
            not isinstance(binding, dict)
            or not fields <= set(binding) <= fields | optional
            or not all(isinstance(v, str) and v for v in binding.values())
        ):
            return False
        if "quote_admission_version" in binding and (
            binding["quote_admission_version"] != "1"
            or not binding["chain"].startswith("solana:")
            or binding["gross_amount"] != "0"
            or binding["quote_id"] != "quote-admission"
        ):
            return False
        fee_fields = optional - {"wallet_identity", "quote_admission_version"}
        if not fee_fields.intersection(binding):
            return True
        if not fee_fields <= set(binding) or not binding["chain"].startswith("solana:"):
            return False
        try:
            from .settlement_solana_v14 import _integer, lamport_cost_usd

            lamport_cost_usd(0, binding["solana_admission_rate_usd"])
            return (
                0
                <= _integer(binding["solana_transaction_fee_lamports"])
                <= _integer(binding["solana_max_fee_lamports"])
                and int(binding["solana_max_fee_lamports"]) > 0
            )
        except Exception:
            return False

    def _read(self) -> Dict[str, Any]:
        if not self.path or not os.path.exists(self.path):
            return (
                self._memory
                if not self.path
                else {"version": 3, "spend": [], "reservations": [], "quote_admissions": []}
            )
        try:
            with open(self.path) as f:
                data = json.load(f)
            if not isinstance(data, dict) or (
                "version" in data and (type(data["version"]) is not int or data["version"] not in (2, 3))
            ):
                raise ValueError()
            # The exact old {spend:[{at,usd}]} format migrates without losing entries.
            if "version" not in data and set(data) != {"spend"}:
                raise ValueError()
            if "version" in data and set(data) != (
                {"version", "spend", "reservations", "quote_admissions"}
                if data["version"] == 3
                else {"version", "spend", "reservations"}
            ):
                raise ValueError()
            spend, reservations = data["spend"], data.get("reservations", [])
            if not isinstance(spend, list) or not isinstance(reservations, list):
                raise ValueError()
            for entry in spend + reservations:
                if (
                    not isinstance(entry, dict)
                    or not (
                        self._positive(entry.get("usd"))
                        or (
                            entry.get("failed") is True
                            and type(entry.get("usd")) in (int, float)
                            and entry.get("usd") == 0
                        )
                    )
                    or not self._positive(entry.get("at"))
                ):
                    raise ValueError()
                if "id" in entry and (
                    not isinstance(entry["id"], str) or not entry["id"] or not self._valid_binding(entry.get("binding"))
                ):
                    raise ValueError()
                if "failed" in entry and (
                    entry["failed"] is not True
                    or entry.get("confirmed") is not True
                    or not entry.get("tx_ref")
                    or "solana_admission_rate_usd" not in entry.get("binding", {})
                    or entry in reservations
                ):
                    raise ValueError()
            ids = [e["id"] for e in spend if "id" in e]
            if len(ids) != len(set(ids)):
                raise ValueError()
            reservation_ids = []
            for entry in reservations:
                reservation_ids.append(entry["id"])
                if (
                    not isinstance(entry["purchase_key"], str)
                    or not entry["purchase_key"]
                    or type(entry["confirmed"]) is not bool
                    or (entry["tx_ref"] is not None and not isinstance(entry["tx_ref"], str))
                ):
                    raise ValueError()
                debit = next((e for e in spend if e.get("id") == entry["id"]), None)
                if bool(debit) != entry["confirmed"] or (
                    debit and any(debit.get(k) != entry.get(k) for k in ("usd", "tx_ref", "binding", "purchase_key"))
                ):
                    raise ValueError()
            if len(reservation_ids) != len(set(reservation_ids)):
                raise ValueError()
            admissions = data.get("quote_admissions", [])
            if not isinstance(admissions, list) or any(not self._valid_admission(e) for e in admissions):
                raise ValueError()
            all_ids = reservation_ids + [e["id"] for e in admissions]
            if len(all_ids) != len(set(all_ids)) or any(e["id"] in ids for e in admissions):
                raise ValueError()
            pending_keys = [self._admission_access_key(e["binding"]) for e in admissions if "terminal" not in e]
            pending_keys += [
                self._admission_access_key(e["quote_admission"]["binding"])
                for e in reservations
                if "quote_admission" in e
            ]
            if len(pending_keys) != len(set(pending_keys)):
                raise ValueError()
            for e in reservations + spend:
                if "quote_admission" in e and (
                    not self._valid_admission(e["quote_admission"]) or e["quote_admission"]["id"] != e["id"]
                ):
                    raise ValueError()
            return {"version": 3, "spend": spend, "reservations": reservations, "quote_admissions": admissions}
        except (ValueError, TypeError, KeyError):
            raise Aifp1QuoteError("spending ledger is malformed or unsupported; refusing to reset the budget") from None

    @contextlib.contextmanager
    def _state(self, write: bool = False):
        with self._lock:
            lock_fd = None
            if self.path:
                try:
                    import fcntl
                except ImportError:
                    raise Aifp1QuoteError("durable spending limits require operating-system file locking") from None
                _durable_directory(os.path.dirname(self.path))
                lock_fd = os.open(self.path + ".lock", os.O_WRONLY | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
                try:
                    fcntl.flock(lock_fd, fcntl.LOCK_EX)
                except Exception:
                    os.close(lock_fd)
                    raise
            try:
                data = self._read()
                yield data
                if write and self.path:
                    _write_private_json(self.path, data)
                self.spend = data["spend"]
            finally:
                if lock_fd is not None:
                    os.close(lock_fd)  # Kernel releases the lock even after process death.

    @staticmethod
    def _total(data: Dict[str, Any]) -> Decimal:
        cutoff = time.time() - 86400
        debits = [e["usd"] for e in data["spend"] if e["at"] >= cutoff]
        outstanding = [e["usd"] for e in data["reservations"] if not e["confirmed"]]
        return sum((Decimal(str(v)) for v in debits + outstanding), Decimal(0))

    def _check(self, data: Dict[str, Any], usd: float) -> None:
        if self.per_payment_usd is None or self.daily_usd is None:
            raise Aifp1QuoteError("owner spending limits are required to authorize a new payment")
        if not self._positive(usd):
            raise Aifp1QuoteError("payment cost must be finite and positive")
        if Decimal(str(usd)) > Decimal(str(self.per_payment_usd)):
            raise Aifp1QuoteError(f"batch costs ${usd:.6f}, above the per-payment limit ${self.per_payment_usd}")
        if self._total(data) + Decimal(str(usd)) > Decimal(str(self.daily_usd)):
            raise Aifp1QuoteError("the 24-hour spending limit would be exceeded")

    def spent_24h(self) -> float:
        with self._state() as data:
            return float(self._total(data))

    def check(self, usd: float) -> None:
        with self._state() as data:
            self._check(data, usd)

    @staticmethod
    def _purchase_key(binding):
        return hashlib.sha256(
            json.dumps(
                [
                    binding.get("wallet_identity", binding["payer"]) if k == "payer" else binding[k]
                    for k in ("api_base", "issuer", "payer", "merchant_id", "scope", "resource", "network_mode")
                ],
                separators=(",", ":"),
            ).encode()
        ).hexdigest()

    @classmethod
    def _admission_access_key(cls, binding):
        return cls._purchase_key({**binding, "network_mode": "quote-access"})

    @classmethod
    def _valid_admission(cls, e):
        return (
            isinstance(e, dict)
            and isinstance(e.get("id"), str)
            and bool(e["id"])
            and cls._positive(e.get("at"))
            and cls._valid_binding(e.get("binding"))
            and e["binding"].get("quote_admission_version") == "1"
            and all(
                isinstance(e.get(k), str) and 0 < len(e[k]) <= 65536
                for k in ("owner_context", "request_body", "statement")
            )
            and ("quote_json" not in e or isinstance(e["quote_json"], str) and 0 < len(e["quote_json"]) <= 1048576)
            and ("was_reserved" not in e or e["was_reserved"] is True)
            and ("terminal" not in e or e["terminal"] in ("not-admitted", "expired-unbroadcast"))
        )

    def begin_quote_admission(self, binding, owner_context, create):
        if not self._valid_binding(binding) or binding.get("quote_admission_version") != "1":
            raise Aifp1QuoteError("invalid quote admission binding")
        key = self._purchase_key(binding)
        with self._state(write=True) as data:
            if any(
                e["purchase_key"] == key
                or (
                    e.get("quote_admission")
                    and self._admission_access_key(e["quote_admission"]["binding"])
                    == self._admission_access_key(binding)
                )
                for e in data["reservations"]
            ):
                raise Aifp1QuoteError("unresolved monetary purchase; recover the original payment")
            existing = next(
                (
                    e
                    for e in data["quote_admissions"]
                    if "terminal" not in e
                    and self._admission_access_key(e["binding"]) == self._admission_access_key(binding)
                ),
                None,
            )
            if existing:
                if existing["binding"] != binding or existing["owner_context"] != owner_context:
                    raise Aifp1QuoteError("changed owner context; reconcile the original quote admission")
                return copy.deepcopy(existing)
            request_body, statement = create()
            entry = {
                "id": uuid.uuid4().hex,
                "at": time.time(),
                "binding": dict(binding),
                "owner_context": owner_context,
                "request_body": request_body,
                "statement": statement,
            }
            if not self._valid_admission(entry):
                raise Aifp1QuoteError("malformed quote admission")
            data["quote_admissions"].append(entry)
            return copy.deepcopy(entry)

    @staticmethod
    def _bound_admission(data, admission_id, binding, context):
        e = next((x for x in data["quote_admissions"] if x["id"] == admission_id), None)
        if not e or e["binding"] != binding or e["owner_context"] != context:
            raise Aifp1QuoteError("quote admission phase or owner binding mismatch")
        return e

    def adopt_quote_admission(self, admission_id, binding, context, quote_json):
        with self._state(write=True) as data:
            e = self._bound_admission(data, admission_id, binding, context)
            if "terminal" in e or ("quote_json" in e and e["quote_json"] != quote_json):
                raise Aifp1QuoteError("original quote admission is immutable")
            e["quote_json"] = quote_json
            if not self._valid_admission(e):
                raise Aifp1QuoteError("malformed adopted quote")

    def close_quote_admission(self, admission_id, binding, context, terminal, quote_json=None):
        with self._state(write=True) as data:
            e = self._bound_admission(data, admission_id, binding, context)
            if e.get("terminal") == terminal and e.get("quote_json") == quote_json:
                return
            if (
                "terminal" in e
                or e.get("was_reserved")
                or e.get("quote_json") != quote_json
                or (terminal == "not-admitted" and quote_json is not None)
                or (terminal == "expired-unbroadcast" and not quote_json)
                or terminal not in ("not-admitted", "expired-unbroadcast")
            ):
                raise Aifp1QuoteError("ambiguous admission cannot be closed without original nonbroadcast evidence")
            e["terminal"] = terminal

    def reserve(self, usd: float, binding: Dict[str, str], admission_id=None) -> str:
        if not self._valid_binding(binding) or "quote_admission_version" in binding:
            raise Aifp1QuoteError("a spending reservation requires the exact authorized purchase binding")
        purchase_key = self._purchase_key(binding)
        with self._state(write=True) as data:
            admission = (
                next((e for e in data["quote_admissions"] if e["id"] == admission_id), None) if admission_id else None
            )
            if admission_id and (
                not admission
                or "terminal" in admission
                or not admission.get("quote_json")
                or self._purchase_key(admission["binding"]) != purchase_key
                or any(
                    admission["binding"].get(k) != binding.get(k)
                    for k in ("payer", "chain", "asset", "token", "wallet_identity")
                )
                or json.loads(admission["quote_json"]).get("quote_id") != binding["quote_id"]
            ):
                raise Aifp1QuoteError("monetary reservation disagrees with durable quote admission")
            if any(
                e["purchase_key"] == purchase_key
                or (
                    e.get("quote_admission")
                    and self._admission_access_key(e["quote_admission"]["binding"])
                    == self._admission_access_key(binding)
                )
                for e in data["reservations"]
            ) or any(
                e["id"] != admission_id
                and "terminal" not in e
                and self._admission_access_key(e["binding"]) == self._admission_access_key(binding)
                for e in data["quote_admissions"]
            ):
                raise Aifp1QuoteError("this purchase is unresolved; recover the journaled payment before buying again")
            self._check(data, usd)
            reservation_id = admission_id or uuid.uuid4().hex
            data["reservations"].append(
                {
                    "id": reservation_id,
                    "at": time.time(),
                    "usd": usd,
                    "binding": dict(binding),
                    "purchase_key": purchase_key,
                    "tx_ref": None,
                    "confirmed": False,
                    **({"quote_admission": {**copy.deepcopy(admission), "was_reserved": True}} if admission else {}),
                }
            )
            if admission:
                data["quote_admissions"] = [e for e in data["quote_admissions"] if e["id"] != admission_id]
            return reservation_id

    def prepared(self, reservation_id: str, tx_ref: str, binding: Dict[str, str]) -> None:
        with self._state(write=True) as data:
            entry = next((e for e in data["reservations"] if e["id"] == reservation_id), None)
            if not entry or entry["binding"] != binding or entry["tx_ref"] not in (None, tx_ref):
                raise Aifp1QuoteError("prepared transaction disagrees with its spending reservation")
            entry["tx_ref"] = tx_ref

    def assert_recovery(self, reservation_id: str, tx_ref: str, binding: Dict[str, str]) -> None:
        with self._state() as data:
            self._bound_entry(data, reservation_id, tx_ref, binding, allow_failure=True)

    @staticmethod
    def _bound_entry(
        data: Dict[str, Any], reservation_id: str, tx_ref: str, binding: Dict[str, str], allow_failure=False
    ) -> Dict[str, Any]:
        original = next((e for e in data["reservations"] if e["id"] == reservation_id), None) or next(
            (e for e in data["spend"] if e.get("id") == reservation_id), None
        )
        if (
            not original
            or (original.get("failed") and not allow_failure)
            or original.get("binding") != binding
            or original.get("tx_ref") != tx_ref
        ):
            raise Aifp1QuoteError("receipt recovery disagrees with its spending reservation")
        return original

    def confirm(self, reservation_id: str, tx_ref: str, binding: Dict[str, str], *, complete: bool = False) -> None:
        with self._state(write=True) as data:
            entry = next((e for e in data["reservations"] if e["id"] == reservation_id), None)
            debit = next((e for e in data["spend"] if e.get("id") == reservation_id), None)
            self._bound_entry(data, reservation_id, tx_ref, binding)
            if not debit:
                data["spend"].append({**entry, "at": time.time(), "confirmed": True})
            if entry:
                entry["confirmed"] = True
            if complete:
                data["reservations"] = [e for e in data["reservations"] if e["id"] != reservation_id]

    def finalize_failure(self, reservation_id, tx_ref, binding, fee_usd):
        """Only the canonical-proof caller uses this atomic fee-only terminal transition."""
        with self._state(write=True) as data:
            original = self._bound_entry(data, reservation_id, tx_ref, binding, allow_failure=True)
            if (
                not self._valid_binding(binding)
                or "solana_admission_rate_usd" not in binding
                or type(fee_usd) not in (int, float)
                or not math.isfinite(fee_usd)
                or fee_usd < 0
                or Decimal(str(fee_usd)) > Decimal(str(original["usd"]))
            ):
                raise Aifp1QuoteError("finalized failure disagrees with the original reservation")
            if original.get("failed"):
                if original["usd"] != fee_usd:
                    raise Aifp1QuoteError("finalized failure debit is immutable")
                return
            if original.get("confirmed") or any(e.get("id") == reservation_id for e in data["spend"]):
                raise Aifp1QuoteError("confirmed successful payment cannot become a failed debit")
            # Preserve admission time: proof arriving days later must not revive
            # the original fee as spending in a new daily window.
            data["spend"].append({**original, "usd": fee_usd, "confirmed": True, "failed": True})
            data["reservations"] = [e for e in data["reservations"] if e["id"] != reservation_id]

    def release(self, reservation_id: str) -> None:
        with self._state(write=True) as data:
            if any(e.get("id") == reservation_id for e in data["spend"]):
                raise Aifp1QuoteError("a confirmed payment debit cannot be released")
            original = next((e for e in data["reservations"] if e["id"] == reservation_id), None)
            if original and "quote_admission" in original:
                data["quote_admissions"].append(copy.deepcopy(original["quote_admission"]))
            data["reservations"] = [e for e in data["reservations"] if e["id"] != reservation_id]

    def record(self, usd: float) -> None:
        if not self._positive(usd):
            raise Aifp1QuoteError("recorded spending must be finite and positive")
        with self._state(write=True) as data:
            data["spend"].append({"at": time.time(), "usd": usd})


# ── The purchase ────────────────────────────────────────────────────────────


def _origin(url: str) -> str:
    p = urlsplit(url)
    return f"{p.scheme}://{p.netloc}"


def aifp1_fetch(
    url: str,
    *,
    session: requests.Session,
    account: Any,
    client: Any,
    polygon_rpc: str,
    allowed_origins: List[str],
    ledger: SpendLedger,
    max_gas_wei: _OptionalInt,
    on_prepared: Callable[[Dict[str, Any]], None],
    receipts: Dict[str, List[Dict[str, Any]]],
    asset: str | None = None,
    chain: Optional[str] = None,
    scope: str = "prefix",
    api_base: str = DEFAULT_API_BASE,
    issuer: str = DEFAULT_API_BASE,
    units: Optional[int] = None,
    agent_id: Optional[str] = None,
    solana_network: _OptionalStr = None,
    environment: _OptionalStr = None,
    max_fee_lamports: _OptionalInt = None,
    wallet_identity: _OptionalStr = None,
) -> requests.Response:
    """GET ``url``; on an AIFP-1 402 buy one batch and retry with its receipt.

    ``receipts`` maps merchant_id → receipts bought from it; one that covers the
    challenged resource is tried before anything new is bought. ``scope`` is
    "prefix" by default for the same reason as in Node: an "exact" batch per URL
    costs the $0.10 floor and a transaction for every distinct page.
    """
    requested_chain = chain
    chain = "polygon" if chain is None else chain
    native_asset = _native_asset(chain)
    asset = native_asset if asset is None else asset
    stable = asset != native_asset
    sol = chain == "solana"
    deployment = None
    if sol:
        from .settlement_solana_v14 import authorized_inventory, stable_mint

        deployment = authorized_inventory(environment, solana_network)
        if type(max_fee_lamports) is not int or max_fee_lamports <= 0:
            raise Aifp1QuoteError("explicit positive max_fee_lamports fee plus rent budget required")
        if stable:
            stable_mint(solana_network, asset)
    elif stable:
        _pinned_stable(asset, chain)
    if scope not in ("exact", "prefix", "merchant"):
        raise Aifp1QuoteError(f"unknown scope {scope!r}")
    if not url.startswith("https://") or _origin(url) not in allowed_origins:
        raise Aifp1QuoteError("the URL must use an owner-approved exact HTTPS origin")
    response = session.get(url, timeout=30, allow_redirects=False)
    if response.status_code != 402:
        return response
    try:
        challenge = response.json()
    except ValueError:
        return response
    merchant_id, resource = challenge.get("merchant_id"), challenge.get("resource")
    if challenge.get("protocol") != "AIFP-1" or not merchant_id or not resource:
        return response  # not an AIFP-1 challenge; never fall through to another protocol
    held = receipts.setdefault(merchant_id, [])
    held[:] = [e for e in held if e["expires_at"] > time.time()]
    for cached in list(held):
        if not scope_covers(cached["scope"], cached["resource"], resource):
            continue
        retry = session.get(url, headers={"AIFP-Receipt": cached["jwt"]}, timeout=30, allow_redirects=False)
        if retry.status_code != 402:
            return retry
        held.remove(cached)  # spent or revoked; buy a new batch
    if scope == "merchant":
        want_resource = "*"
    elif scope == "prefix":
        want_resource = prefix_hint(resource)
    else:
        want_resource = resource

    quote_body = {
        "merchant_id": merchant_id,
        "payer": account.address,
        "scope": scope,
        **({} if scope == "merchant" else {"resource": want_resource}),
        "units": units or default_units_for(challenge),
        **({"agent_id": agent_id} if agent_id else {}),
        "asset": asset,
        **({"settlement_chain": chain} if requested_chain is not None else {}),
    }
    admission = None
    admission_binding = None
    admission_context = None
    if sol:
        import base58

        from .settlement_solana_v14 import ZERO, stable_mint

        admission_binding = {
            "api_base": api_base.rstrip("/"),
            "issuer": issuer,
            "payer": account.address,
            "merchant_id": merchant_id,
            "scope": scope,
            "resource": want_resource,
            "network_mode": "test" if solana_network == "devnet" else "live",
            "chain": f"solana:{solana_network}:{deployment['programId']}:{deployment['idl']['sha256']}",
            "asset": asset,
            "token": stable_mint(solana_network, asset) if stable else ZERO,
            "gross_amount": "0",
            "quote_id": "quote-admission",
            "quote_admission_version": "1",
            **({"wallet_identity": wallet_identity} if wallet_identity else {}),
        }
        admission_context = json.dumps(
            [
                polygon_rpc,
                ledger.per_payment_usd,
                ledger.daily_usd,
                environment,
                solana_network,
                deployment["programId"],
                deployment["idl"]["sha256"],
                max_fee_lamports,
                _origin(url),
                {**quote_body, "units": units},
            ],
            separators=(",", ":"),
            ensure_ascii=False,
        )

        def create_admission():
            authorization = {
                "payer": account.address,
                "network": solana_network,
                "network_mode": admission_binding["network_mode"],
                "nonce": os.urandom(32).hex(),
                "expires_at": int(time.time()) + 240,
            }
            statement = solana_quote_authorization_message(quote_body, authorization, issuer)
            authorization["signature"] = account.sign_authorization(statement)
            return (
                json.dumps(
                    {**quote_body, "quote_authorization": authorization}, separators=(",", ":"), ensure_ascii=False
                ),
                statement,
            )

        admission = ledger.begin_quote_admission(admission_binding, admission_context, create_admission)
        try:
            stored = json.loads(admission["request_body"])
            authorization = stored["quote_authorization"]
            expected = {**quote_body, **({"units": stored["units"]} if units is None else {})}
            original_body = {k: v for k, v in stored.items() if k != "quote_authorization"}
            statement = solana_quote_authorization_message(stored, authorization, issuer)
            if (
                "terminal" in admission
                or original_body != expected
                or type(stored["units"]) is not int
                or stored["units"] <= 0
                or authorization["payer"] != account.address
                or authorization["network"] != solana_network
                or authorization["network_mode"] != admission_binding["network_mode"]
                or not isinstance(authorization["nonce"], str)
                or len(authorization["nonce"]) != 64
                or any(c not in "0123456789abcdef" for c in authorization["nonce"])
                or type(authorization["expires_at"]) is not int
                or authorization["expires_at"] <= 0
                or statement != admission["statement"]
                or base58.b58encode(base58.b58decode(authorization["signature"])).decode() != authorization["signature"]
            ):
                raise ValueError()
            nacl.signing.VerifyKey(base58.b58decode(account.address)).verify(
                statement.encode(), base58.b58decode(authorization["signature"])
            )
        except Exception:
            raise Aifp1QuoteError("stored quote admission does not match the exact owner-authorized request") from None

    if admission and "quote_json" in admission:
        quote = json.loads(admission["quote_json"])
    else:
        r = session.post(
            f"{api_base.rstrip('/')}/v1/quote",
            **(
                {"data": admission["request_body"], "headers": {"content-type": "application/json"}}
                if admission
                else {"json": quote_body}
            ),
            timeout=15,
            allow_redirects=False,
        )
        if not r.ok:
            if sol and r.status_code == 410:
                try:
                    detail = r.json()
                    not_admitted = (
                        detail.get("error") == "AIFP-410-SOLANA"
                        and detail.get("reason") == "solana_quote_authorization_expired"
                        and detail.get("admission_status") == "not_admitted"
                        and authorization["expires_at"] <= int(time.time())
                        and detail.get("authorization_nonce") == authorization["nonce"]
                        and detail.get("authorization_statement_hash")
                        == hashlib.sha256(admission["statement"].encode()).hexdigest()
                        and detail.get("network") == solana_network
                        and detail.get("network_mode") == admission_binding["network_mode"]
                        and detail.get("payer") == account.address
                    )
                except Exception:
                    not_admitted = False
                if not_admitted:
                    ledger.close_quote_admission(admission["id"], admission_binding, admission_context, "not-admitted")
            raise Aifp1QuoteError(f"POST /v1/quote → {r.status_code}: {r.text[:300]}")
        quote = r.json()
        if admission:
            admission["quote_json"] = json.dumps(quote, separators=(",", ":"), ensure_ascii=False)
            ledger.adopt_quote_admission(admission["id"], admission_binding, admission_context, admission["quote_json"])
    auth = quote.get("payment_authorization") or {}
    if (
        quote.get("merchant_id") != merchant_id
        or quote.get("resource") != want_resource
        or quote.get("scope") != scope
        or not scope_covers(scope, want_resource, resource)
        or quote.get("currency") != "USD"
        or (quote.get("network_mode") or "live") != ("test" if sol and solana_network == "devnet" else "live")
        or (
            quote.get("payer")
            and (quote["payer"] != account.address if sol else str(quote["payer"]).lower() != account.address.lower())
        )
        or auth.get("scheme") not in (None, "wallet-signature-v1")
        or auth.get("domain") not in (None, issuer)
        or (type(quote.get("unit_quota")) is not int if sol else not isinstance(quote.get("unit_quota"), int))
        or quote["unit_quota"] <= 0
    ):
        raise Aifp1QuoteError("quote does not match the requested merchant, resource, payer or live USD terms")
    expiry_s = _iso_to_unix(quote["expires_at"])
    if expiry_s <= time.time():
        if sol and admission and not admission.get("was_reserved"):
            from .settlement_solana_v14 import verify_historical_quote

            # This validates the original signed deadline and quote terms; it grants no payment permission.
            validate_solana_quote(
                quote,
                asset,
                account.address,
                expiry_s,
                float((quote.get("native_settlement") or {}).get("rate_usd", 1)),
                deployment,
                historical=True,
            )
            verify_historical_quote(
                quote["settlement_call"],
                rpc=client,
                deployment=deployment,
                payer=account.address,
                order_id=quote["quote_id"],
            )
            ledger.close_quote_admission(
                admission["id"], admission_binding, admission_context, "expired-unbroadcast", admission["quote_json"]
            )
        raise Aifp1QuoteError("quote is expired; no transaction or new quote was submitted")
    sol_plan = None
    if sol:
        from .settlement_solana_v14 import lamport_cost_usd, prepare_settlement

        native_usd, _source = independent_native_usd(session, polygon_rpc, "solana")
        amount_usd = validate_solana_quote(quote, asset, account.address, expiry_s, native_usd, deployment)
        sol_plan = prepare_settlement(
            quote["settlement_call"],
            rpc=client,
            deployment=deployment,
            payer=account.address,
            order_id=quote["quote_id"],
            max_fee_lamports=max_fee_lamports,
        )
        amount_usd += lamport_cost_usd(sol_plan.fee_rent_lamports, str(native_usd))
        paid_asset = asset
    elif stable:
        amount_usd = validate_stable_quote(quote, asset, account.address, expiry_s, chain) / 1e6
        paid_asset = asset
    else:
        native_usd, _source = independent_native_usd(session, polygon_rpc, chain)
        amount_usd = validate_native_quote(quote, account.address, expiry_s, native_usd, chain)
        paid_asset = native_asset
    call = quote["settlement_call"]
    q = call["args"]["quote"]
    binding = _budget_binding(
        quote,
        account.address,
        chain,
        paid_asset,
        api_base,
        issuer,
        wallet_identity,
        str(native_usd) if sol else None,
        str(max_fee_lamports) if sol else None,
        str(sol_plan.transaction_fee_lamports) if sol else None,
    )
    reservation_id = ledger.reserve(amount_usd, binding, admission["id"] if admission else None)
    recovery = {
        "api_base": api_base,
        "issuer": issuer,
        "quote": quote,
        "tx_ref": None,
        "asset": paid_asset,
        "chain": chain,
        "budget_reservation_id": reservation_id,
        **({"budget_binding_version": 2} if wallet_identity else {}),
        **(
            {
                "family": "solana",
                "reserved_amount_usd": amount_usd,
                "admission_sol_usd_price": str(native_usd),
                "max_fee_lamports": str(max_fee_lamports),
                "transaction_fee_lamports": str(sol_plan.transaction_fee_lamports),
            }
            if sol
            else {}
        ),
    }
    prepared = False

    def journal(tx: Dict[str, str]) -> None:
        nonlocal prepared
        if sol:
            from .settlement_solana_v14 import assert_prepared_recovery

            assert_prepared_recovery(call, tx, deployment, account.address, quote["quote_id"])
            recovery["solana"] = tx
        elif _prepared_hash(tx["serialized_transaction"]) != tx["hash"]:
            raise Aifp1QuoteError("prepared transaction hash disagrees with its signed bytes")
        ledger.prepared(reservation_id, tx["hash"], binding)
        recovery["tx_ref"] = tx["hash"]
        on_prepared({**recovery, **({} if sol else {"serialized_transaction": tx["serialized_transaction"]})})
        prepared = True

    try:
        if sol:
            from .settlement_solana_v14 import execute_settlement

            result = execute_settlement(sol_plan, rpc=client, keypair=account.keypair, on_prepared=journal)
        else:
            ctx = V14ExecutionContext(
                client=client,
                account=account,
                order_id=quote["quote_id"],
                expected_merchant=_merchant_address(quote, chain),
                expected_gross_amount=int(q["grossAmount"]),
                max_gas_wei=max_gas_wei,
                on_prepared=journal,
                expected_token=q["token"] if stable else None,
                expected_chain=chain,
            )
            result = execute_v14_settlement(call, ctx)
    except SettlementConfirmationPending as e:
        recovery["tx_ref"] = e.tx_hash
        raise Aifp1PayError(
            "payment broadcast; recover its receipt without paying again", e.tx_hash, quote["quote_id"], recovery
        )
    except Exception as e:
        if sol and prepared:
            from .settlement_solana_v14 import SolanaV14Error, lamport_cost_usd

            if (
                isinstance(e, SolanaV14Error)
                and e.code == "SOLANA_V14_TRANSACTION_REVERTED"
                and e.prepared == recovery["solana"]
                and e.actual_fee_lamports is not None
            ):
                fee_usd = lamport_cost_usd(e.actual_fee_lamports, recovery["admission_sol_usd_price"])
                try:
                    ledger.finalize_failure(reservation_id, recovery["tx_ref"], binding, fee_usd)
                except Exception as error:
                    raise Aifp1PayError(
                        "canonical failure fee journal requires reconciliation",
                        recovery["tx_ref"],
                        quote["quote_id"],
                        recovery,
                    ) from error
                raise Aifp1FinalizedFailureError(recovery, fee_usd, e.actual_fee_lamports) from e
        if not prepared or (isinstance(e, V14SettlementError) and e.code == "V14_TRANSACTION_REVERTED"):
            ledger.release(reservation_id)  # No settlement debit; approval/revert gas has its separate cap.
            raise
        raise Aifp1PayError(
            "settlement outcome unknown; preserve its spending reservation and recover",
            recovery["tx_ref"],
            quote["quote_id"],
            recovery,
        ) from e
    recovery["tx_ref"] = result["hash"]
    try:
        ledger.confirm(reservation_id, result["hash"], binding)
        paid = submit_payment(session, account, recovery, agent_id=agent_id)
        ledger.confirm(reservation_id, result["hash"], binding, complete=True)
    except Aifp1PayError:
        raise
    except Exception as e:
        raise Aifp1PayError(
            "payment settled; recover its receipt and spending journal without paying again",
            result["hash"],
            quote["quote_id"],
            recovery,
        ) from e
    held.append(
        {
            "jwt": paid["receipt"],
            "expires_at": _iso_to_unix(paid["expires_at"]),
            "scope": paid["scope"],
            "resource": paid["resource"],
            "receipt_id": paid["receipt_id"],
            "unit_quota": paid["unit_quota"],
        }
    )
    return session.get(url, headers={"AIFP-Receipt": paid["receipt"]}, timeout=30, allow_redirects=False)
