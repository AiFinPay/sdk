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


def _iso_to_unix(value: str) -> int:
    return timegm(time.strptime(str(value)[:19], "%Y-%m-%dT%H:%M:%S"))


# ── Wire formats (must match Node byte for byte) ────────────────────────────


def idempotency_key_for(quote_id: str, chain: str, asset: str, tx_ref: str) -> str:
    digest = hashlib.sha256(f"aifp1|{quote_id}|{asset}|{chain}|{tx_ref}".encode()).hexdigest()
    return f"aifp1-{digest}"


def payment_authorization_message(
    quote: Dict[str, Any], issuer: str, chain: str, tx_ref: str, asset: str,
    idempotency_key: str, payer: str, expires_at: int,
) -> str:
    # JSON.stringify of an array: no spaces, non-ASCII kept as-is.
    return json.dumps(
        [
            "AiFinPay receipt authorization v1", issuer, quote["quote_id"], quote.get("nonce"),
            quote["merchant_id"], quote.get("network_mode") or "live", chain, tx_ref, asset or "",
            idempotency_key, payer, expires_at,
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
    if chain not in PAYMENT_CHAINS:
        raise Aifp1QuoteError(f"unsupported explicitly selected AIFP-1 chain {chain!r}")
    return PAYMENT_CHAINS[chain]["native"]


def _merchant_address(quote: dict[str, Any], chain: str) -> str:
    pay_to = quote.get("pay_to") or {}
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
            r = session.post(rpc, json={
                "jsonrpc": "2.0", "id": 1, "method": "eth_call",
                "params": [{"to": CHAINLINK_POL_USD_POLYGON, "data": "0xfeaf968c"}, "latest"],
            }, timeout=10, allow_redirects=False)
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
        coin_id = PAYMENT_CHAINS[chain]["coingeckoId"]
        r = session.get(
            f"https://api.coingecko.com/api/v3/simple/price?ids={coin_id}"
            "&vs_currencies=usd&include_last_updated_at=true",
            timeout=10, allow_redirects=False,
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
    quote: Dict[str, Any], asset: str, payer: str, expiry_s: int, chain: str = "polygon",
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
    if (
        (decimals == 18 and metadata is None)
        or ("token_settlement" in quote and (
            not isinstance(metadata, dict)
            or metadata.get("asset") != asset
            or str(metadata.get("token", "")).lower() != token.lower()
            or type(metadata.get("decimals")) is not int or metadata.get("decimals") != decimals
            or metadata.get("settlement_semantics") != "gross-inclusive"
            or metadata.get("total_units") != str(gross)
            or metadata.get("merchant_units") != str(gross - treasury)
            or metadata.get("protocol_fee_units") != str(treasury)
            or metadata.get("creator_units") != "0"
        ))
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
    quote: Dict[str, Any], payer: str, expiry_s: int, native_usd: float, chain: str = "polygon",
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
    if not _sane(native_usd, native_asset) or debit_usd <= 0 or abs(debit_usd - amount_usd) > max(0.02 * amount_usd, 1e-6):
        raise Aifp1QuoteError("native debit disagrees with the independent USD price")
    return max(amount_usd, debit_usd)


# ── Receipts ────────────────────────────────────────────────────────────────


def _b64url(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def verify_paid_receipt(
    paid: Dict[str, Any], quote: Dict[str, Any], asset: str, tx_ref: str, payer: str, issuer: str,
    session: requests.Session, chain: str = "polygon",
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
    if header.get("alg") != "EdDSA" or header.get("typ") != "JWT" or not isinstance(header.get("kid"), str) \
            or "crit" in header:
        reject()
    r = session.get(issuer.rstrip("/") + "/.well-known/jwks.json", timeout=15, allow_redirects=False)
    if not r.ok:
        reject()
    keys = [
        k for k in (r.json().get("keys") or [])
        if k.get("kid") == header["kid"] and k.get("kty") == "OKP" and k.get("crv") == "Ed25519"
        and "d" not in k and k.get("alg") in (None, "EdDSA") and k.get("use") in (None, "sig")
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
        amounts_match = (
            Decimal(str(claims.get("amount"))) == Decimal(str(quote.get("amount")))
            and Decimal(str(paid.get("amount"))) == Decimal(str(claims.get("amount")))
        )
    except (InvalidOperation, ValueError, TypeError):
        reject()
    if (
        claims.get("iss") != issuer
        or claims.get("aud") != quote["merchant_id"]
        or str(claims.get("sub", "")).lower() != payer.lower()
        or claims.get("tx_ref") != tx_ref
        or claims.get("scope") != quote.get("scope")
        or claims.get("resource") != quote.get("resource")
        or claims.get("chain") != chain
        or not isinstance(claims.get("asset"), str) or claims["asset"].upper() != asset.upper()
        or claims.get("currency") != "USD"
        or (claims.get("network_mode") or "live") != "live"
        or not amounts_match
        or claims.get("unit_quota") != quote.get("unit_quota")
        or not isinstance(claims.get("exp"), int) or claims["exp"] <= now
        or ("nbf" in claims and (not isinstance(claims["nbf"], int) or claims["nbf"] > now))
        or not isinstance(claims.get("iat"), int) or claims["iat"] > now + 30
        or not claims.get("receipt_id") or paid.get("receipt_id") != claims["receipt_id"]
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
    session: requests.Session, account: Any, recovery: Dict[str, Any], agent_id: Optional[str] = None,
    confirm_s: float = 60.0, sleep: Callable[[float], None] = time.sleep,
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
        call.get("chain") != chain or quote.get("accepted_chains") != [chain]
        or call.get("asset") != asset or quote.get("accepted_assets") != [asset]
        or str(signed.get("payer", "")).lower() != account.address.lower()
        or str(signed.get("merchant", "")).lower() != _merchant_address(quote, chain).lower()
    ):
        raise Aifp1QuoteError("recovery chain or asset disagrees with the original purchase")
    if asset != native_asset:
        token = _pinned_stable(asset, chain)
        if str(signed.get("token", "")).lower() != token.lower():
            raise Aifp1QuoteError("recovery token disagrees with the original purchase")
    elif ((quote.get("native_settlement") or {}).get("asset") != native_asset
          or signed.get("token") != "0x0000000000000000000000000000000000000000"):
        raise Aifp1QuoteError("recovery native asset disagrees with the original purchase")
    idem = idempotency_key_for(quote["quote_id"], chain, asset, tx_ref)
    payer = account.address.lower()
    deadline = time.time() + confirm_s
    attempt = 0

    def failure(message):
        return Aifp1PayError(message, tx_ref, quote["quote_id"], recovery)

    while True:
        if attempt > 0 and time.time() >= deadline:
            raise failure("payment confirmation deadline elapsed; recover the existing transaction")
        expires_at = int(time.time()) + 240
        message = payment_authorization_message(quote, issuer, chain, tx_ref, asset, idem, payer, expires_at)
        signature = account.sign_message(encode_defunct(text=message)).signature.hex()
        signature = signature if signature.startswith("0x") else "0x" + signature
        try:
            r = session.post(
                f"{api_base}/v1/pay",
                headers={"Idempotency-Key": idem, **({"AIFP-Agent-Id": agent_id} if agent_id else {})},
                json={
                    "quote_id": quote["quote_id"], "chain": chain, "asset": asset, "tx_ref": tx_ref,
                    **({"agent_id": agent_id} if agent_id else {}),
                    "payment_authorization": {"payer": payer, "expires_at": expires_at, "signature": signature},
                },
                timeout=15, allow_redirects=False,
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


def _budget_binding(quote: Dict[str, Any], payer: str, chain: str, asset: str,
                    api_base: str, issuer: str) -> Dict[str, str]:
    signed = quote["settlement_call"]["args"]["quote"]
    return {
        "api_base": api_base.rstrip("/"), "issuer": issuer, "payer": payer.lower(),
        "merchant_id": quote["merchant_id"], "scope": quote["scope"], "resource": quote["resource"],
        "network_mode": quote.get("network_mode") or "live", "chain": chain, "asset": asset,
        "token": signed["token"].lower(), "gross_amount": signed["grossAmount"], "quote_id": quote["quote_id"],
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
        self._memory: Dict[str, Any] = {"version": 2, "spend": [], "reservations": []}
        self.spend: List[Dict[str, float]] = []
        with self._state():
            pass  # Validate existing state without resetting malformed/unknown data.

    @staticmethod
    def _positive(value: Any) -> bool:
        return isinstance(value, (int, float)) and not isinstance(value, bool) and math.isfinite(value) and value > 0

    @staticmethod
    def _valid_binding(binding: Any) -> bool:
        fields = {"api_base", "issuer", "payer", "merchant_id", "scope", "resource", "network_mode",
                  "chain", "asset", "token", "gross_amount", "quote_id"}
        return (isinstance(binding, dict) and set(binding) == fields
                and all(isinstance(v, str) and v for v in binding.values()))

    def _read(self) -> Dict[str, Any]:
        if not self.path or not os.path.exists(self.path):
            return self._memory if not self.path else {"version": 2, "spend": [], "reservations": []}
        try:
            with open(self.path) as f:
                data = json.load(f)
            if (not isinstance(data, dict) or ("version" in data and (
                type(data["version"]) is not int or data["version"] != 2
            ))):
                raise ValueError()
            # The exact old {spend:[{at,usd}]} format migrates without losing entries.
            if "version" not in data and set(data) != {"spend"}:
                raise ValueError()
            if "version" in data and set(data) != {"version", "spend", "reservations"}:
                raise ValueError()
            spend, reservations = data["spend"], data.get("reservations", [])
            if not isinstance(spend, list) or not isinstance(reservations, list):
                raise ValueError()
            for entry in spend + reservations:
                if not isinstance(entry, dict) or not self._positive(entry.get("usd")) or not self._positive(entry.get("at")):
                    raise ValueError()
                if "id" in entry and (not isinstance(entry["id"], str) or not entry["id"]
                                      or not self._valid_binding(entry.get("binding"))):
                    raise ValueError()
            ids = [e["id"] for e in spend if "id" in e]
            if len(ids) != len(set(ids)):
                raise ValueError()
            reservation_ids = []
            for entry in reservations:
                reservation_ids.append(entry["id"])
                if (not isinstance(entry["purchase_key"], str) or not entry["purchase_key"]
                        or type(entry["confirmed"]) is not bool
                        or (entry["tx_ref"] is not None and not isinstance(entry["tx_ref"], str))):
                    raise ValueError()
                debit = next((e for e in spend if e.get("id") == entry["id"]), None)
                if bool(debit) != entry["confirmed"] or (debit and any(
                    debit.get(k) != entry.get(k) for k in ("usd", "tx_ref", "binding", "purchase_key")
                )):
                    raise ValueError()
            if len(reservation_ids) != len(set(reservation_ids)):
                raise ValueError()
            return {"version": 2, "spend": spend, "reservations": reservations}
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

    def reserve(self, usd: float, binding: Dict[str, str]) -> str:
        if not self._valid_binding(binding):
            raise Aifp1QuoteError("a spending reservation requires the exact authorized purchase binding")
        # Chain/token remain in the exact binding. The access key intentionally
        # excludes them: changing rail/asset must not duplicate unresolved access.
        purchase_key = hashlib.sha256(json.dumps(
            [binding[k] for k in ("api_base", "issuer", "payer", "merchant_id", "scope", "resource", "network_mode")],
            separators=(",", ":"),
        ).encode()).hexdigest()
        with self._state(write=True) as data:
            if any(e["purchase_key"] == purchase_key for e in data["reservations"]):
                raise Aifp1QuoteError("this purchase is unresolved; recover the journaled payment before buying again")
            self._check(data, usd)
            reservation_id = uuid.uuid4().hex
            data["reservations"].append({
                "id": reservation_id, "at": time.time(), "usd": usd, "binding": dict(binding),
                "purchase_key": purchase_key, "tx_ref": None, "confirmed": False,
            })
            return reservation_id

    def prepared(self, reservation_id: str, tx_ref: str, binding: Dict[str, str]) -> None:
        with self._state(write=True) as data:
            entry = next((e for e in data["reservations"] if e["id"] == reservation_id), None)
            if not entry or entry["binding"] != binding or entry["tx_ref"] not in (None, tx_ref):
                raise Aifp1QuoteError("prepared transaction disagrees with its spending reservation")
            entry["tx_ref"] = tx_ref

    def assert_recovery(self, reservation_id: str, tx_ref: str, binding: Dict[str, str]) -> None:
        with self._state() as data:
            self._bound_entry(data, reservation_id, tx_ref, binding)

    @staticmethod
    def _bound_entry(data: Dict[str, Any], reservation_id: str, tx_ref: str, binding: Dict[str, str]) -> Dict[str, Any]:
        original = next((e for e in data["reservations"] if e["id"] == reservation_id), None) or next(
            (e for e in data["spend"] if e.get("id") == reservation_id), None
        )
        if not original or original.get("binding") != binding or original.get("tx_ref") != tx_ref:
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

    def release(self, reservation_id: str) -> None:
        with self._state(write=True) as data:
            if any(e.get("id") == reservation_id for e in data["spend"]):
                raise Aifp1QuoteError("a confirmed payment debit cannot be released")
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
    max_gas_wei: int,
    on_prepared: Callable[[Dict[str, Any]], None],
    receipts: Dict[str, List[Dict[str, Any]]],
    asset: str | None = None,
    chain: Optional[str] = None,
    scope: str = "prefix",
    api_base: str = DEFAULT_API_BASE,
    issuer: str = DEFAULT_API_BASE,
    units: Optional[int] = None,
    agent_id: Optional[str] = None,
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
    if stable:
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

    r = session.post(f"{api_base.rstrip('/')}/v1/quote", json={
        "merchant_id": merchant_id, "payer": account.address, "scope": scope,
        **({} if scope == "merchant" else {"resource": want_resource}),
        "units": units or default_units_for(challenge), **({"agent_id": agent_id} if agent_id else {}),
        "asset": asset, **({"settlement_chain": chain} if requested_chain is not None else {}),
    }, timeout=15, allow_redirects=False)
    if not r.ok:
        raise Aifp1QuoteError(f"POST /v1/quote → {r.status_code}: {r.text[:300]}")
    quote = r.json()
    auth = quote.get("payment_authorization") or {}
    if (
        quote.get("merchant_id") != merchant_id
        or quote.get("resource") != want_resource
        or quote.get("scope") != scope
        or not scope_covers(scope, want_resource, resource)
        or quote.get("currency") != "USD"
        or (quote.get("network_mode") or "live") != "live"
        or (quote.get("payer") and str(quote["payer"]).lower() != account.address.lower())
        or auth.get("scheme") not in (None, "wallet-signature-v1")
        or auth.get("domain") not in (None, issuer)
        or not isinstance(quote.get("unit_quota"), int) or quote["unit_quota"] <= 0
    ):
        raise Aifp1QuoteError("quote does not match the requested merchant, resource, payer or live USD terms")
    expiry_s = _iso_to_unix(quote["expires_at"])
    if expiry_s <= time.time():
        raise Aifp1QuoteError("quote is expired")
    if stable:
        amount_usd = validate_stable_quote(quote, asset, account.address, expiry_s, chain) / 1e6
        paid_asset = asset
    else:
        native_usd, _source = independent_native_usd(session, polygon_rpc, chain)
        amount_usd = validate_native_quote(quote, account.address, expiry_s, native_usd, chain)
        paid_asset = native_asset
    call = quote["settlement_call"]
    q = call["args"]["quote"]
    binding = _budget_binding(quote, account.address, chain, paid_asset, api_base, issuer)
    reservation_id = ledger.reserve(amount_usd, binding)
    recovery = {"api_base": api_base, "issuer": issuer, "quote": quote, "tx_ref": None, "asset": paid_asset,
                "chain": chain, "budget_reservation_id": reservation_id}
    prepared = False

    def journal(tx: Dict[str, str]) -> None:
        nonlocal prepared
        if _prepared_hash(tx["serialized_transaction"]) != tx["hash"]:
            raise Aifp1QuoteError("prepared transaction hash disagrees with its signed bytes")
        ledger.prepared(reservation_id, tx["hash"], binding)
        recovery["tx_ref"] = tx["hash"]
        on_prepared({**recovery, "serialized_transaction": tx["serialized_transaction"]})
        prepared = True

    ctx = V14ExecutionContext(
        client=client, account=account, order_id=quote["quote_id"], expected_merchant=_merchant_address(quote, chain),
        expected_gross_amount=int(q["grossAmount"]), max_gas_wei=max_gas_wei, on_prepared=journal,
        expected_token=q["token"] if stable else None, expected_chain=chain,
    )
    try:
        result = execute_v14_settlement(call, ctx)
    except SettlementConfirmationPending as e:
        recovery["tx_ref"] = e.tx_hash
        raise Aifp1PayError("payment broadcast; recover its receipt without paying again",
                            e.tx_hash, quote["quote_id"], recovery)
    except Exception as e:
        if not prepared or (isinstance(e, V14SettlementError) and e.code == "V14_TRANSACTION_REVERTED"):
            ledger.release(reservation_id)  # No settlement debit; approval/revert gas has its separate cap.
            raise
        raise Aifp1PayError("settlement outcome unknown; preserve its spending reservation and recover",
                            recovery["tx_ref"], quote["quote_id"], recovery) from e
    recovery["tx_ref"] = result["hash"]
    try:
        ledger.confirm(reservation_id, result["hash"], binding)
        paid = submit_payment(session, account, recovery, agent_id=agent_id)
        ledger.confirm(reservation_id, result["hash"], binding, complete=True)
    except Aifp1PayError:
        raise
    except Exception as e:
        raise Aifp1PayError("payment settled; recover its receipt and spending journal without paying again",
                            result["hash"], quote["quote_id"], recovery) from e
    held.append({"jwt": paid["receipt"], "expires_at": _iso_to_unix(paid["expires_at"]), "scope": paid["scope"],
                 "resource": paid["resource"], "receipt_id": paid["receipt_id"], "unit_quota": paid["unit_quota"]})
    return session.get(url, headers={"AIFP-Receipt": paid["receipt"]}, timeout=30, allow_redirects=False)
