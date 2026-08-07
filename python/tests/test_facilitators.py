"""Detection + adapter behavior tests. Run: python -m pytest tests/"""
from __future__ import annotations

import base64
import json

import pytest
import requests

from aifinpay import Agent, PayOptions
from aifinpay.errors import (
    FacilitatorNotImplementedError,
    PaymentTooExpensiveError,
    UnsupportedFacilitatorError,
    UntrustedPaymentTargetError,
)
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


def test_aifinpay_signature_is_deterministic_for_same_nonce():
    agent = Agent.new()
    fac = AiFinPayFacilitator()
    sig_a = fac._sign_nonce(agent, "abc-123")
    sig_b = fac._sign_nonce(agent, "abc-123")
    assert sig_a == sig_b


def test_aifinpay_signature_changes_with_nonce():
    agent = Agent.new()
    fac = AiFinPayFacilitator()
    sig_a = fac._sign_nonce(agent, "nonce-1")
    sig_b = fac._sign_nonce(agent, "nonce-2")
    assert sig_a != sig_b


def test_aifinpay_refuses_hostile_origin_before_nonce_request(monkeypatch):
    agent = Agent.new()
    fac = AiFinPayFacilitator(base_url="https://aifinpay.io")
    called = False

    def should_not_call(*_args, **_kwargs):
        nonlocal called
        called = True
        raise AssertionError("nonce endpoint must not be called for hostile origin")

    monkeypatch.setattr(agent._session, "get", should_not_call)
    resp = _resp(
        402,
        url="https://evil.example/paid",
        body={"protocol": "AiFinPay v5.3", "x-nonce": "attacker-nonce"},
    )
    with pytest.raises(UntrustedPaymentTargetError, match="refusing legacy AiFinPay signature"):
        fac.build_auth(resp, agent, PayOptions())
    assert called is False


def test_aifinpay_ignores_inband_nonce_and_uses_trusted_nonce(monkeypatch):
    agent = Agent.new()
    fac = AiFinPayFacilitator(base_url="https://aifinpay.io")

    def trusted_nonce(url, **kwargs):
        assert url == "https://aifinpay.io/nonce"
        assert kwargs.get("allow_redirects") is False
        return _resp(200, url=url, body={"nonce": "trusted-nonce"})

    monkeypatch.setattr(agent._session, "get", trusted_nonce)
    resp = _resp(
        402,
        url="https://aifinpay.io/paid",
        body={"protocol": "AiFinPay v5.3", "x-nonce": "attacker-nonce"},
    )
    auth = fac.build_auth(resp, agent, PayOptions())
    assert auth["headers"]["x-nonce"] == "trusted-nonce"
    assert auth["headers"]["x-nonce"] != "attacker-nonce"


def test_aifinpay_nonce_redirect_is_rejected(monkeypatch):
    agent = Agent.new()
    fac = AiFinPayFacilitator(base_url="https://aifinpay.io")

    def redirected(url, **_kwargs):
        return _resp(302, url=url, headers={"Location": "https://evil.example/nonce"})

    monkeypatch.setattr(agent._session, "get", redirected)
    resp = _resp(402, url="https://aifinpay.io/paid", body={"protocol": "AiFinPay v5.3"})
    with pytest.raises(UntrustedPaymentTargetError, match="nonce endpoint redirected"):
        fac.build_auth(resp, agent, PayOptions())


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
