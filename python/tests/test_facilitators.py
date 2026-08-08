"""Detection + adapter behavior tests. Run: python -m pytest tests/"""
from __future__ import annotations

import base64
import json
from datetime import datetime, timedelta, timezone

import pytest
import requests

from aifinpay import Agent, PayOptions
from aifinpay.errors import (
    FacilitatorNotImplementedError,
    PaymentTooExpensiveError,
    UnsupportedFacilitatorError,
    UntrustedPaymentTargetError,
)
from aifinpay.facilitators.aifinpay import SIGNATURE_SCHEME
from aifinpay.facilitators import (
    AiFinPayFacilitator,
    CoinbaseX402Facilitator,
    detect_facilitator,
)


def _resp(status: int, *, headers=None, body=None, url: str = "") -> requests.Response:
    r = requests.Response()
    r.status_code = status
    r.url = url
    if headers:
        for k, v in headers.items():
            r.headers[k] = v
    if body is not None:
        if isinstance(body, dict):
            r._content = json.dumps(body).encode()
            r.headers["Content-Type"] = "application/json"
        else:
            r._content = body
    else:
        r._content = b""
    return r


# ── detection ────────────────────────────────────────────────────────────


def test_aifinpay_detects_protocol_field():
    resp = _resp(
        402,
        body={
            "error": "Payment Required",
            "protocol": "AiFinPay v5.3",
            "manifesto": "/manifesto.json",
            "treasury_vault": "AnbjcK3uD…",
            "agreement_hash": "27b28e…df19c699",
            "x-nonce": "abc-123",
        },
    )
    assert AiFinPayFacilitator.detect(resp) is True
    assert detect_facilitator(resp).name == "aifinpay"


def test_aifinpay_fallback_fingerprint_without_protocol():
    resp = _resp(
        402,
        body={
            "agreement_hash": "27b28e…df19c699",
            "treasury_vault": "AnbjcK3uD…",
        },
    )
    assert AiFinPayFacilitator.detect(resp) is True


def test_aifinpay_does_not_match_non_402():
    resp = _resp(200, body={"protocol": "AiFinPay v5.3"})
    assert AiFinPayFacilitator.detect(resp) is False


def test_aifinpay_does_not_match_random_402_body():
    resp = _resp(402, body={"error": "pay up"})
    assert AiFinPayFacilitator.detect(resp) is False


def test_coinbase_detects_payment_required_header():
    spec = {"accepts": [{"scheme": "exact", "priceUsd": 0.05}]}
    enc = base64.b64encode(json.dumps(spec).encode()).decode()
    resp = _resp(402, headers={"PAYMENT-REQUIRED": enc})
    assert CoinbaseX402Facilitator.detect(resp) is True
    assert detect_facilitator(resp).name == "coinbase-x402"


def test_unknown_402_raises():
    resp = _resp(402, body={"random": "shape"})
    with pytest.raises(UnsupportedFacilitatorError):
        detect_facilitator(resp)


def test_override_forces_facilitator():
    resp = _resp(402, body={"random": "shape"})
    fac = detect_facilitator(resp, override="aifinpay")
    assert fac.name == "aifinpay"


def test_override_unknown_raises():
    resp = _resp(402)
    with pytest.raises(UnsupportedFacilitatorError):
        detect_facilitator(resp, override="not-a-real-facilitator")


# ── coinbase adapter behavior ────────────────────────────────────────────


def test_coinbase_raises_not_implemented_on_build_auth():
    spec = {"accepts": [{"scheme": "exact", "priceUsd": 0.01}]}
    enc = base64.b64encode(json.dumps(spec).encode()).decode()
    resp = _resp(402, headers={"PAYMENT-REQUIRED": enc})
    agent = Agent.new()
    with pytest.raises(FacilitatorNotImplementedError):
        CoinbaseX402Facilitator().build_auth(resp, agent, PayOptions())


def test_coinbase_budget_cap_blocks_expensive():
    spec = {"accepts": [{"scheme": "exact", "priceUsd": 5.00}]}
    enc = base64.b64encode(json.dumps(spec).encode()).decode()
    resp = _resp(402, headers={"PAYMENT-REQUIRED": enc})
    agent = Agent.new()
    opts = PayOptions(max_amount_usd=0.10)
    with pytest.raises(PaymentTooExpensiveError):
        CoinbaseX402Facilitator().build_auth(resp, agent, opts)


def test_coinbase_malformed_header_raises():
    resp = _resp(402, headers={"PAYMENT-REQUIRED": "not-base64!!"})
    agent = Agent.new()
    with pytest.raises(UnsupportedFacilitatorError):
        CoinbaseX402Facilitator().build_auth(resp, agent, PayOptions())


# ── aifinpay adapter signing / C-8 ──────────────────────────────────────


# The v2 challenge arrives inside the trusted 402 body. There is no /nonce
# endpoint any more, and no generic "sign this nonce" primitive: a signature is
# bound to the agent, the HTTP method, the exact resource, the expiry, the
# minimum value terms and the agreement hash, so it cannot be lifted onto a
# different request. These helpers build a well-formed v2 challenge; each test
# then breaks exactly one thing.

AGREEMENT_HASH = "27b28e" + "a" * 58


def _expiry(seconds: int = 120) -> str:
    return (
        datetime.now(timezone.utc) + timedelta(seconds=seconds)
    ).isoformat().replace("+00:00", "Z")


def _v2_body(*, resource: str = "/paid", expires: str | None = None, **overrides) -> dict:
    body = {
        "protocol": "AiFinPay v5.3",
        "x-nonce": "trusted-nonce",
        "min_usd": "0.01",
        "agreement_hash": AGREEMENT_HASH,
        "signing": {
            "scheme": SIGNATURE_SCHEME,
            "hash": "sha256",
            "message_version": 2,
            "method": "GET",
            "resource": resource,
            "expires": expires or _expiry(),
            "min_usd": "0.01",
            "agreement_hash": AGREEMENT_HASH,
        },
    }
    body.update(overrides)
    return body


def _v2_challenge(url: str = "https://aifinpay.io/paid", **kwargs) -> requests.Response:
    from urllib.parse import urlsplit

    parsed = urlsplit(url)
    resource = parsed.path or "/"
    if parsed.query:
        resource = f"{resource}?{parsed.query}"
    kwargs.setdefault("resource", resource)
    return _resp(402, url=url, body=_v2_body(**kwargs))


def _no_network(monkeypatch, agent):
    """Any HTTP call during build_auth is a bug: v2 signs from the body alone."""

    def fail(*_args, **_kwargs):
        raise AssertionError("build_auth must not make a request")

    monkeypatch.setattr(agent._session, "get", fail)
    monkeypatch.setattr(agent._session, "post", fail)


def test_aifinpay_signature_is_deterministic_for_the_same_bound_challenge(monkeypatch):
    agent = Agent.new()
    _no_network(monkeypatch, agent)
    fac = AiFinPayFacilitator()
    resp = _v2_challenge(expires=_expiry())
    # Same challenge object twice: Ed25519 over a fixed message is
    # deterministic, so a replay of the same terms produces the same signature.
    first = fac.build_auth(resp, agent, PayOptions())["headers"]
    second = fac.build_auth(resp, agent, PayOptions())["headers"]
    assert first["x-signature"] == second["x-signature"]
    assert first["x-nonce"] == "trusted-nonce"
    assert first["x-agent-pubkey"] == agent.address


@pytest.mark.parametrize(
    "field,value",
    [
        ("x-nonce", "different-nonce"),
        ("method", "POST"),
        ("resource", "/other"),
        ("expires", None),
        ("min_usd", "0.02"),
        ("agreement_hash", "9f" + "b" * 62),
        ("agent", None),
    ],
)
def test_aifinpay_signature_covers_every_bound_field(monkeypatch, field, value):
    """Changing any one bound field must change the signature.

    This is the whole point of the v2 envelope: a signature obtained for one
    request must not be replayable as authorisation for a different method,
    resource, price or agreement.
    """
    agent = Agent.new()
    _no_network(monkeypatch, agent)
    fac = AiFinPayFacilitator()
    expires = _expiry()
    baseline = fac.build_auth(
        _v2_challenge(expires=expires), agent, PayOptions()
    )["headers"]["x-signature"]

    if field == "agent":
        other = Agent.new()
        _no_network(monkeypatch, other)
        changed = fac.build_auth(
            _v2_challenge(expires=expires), other, PayOptions()
        )["headers"]["x-signature"]
    elif field == "x-nonce":
        changed = fac.build_auth(
            _v2_challenge(expires=expires, **{"x-nonce": value}), agent, PayOptions()
        )["headers"]["x-signature"]
    elif field == "expires":
        changed = fac.build_auth(
            _v2_challenge(expires=_expiry(180)), agent, PayOptions()
        )["headers"]["x-signature"]
    elif field in ("min_usd", "agreement_hash"):
        # Both copies must move together, or the body/signing cross-check
        # rejects the challenge before signing.
        body = _v2_body(expires=expires)
        body[field] = value
        body["signing"][field] = value
        changed = fac.build_auth(
            _resp(402, url="https://aifinpay.io/paid", body=body), agent, PayOptions()
        )["headers"]["x-signature"]
    else:
        body = _v2_body(expires=expires)
        body["signing"][field] = value
        url = "https://aifinpay.io/other" if field == "resource" else "https://aifinpay.io/paid"
        changed = fac.build_auth(
            _resp(402, url=url, body=body), agent, PayOptions()
        )["headers"]["x-signature"]

    assert changed != baseline


def test_aifinpay_refuses_hostile_origin_before_signing(monkeypatch):
    """Origin is checked first, so a hostile 402 never reaches the signer."""
    agent = Agent.new()
    _no_network(monkeypatch, agent)
    fac = AiFinPayFacilitator(base_url="https://aifinpay.io")

    signed = False
    original = AiFinPayFacilitator._sign_message

    def spy(a, message):
        nonlocal signed
        signed = True
        return original(a, message)

    monkeypatch.setattr(AiFinPayFacilitator, "_sign_message", staticmethod(spy))

    # A complete, otherwise-valid challenge — served by the wrong origin.
    resp = _resp(402, url="https://evil.example/paid", body=_v2_body())
    with pytest.raises(UntrustedPaymentTargetError, match="refusing AiFinPay signature"):
        fac.build_auth(resp, agent, PayOptions())
    assert signed is False


def test_aifinpay_lookalike_origins_are_refused(monkeypatch):
    agent = Agent.new()
    _no_network(monkeypatch, agent)
    fac = AiFinPayFacilitator(base_url="https://aifinpay.io")
    for hostile in (
        "https://aifinpay.io.evil.example/paid",
        "https://evil.example/?x=https://aifinpay.io/paid",
        "http://aifinpay.io/paid",  # scheme downgrade
    ):
        resp = _resp(402, url=hostile, body=_v2_body())
        with pytest.raises(UntrustedPaymentTargetError, match="refusing AiFinPay signature"):
            fac.build_auth(resp, agent, PayOptions())


@pytest.mark.parametrize(
    "mutate,reason",
    [
        (lambda b: b.pop("signing"), "missing bound nonce/signing challenge"),
        (lambda b: b.pop("x-nonce"), "missing bound nonce/signing challenge"),
        (lambda b: b.__setitem__("x-nonce", ""), "missing bound nonce/signing challenge"),
        (lambda b: b["signing"].__setitem__("message_version", 1), "unsupported or legacy signing scheme"),
        (lambda b: b["signing"].pop("scheme"), "unsupported or legacy signing scheme"),
        (lambda b: b["signing"].__setitem__("resource", "/somewhere-else"), "does not match"),
        (lambda b: b["signing"].__setitem__("expires", "not-a-date"), "challenge expiry is invalid"),
        (lambda b: b["signing"].__setitem__("min_usd", "abc"), "challenge value terms are invalid"),
        (lambda b: b["signing"].__setitem__("agreement_hash", "short"), "agreement hash is invalid"),
        (lambda b: b.__setitem__("min_usd", "999.00"), "signing terms disagree with challenge body"),
    ],
)
def test_aifinpay_unbound_or_malformed_challenges_fail_closed(monkeypatch, mutate, reason):
    """A challenge missing or contradicting its binding is refused, not signed.

    Replaces the old test that a legacy in-band nonce was ignored in favour of
    one fetched from /nonce. There is no /nonce fetch to prefer any more, so
    the protection is that an unbound challenge is not signable at all.
    """
    agent = Agent.new()
    _no_network(monkeypatch, agent)
    fac = AiFinPayFacilitator(base_url="https://aifinpay.io")
    body = _v2_body()
    mutate(body)
    resp = _resp(402, url="https://aifinpay.io/paid", body=body)
    with pytest.raises(UntrustedPaymentTargetError, match=reason):
        fac.build_auth(resp, agent, PayOptions())


def test_aifinpay_expired_challenge_is_refused(monkeypatch):
    agent = Agent.new()
    _no_network(monkeypatch, agent)
    fac = AiFinPayFacilitator(base_url="https://aifinpay.io")
    resp = _v2_challenge(expires=_expiry(-1))
    with pytest.raises(UntrustedPaymentTargetError, match="challenge expiry is invalid"):
        fac.build_auth(resp, agent, PayOptions())


def test_aifinpay_redirect_cannot_move_signing_to_an_untrusted_origin(monkeypatch):
    """Replaces the /nonce redirect test.

    The redirect risk moved with the protocol: the challenge is now the
    response body, so what matters is the origin of the response the agent
    ended up on. requests reports the FINAL url after following redirects, so
    a 402 that arrived via a redirect off the trusted origin is refused on the
    same origin check — the signature never follows the redirect.
    """
    agent = Agent.new()
    _no_network(monkeypatch, agent)
    fac = AiFinPayFacilitator(base_url="https://aifinpay.io")

    redirected = _resp(402, url="https://evil.example/paid", body=_v2_body())
    hop = requests.Response()
    hop.status_code = 302
    hop.url = "https://aifinpay.io/paid"
    hop.headers["Location"] = "https://evil.example/paid"
    redirected.history = [hop]

    with pytest.raises(UntrustedPaymentTargetError, match="refusing AiFinPay signature"):
        fac.build_auth(redirected, agent, PayOptions())


# ── agent ergonomics ────────────────────────────────────────────────────


def test_agent_keypair_local_and_roundtrip():
    a = Agent.new()
    addr = a.address
    secret = a.secret_b58
    a2 = Agent.from_secret_b58(secret)
    assert a2.address == addr


# ── pay_with_split / quote_split arg validation ──────────────────────────


def test_quote_split_rejects_unknown_chain():
    a = Agent.new()
    with pytest.raises(Exception):
        a.quote_split(chain="ethereum", merchant_amount=1)


def test_pay_with_split_rejects_unknown_chain():
    a = Agent.new()
    with pytest.raises(Exception):
        a.pay_with_split_invoice(
            chain="bitcoin",
            merchant_wallet="x",
            merchant_amount=100,
            order_id="o",
        )


def test_pay_with_split_rejects_long_order_id():
    a = Agent.new()
    with pytest.raises(Exception):
        a.pay_with_split_invoice(
            chain="solana",
            merchant_wallet="x",
            merchant_amount=100,
            order_id="x" * 65,
        )
