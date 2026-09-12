"""Detection + adapter behavior tests. Run: python -m pytest tests/"""
from __future__ import annotations

import base64
import hashlib
import json
import time

import base58
import pytest
import requests

from aifinpay import Agent, PayOptions
from aifinpay.errors import (
    AiFinPayError,
    FacilitatorNotImplementedError,
    PaymentTooExpensiveError,
    UnsupportedFacilitatorError,
)
from aifinpay.facilitators import (
    AiFinPayFacilitator,
    CoinbaseX402Facilitator,
    detect_facilitator,
)
from aifinpay.facilitators.base import canonical_origin


def _resp(status: int, *, headers=None, body=None) -> requests.Response:
    r = requests.Response()
    r.status_code = status
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
    """Real production 402 body — fingerprint via `protocol: "AiFinPay vX"`."""
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
    """If a proxy strips `protocol`, the agreement_hash + treasury_vault pair
    is still a strong signal."""
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


def test_aifinpay_inband_challenge_extraction():
    expiry = int(time.time() * 1000) + 60_000
    resp = _resp(
        402,
        body={
            "protocol": "AiFinPay v5.3",
            "x-nonce": "in-band-nonce-xyz",
            "x-nonce-expires-at": str(expiry),
            "x-aifinpay-auth-version": 2,
            "x-aifinpay-body-sha256": hashlib.sha256(b"").hexdigest(),
            "agreement_hash": "h",
            "treasury_vault": "t",
        },
    )
    assert AiFinPayFacilitator._inband_challenge(
        resp, hashlib.sha256(b"").hexdigest()
    ) == (
        "in-band-nonce-xyz",
        expiry,
    )


def test_aifinpay_inband_challenge_absent():
    resp = _resp(402, body={"protocol": "AiFinPay v5.3", "agreement_hash": "h"})
    assert AiFinPayFacilitator._inband_challenge(resp) is None


def test_native_auth_canonical_origin_normalizes_default_ports():
    assert canonical_origin("https://aifinpay.io:443/v1/data") == "https://aifinpay.io"
    assert canonical_origin("http://aifinpay.io:80/v1/data") == "http://aifinpay.io"
    assert canonical_origin("https://[2001:db8::1]:443/v1/data") == "https://[2001:db8::1]"
    assert canonical_origin("https://[2001:db8::1]:8443/v1/data") == "https://[2001:db8::1]:8443"


def test_native_auth_response_default_port_is_same_origin():
    now = int(time.time() * 1000)
    agent = Agent.new()
    response = _resp(
        402,
        body={
            "protocol": "AiFinPay v5.3",
            "x-nonce": "in-band-nonce-xyz",
            "x-nonce-expires-at": str(now + 60_000),
            "x-aifinpay-auth-version": 2,
            "x-aifinpay-body-sha256": hashlib.sha256(b"").hexdigest(),
        },
    )
    response.url = "https://aifinpay.io:443/v1/data"
    headers = AiFinPayFacilitator().build_auth(
        response,
        agent,
        PayOptions(),
        {
            "url": "https://aifinpay.io/v1/data",
            "method": "GET",
            "trusted_origin": "https://aifinpay.io",
            "body_digest": hashlib.sha256(b"").hexdigest(),
        },
    )["headers"]
    assert headers["x-aifinpay-auth-version"] == "2"


@pytest.mark.parametrize("expiry", [lambda now: now - 1, lambda now: now + 5 * 60_000 + 1])
def test_aifinpay_inband_challenge_rejects_stale_or_implausible_expiry(expiry):
    now = int(time.time() * 1000)
    resp = _resp(
        402,
        body={
            "protocol": "AiFinPay v5.3",
            "x-nonce": "in-band-nonce-xyz",
            "x-nonce-expires-at": str(expiry(now)),
            "x-aifinpay-auth-version": 2,
            "x-aifinpay-body-sha256": hashlib.sha256(b"").hexdigest(),
            "agreement_hash": "h",
            "treasury_vault": "t",
        },
    )
    assert AiFinPayFacilitator._inband_challenge(resp, hashlib.sha256(b"").hexdigest()) is None


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
    # Budget enforcement runs before NotImplemented — caller learns
    # "this is too expensive" without learning we can't pay it anyway.
    with pytest.raises(PaymentTooExpensiveError):
        CoinbaseX402Facilitator().build_auth(resp, agent, opts)


def test_coinbase_malformed_header_raises():
    resp = _resp(402, headers={"PAYMENT-REQUIRED": "not-base64!!"})
    agent = Agent.new()
    with pytest.raises(UnsupportedFacilitatorError):
        CoinbaseX402Facilitator().build_auth(resp, agent, PayOptions())


# ── aifinpay adapter signing ─────────────────────────────────────────────


def test_aifinpay_signature_binds_request_context():
    agent = Agent.new()
    fac = AiFinPayFacilitator()
    fields = [
        "AiFinPay-x402",
        "v2",
        "abc-123",
        agent.address,
        "https://api.example.test",
        "POST",
        "/v1/data?kind=summary",
        hashlib.sha256(b"").hexdigest(),
        1760000000000,
    ]
    signature = base58.b58decode(
        fac._sign_request(
            agent,
            fields[2],
            fields[4],
            fields[5],
            fields[6],
            fields[7],
            fields[8],
        )
    )

    def verifies(bound):
        digest = hashlib.sha256(
            json.dumps(bound, separators=(",", ":"), ensure_ascii=True).encode()
        ).digest()
        try:
            agent._vk.verify(digest, signature)
            return True
        except Exception:
            return False

    assert verifies(fields)
    assert not verifies([*fields[:5], "GET", *fields[6:]])
    assert not verifies([*fields[:6], "/v1/other", *fields[7:]])
    assert not verifies([*fields[:4], "https://evil.example", *fields[5:]])
    assert not verifies([*fields[:7], hashlib.sha256(b"changed").hexdigest(), *fields[8:]])
    assert not verifies([*fields[:8], fields[8] + 1])


def test_aifinpay_auth_headers_rejects_unbound_legacy_signature():
    with pytest.raises(AiFinPayError, match="retired unbound"):
        Agent.new().auth_headers()


def test_agent_pay_uses_request_bound_v2_and_never_follows_redirects():
    agent = Agent.new(base_url="https://aifinpay.io")
    calls = []
    first = _resp(
        402,
        body={
            "protocol": "AiFinPay v5.3",
            "agreement_hash": "h",
            "treasury_vault": "t",
            "x-nonce": "server-issued-nonce",
            "x-nonce-expires-at": str(int(time.time() * 1000) + 60_000),
            "x-aifinpay-auth-version": 2,
            "x-aifinpay-body-sha256": hashlib.sha256(b"").hexdigest(),
        },
    )
    first.url = "https://aifinpay.io/v1/data?kind=summary"
    second = _resp(200, body={"ok": True})
    second.url = first.url

    def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return first if len(calls) == 1 else second

    agent._session.request = request
    response = agent.pay("https://aifinpay.io/v1/data?kind=summary", method="POST")
    assert response.status_code == 200
    assert len(calls) == 2
    assert all(call[2]["allow_redirects"] is False for call in calls)
    headers = calls[1][2]["headers"]
    assert headers["x-aifinpay-auth-version"] == "2"


def test_agent_pay_does_not_sign_attacker_challenge_for_trusted_agent():
    agent = Agent.new(base_url="https://aifinpay.io")
    calls = []
    hostile = _resp(
        402,
        body={
            "protocol": "AiFinPay v5.3",
            "agreement_hash": "h",
            "treasury_vault": "t",
            "x-nonce": "attacker-supplied",
            "x-nonce-expires-at": str(int(time.time() * 1000) + 60_000),
            "x-aifinpay-auth-version": 2,
            "x-aifinpay-body-sha256": hashlib.sha256(b"").hexdigest(),
        },
    )
    hostile.url = "https://evil.example/steal"

    def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return hostile

    agent._session.request = request
    with pytest.raises(ValueError, match="untrusted origin"):
        agent.pay("https://evil.example/steal")
    assert len(calls) == 1
    assert "x-signature" not in calls[0][2]["headers"]


def test_agent_pay_binds_requests_normalized_unicode_resource_and_query():
    agent = Agent.new(base_url="https://aifinpay.io")
    requested_url = "https://aifinpay.io/v1/дані"
    prepared = requests.Request(
        "POST", requested_url, params={"city": "München"}, data=b"payload"
    ).prepare()
    expiry = int(time.time() * 1000) + 60_000
    challenge = _resp(
        402,
        body={
            "protocol": "AiFinPay v5.3",
            "agreement_hash": "h",
            "treasury_vault": "t",
            "x-nonce": "server-issued-nonce",
            "x-nonce-expires-at": str(expiry),
            "x-aifinpay-auth-version": 2,
            "x-aifinpay-body-sha256": hashlib.sha256(b"payload").hexdigest(),
        },
    )
    challenge.url = prepared.url
    challenge.request = prepared
    success = _resp(200, body={"ok": True})
    success.url = prepared.url
    calls = []

    def request(method, url, **kwargs):
        calls.append((method, url, kwargs))
        return challenge if len(calls) == 1 else success

    agent._session.request = request
    assert agent.pay(requested_url, method="POST", params={"city": "München"}, data=b"payload").status_code == 200
    signature = base58.b58decode(calls[1][2]["headers"]["x-signature"])
    parts = requests.utils.urlparse(prepared.url)
    resource = parts.path + (f"?{parts.query}" if parts.query else "")
    message = [
        "AiFinPay-x402",
        "v2",
        "server-issued-nonce",
        agent.address,
        "https://aifinpay.io",
        "POST",
        resource,
        hashlib.sha256(b"payload").hexdigest(),
        expiry,
    ]
    agent._vk.verify(
        hashlib.sha256(
            json.dumps(message, separators=(",", ":"), ensure_ascii=True).encode()
        ).digest(),
        signature,
    )


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
