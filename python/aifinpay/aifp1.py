"""AIFP-1 paid access for Python agents: 402 → quote → v1.4 settlement → receipt.

A port of the paying half of ``node/src/aifp1.ts``. The byte formats the
server checks — the idempotency key, the receipt-authorization message — are
identical to Node's, and the receipt is verified the same way: an Ed25519 JWT
from the configured issuer's JWKS, bound to the exact purchase.

Safety properties kept from Node:

* only owner-listed HTTPS origins are paid;
* the signed call must match the quote (merchant, amount, expiry, asset);
* native POL is priced against an independent POL/USD source, never the quote;
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
import hashlib
import json
import os
import time
from calendar import timegm
from decimal import ROUND_CEILING, Decimal, InvalidOperation
from typing import Any, Callable, Dict, List, Optional, Tuple
from urllib.parse import urlsplit

import nacl.exceptions
import nacl.signing
import requests
from eth_account.messages import encode_defunct

from ._v14_deployments import V14_DEPLOYMENTS
from .settlement_v14 import (
    SettlementConfirmationPending,
    V14ExecutionContext,
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
    """Refused before any budget was reserved or anything was signed."""


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


# ── Independent POL/USD ─────────────────────────────────────────────────────


def _sane(usd: float) -> bool:
    return 0 < usd < 1000


def independent_pol_usd(session: requests.Session, polygon_rpc: str) -> Tuple[float, str]:
    """Chainlink on Polygon over the agent's own RPC, then Coinbase, then CoinGecko."""
    errors = []
    try:
        r = session.post(polygon_rpc, json={
            "jsonrpc": "2.0", "id": 1, "method": "eth_call",
            "params": [{"to": CHAINLINK_POL_USD_POLYGON, "data": "0xfeaf968c"}, "latest"],
        }, timeout=10, allow_redirects=False)
        hexdata = str(r.json().get("result", ""))[2:]
        if r.ok and len(hexdata) >= 64 * 5:
            answer = int(hexdata[64:128], 16)
            updated_at = int(hexdata[192:256], 16)
            usd = answer / 1e8
            if answer < 2**255 and _sane(usd) and time.time() - updated_at <= MAX_FEED_AGE_S:
                return usd, "chainlink-polygon"
        errors.append("chainlink: unusable answer")
    except Exception as e:  # noqa: BLE001 — every failure means "try the next source"
        errors.append(f"chainlink: {type(e).__name__}")
    try:
        r = session.get("https://api.coinbase.com/v2/prices/POL-USD/spot", timeout=10, allow_redirects=False)
        d = r.json().get("data") or {}
        usd = float(d.get("amount"))
        if r.ok and d.get("base") == "POL" and d.get("currency") == "USD" and _sane(usd):
            return usd, "coinbase"
        errors.append("coinbase: invalid response")
    except Exception as e:  # noqa: BLE001
        errors.append(f"coinbase: {type(e).__name__}")
    try:
        r = session.get(
            "https://api.coingecko.com/api/v3/simple/price?ids=polygon-ecosystem-token"
            "&vs_currencies=usd&include_last_updated_at=true",
            timeout=10, allow_redirects=False,
        )
        entry = r.json().get("polygon-ecosystem-token") or {}
        usd = float(entry.get("usd"))
        if r.ok and _sane(usd) and time.time() - int(entry.get("last_updated_at", 0)) <= MAX_FEED_AGE_S:
            return usd, "coingecko"
        errors.append("coingecko: invalid response")
    except Exception as e:  # noqa: BLE001
        errors.append(f"coingecko: {type(e).__name__}")
    raise Aifp1QuoteError("no independent POL/USD price is available (" + "; ".join(errors) + ")")


# ── Quote checks ────────────────────────────────────────────────────────────


def _pinned_stable(asset: str) -> str:
    for a in V14_DEPLOYMENTS["polygon"]["splitter"]["assets"]:
        if a["symbol"] == asset:
            return a["address"]
    raise Aifp1QuoteError(f'asset "{asset}" is not a stablecoin pinned for Polygon v1.4')


def validate_stable_quote(quote: Dict[str, Any], asset: str, payer: str, expiry_s: int) -> int:
    """The signed gross = settlement units = the quoted USD in micro-dollars. Returns it."""
    call = quote.get("settlement_call") or {}
    if call.get("splitter_version") != "1.4":
        raise Aifp1QuoteError("a stablecoin purchase requires a signed v1.4 quote")
    validate_v14_settlement_call(call, order_id=quote["quote_id"], payer=payer)
    q = call["args"]["quote"]
    token = _pinned_stable(asset)
    micro = _micro_usd(quote.get("amount"))
    approval = call.get("approval") or {}
    units = (quote.get("settlement") or {}).get("total_units")
    if (
        call.get("chain") != "polygon"
        or call.get("asset") != asset
        or call.get("route") != "merchant-aifp1"
        or q["token"].lower() != token.lower()
        or "polygon" not in (quote.get("accepted_chains") or [])
        or not (quote.get("pay_to") or {}).get("polygon")
        or q["merchant"].lower() != quote["pay_to"]["polygon"].lower()
        or "native_settlement" in quote
        or quote.get("accepted_assets") != [asset]
        or units is None
        or q["grossAmount"] != str(units)
        or int(q["grossAmount"]) != micro
        or str(approval.get("token", "")).lower() != token.lower()
        or str(approval.get("spender", "")).lower() != call["contract"].lower()
        or str(approval.get("amount")) != q["grossAmount"]
        or int(q["validUntil"]) != expiry_s
    ):
        raise Aifp1QuoteError(
            "signed v1.4 stablecoin call disagrees with the requested asset, merchant, amount, approval or expiry"
        )
    return micro


def validate_native_quote(quote: Dict[str, Any], payer: str, expiry_s: int, pol_usd: float) -> float:
    """Cross-check the POL debit against an independent price; return the USD to budget."""
    call = quote.get("settlement_call") or {}
    if call.get("splitter_version") != "1.4":
        raise Aifp1QuoteError("a native purchase requires a signed v1.4 quote; no legacy fallback")
    validate_v14_settlement_call(call, order_id=quote["quote_id"], payer=payer)
    native = quote.get("native_settlement") or {}
    q = call["args"]["quote"]
    total = str(native.get("total_wei", ""))
    if not total.isdigit() or native.get("asset") != "POL" or native.get("decimals") != 18:
        raise Aifp1QuoteError("quote has no valid native POL debit")
    gross = int(total)
    treasury = int(native.get("treasury_wei", -1))
    if (
        call.get("chain") != "polygon"
        or call.get("asset") != "POL"
        or call.get("route") != "merchant-aifp1"
        or "POL" not in (quote.get("accepted_assets") or [])
        or q["merchant"].lower() != str((quote.get("pay_to") or {}).get("polygon", "")).lower()
        or q["grossAmount"] != total
        or int(q["validUntil"]) != expiry_s
        or native.get("settlement_semantics") != "gross-inclusive"
        or int(native.get("creator_wei", -1)) != 0
        or treasury != gross // 100
        or int(native.get("merchant_wei", -1)) != gross - treasury
    ):
        raise Aifp1QuoteError("signed v1.4 call disagrees with the requested merchant, debit or expiry")
    amount_usd = float(Decimal(str(quote.get("amount"))))
    debit_usd = gross / 1e18 * pol_usd
    if debit_usd <= 0 or abs(debit_usd - amount_usd) > max(0.02 * amount_usd, 1e-6):
        raise Aifp1QuoteError("native debit disagrees with the independent USD price")
    return max(amount_usd, debit_usd)


# ── Receipts ────────────────────────────────────────────────────────────────


def _b64url(part: str) -> bytes:
    return base64.urlsafe_b64decode(part + "=" * (-len(part) % 4))


def verify_paid_receipt(
    paid: Dict[str, Any], quote: Dict[str, Any], asset: str, tx_ref: str, payer: str, issuer: str,
    session: requests.Session,
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
        or claims.get("chain") != "polygon"
        or claims.get("asset") != asset
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
    chain = "polygon"
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
                verify_paid_receipt(paid, quote, asset, tx_ref, payer, issuer, session)
            except Aifp1Error:
                raise failure("receipt signature or purchase binding could not be verified; recover the payment")
            return paid
        if r.status_code not in (425, 503) or time.time() >= deadline:
            raise failure(f"POST /v1/pay → {r.status_code} after on-chain settlement {tx_ref}")
        sleep(min(2**attempt, 8))
        attempt += 1


# ── Budget ──────────────────────────────────────────────────────────────────


class SpendLedger:
    """Per-payment and rolling-24h USD limits, optionally persisted (mode 600)."""

    def __init__(self, per_payment_usd: float, daily_usd: float, path: Optional[str] = None):
        if not (per_payment_usd > 0 and daily_usd > 0):
            raise ValueError("spending limits must be positive")
        self.per_payment_usd = per_payment_usd
        self.daily_usd = daily_usd
        self.path = path
        self.spend: List[Dict[str, float]] = []
        if path and os.path.exists(path):
            with open(path) as f:
                self.spend = json.load(f).get("spend", [])

    def spent_24h(self) -> float:
        cutoff = time.time() - 86400
        return sum(e["usd"] for e in self.spend if e["at"] >= cutoff)

    def check(self, usd: float) -> None:
        if usd > self.per_payment_usd:
            raise Aifp1QuoteError(f"batch costs ${usd:.6f}, above the per-payment limit ${self.per_payment_usd}")
        if self.spent_24h() + usd > self.daily_usd:
            raise Aifp1QuoteError("the 24-hour spending limit would be exceeded")

    def record(self, usd: float) -> None:
        self.spend.append({"at": time.time(), "usd": usd})
        if self.path:
            fd = os.open(self.path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w") as f:
                json.dump({"spend": self.spend[-1000:]}, f)


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
    asset: str = "POL",
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

    stable = asset != "POL"
    if stable:
        _pinned_stable(asset)
    r = session.post(f"{api_base.rstrip('/')}/v1/quote", json={
        "merchant_id": merchant_id, "payer": account.address, "scope": scope,
        **({} if scope == "merchant" else {"resource": want_resource}),
        "units": units or default_units_for(challenge), **({"agent_id": agent_id} if agent_id else {}),
        **({"asset": asset} if stable else {}),
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
        amount_usd = validate_stable_quote(quote, asset, account.address, expiry_s) / 1e6
        paid_asset = asset
    else:
        pol_usd, _source = independent_pol_usd(session, polygon_rpc)
        amount_usd = validate_native_quote(quote, account.address, expiry_s, pol_usd)
        paid_asset = "POL"
    ledger.check(amount_usd)

    call = quote["settlement_call"]
    q = call["args"]["quote"]
    recovery = {"api_base": api_base, "issuer": issuer, "quote": quote, "tx_ref": None, "asset": paid_asset}

    def journal(tx: Dict[str, str]) -> None:
        recovery["tx_ref"] = tx["hash"]
        on_prepared({**recovery, "serialized_transaction": tx["serialized_transaction"]})

    ctx = V14ExecutionContext(
        client=client, account=account, order_id=quote["quote_id"], expected_merchant=quote["pay_to"]["polygon"],
        expected_gross_amount=int(q["grossAmount"]), max_gas_wei=max_gas_wei, on_prepared=journal,
        expected_token=q["token"] if stable else None,
    )
    try:
        result = execute_v14_settlement(call, ctx)
    except SettlementConfirmationPending as e:
        ledger.record(amount_usd)  # treat as spent until reconciled; never pay again
        recovery["tx_ref"] = e.tx_hash
        raise Aifp1PayError("payment broadcast; recover its receipt without paying again",
                            e.tx_hash, quote["quote_id"], recovery)
    ledger.record(amount_usd)
    recovery["tx_ref"] = result["hash"]
    paid = submit_payment(session, account, recovery, agent_id=agent_id)
    held.append({"jwt": paid["receipt"], "expires_at": _iso_to_unix(paid["expires_at"]), "scope": paid["scope"],
                 "resource": paid["resource"], "receipt_id": paid["receipt_id"], "unit_quota": paid["unit_quota"]})
    return session.get(url, headers={"AIFP-Receipt": paid["receipt"]}, timeout=30, allow_redirects=False)
