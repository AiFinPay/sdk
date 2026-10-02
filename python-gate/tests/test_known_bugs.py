"""Behaviour the gate should have and does not — each one a real bug.

Every test here states the correct behaviour and is marked
``xfail(strict=True)``: it fails today for the reason given, and the day the
bug is fixed it starts passing, which strict mode turns into a failure so the
marker gets removed rather than left behind. None of these are fixed in the
change that adds them; they are listed in its description.

P1, P5, P6 and P7 are shared with the Node gate (gate/src/core.ts), which this
package ports line for line.
"""

import http.client
import io
import json

import pytest

import aifinpay_gate as g
from aifinpay_gate import stores as stores_mod
from aifinpay_gate import verify as verify_mod
from test_adapters import call_wsgi, wsgi_app
from test_gate import KEY, MID, NOW, b64, gate, jwk, req, token

# A header nested deep enough to exhaust the JSON decoder's recursion limit and
# still under the 32 KiB size check. Needs no key: it is refused before any
# signature is looked at — or should be.
DEEP = f"{b64(b'[' * 23_000)}.{b64(b'{}')}.{b64(b'x' * 64)}"


@pytest.mark.xfail(strict=True, reason=(
    "P1: the verifier accepts a receipt until exp + clock_tolerance_s (30 s), but its quota counter "
    "(and its single-use nonce) are stored with a TTL that ends at exp. In that window the spent batch "
    "starts again from zero, and again every second (TTL floor), until exp + 30 s."
))
def test_a_spent_batch_stays_spent_inside_the_clock_tolerance(monkeypatch):
    clock = [float(NOW)]
    monkeypatch.setattr(stores_mod, "time", type("T", (), {"monotonic": staticmethod(lambda: clock[0])}))
    gt = g.Gate(MID, resource="/paid", jwks={"keys": [jwk(KEY)]}, now=lambda: clock[0])
    tok = token(unit_quota=2, exp=NOW + 60)
    assert [gt.decide(req(tok)).status for _ in range(3)] == [200, 200, 402]
    clock[0] = NOW + 70  # 10 s past exp, inside the 30 s tolerance
    assert not gt.decide(req(tok)).ok


@pytest.mark.xfail(strict=True, raises=RecursionError, reason=(
    "P2: an unauthenticated AIFP-Receipt whose header is ~23k nested JSON arrays raises RecursionError "
    "out of Verifier/Gate.decide instead of being refused as a malformed token "
    "(verify.py catches ValueError/UnicodeDecodeError only)."
))
def test_a_pathologically_nested_header_is_refused_not_raised():
    r = gate().decide(req(DEEP))
    assert r.status == 403


@pytest.mark.xfail(strict=True, reason=(
    "P2 (consequence): with on_store_error='open' the WSGI/ASGI adapters treat any exception from "
    "decide() as a gate outage and pass the request to the app — so that same unsigned header gets "
    "a paid route served free."
))
def test_an_unsigned_nested_header_does_not_buy_a_free_call_through_an_open_gate():
    gt = g.Gate(MID, routes=[g.Route("/paid")], jwks={"keys": [jwk(KEY)]}, now=lambda: NOW, on_store_error="open")
    status, _, _ = call_wsgi(g.AifpGateWSGI(wsgi_app, gt), "/paid", {"AIFP-Receipt": DEEP})
    assert status.startswith("403")


class _TruncatedJwks:
    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n=-1):
        raise http.client.IncompleteRead(b'{"keys":')


@pytest.mark.xfail(strict=True, raises=http.client.IncompleteRead, reason=(
    "P9: _fetch_jwks converts URLError/OSError/ValueError into JwksUnavailable, but "
    "http.client.HTTPException (IncompleteRead, a JWKS response cut short) is none of those. It escapes "
    "decide() instead of failing closed with 503; under on_store_error='open' the adapters then serve free."
))
def test_a_truncated_jwks_response_fails_closed(monkeypatch):
    monkeypatch.setattr(verify_mod.urllib.request, "urlopen", lambda *a, **k: _TruncatedJwks())
    r = gate(jwks=None).decide(req(token()))
    assert r.status == 503


@pytest.mark.xfail(strict=True, reason=(
    "P3: Route(methods='POST') iterates the string, so methods becomes {'P','O','S','T'}; no method "
    "matches and the paid route silently becomes free (decide returns None). Either rejecting a bare "
    "string or treating it as one method would fix it."
))
def test_a_single_method_given_as_a_string_still_gates_the_route():
    try:
        route = g.Route("/paid", methods="POST")
    except (TypeError, ValueError):
        return  # refusing the string is a fix too
    r = gate(routes=[route]).decide(req(path="/paid", method="POST"))
    assert r is not None and r.status == 402


@pytest.mark.xfail(strict=True, reason=(
    "P5: Route() rejects an unknown tier, Gate(tier=...) does not. Gate(tier='Premium') silently prices "
    "the mount as standard: weight 1 and $0.0005 per call, a tenth of the premium price."
))
def test_an_unknown_gate_tier_is_refused_like_an_unknown_route_tier():
    with pytest.raises(ValueError):
        g.Gate(MID, resource="/x", tier="Premium", jwks={"keys": []})


@pytest.mark.xfail(strict=True, reason=(
    "P6: a refused over-limit call is not rolled back. With mixed weights on one receipt (prefix or "
    "wildcard scope), a premium call that does not fit pushes the counter past the limit and every later "
    "call is refused, stranding units the agent paid for. Same post-increment-without-rollback in the "
    "hosted gateway (aifinpay-web backend/app/aifp/gate.js:252-258)."
))
def test_a_call_that_does_not_fit_does_not_consume_the_units_that_remain():
    gt = gate(routes=[g.Route("/api/*"), g.Route("/api/premium", "premium")])
    tok = token(resource="/api/*", unit_quota=10)
    assert [gt.decide(req(tok, path="/api/a")).status for _ in range(5)] == [200] * 5
    assert gt.decide(req(tok, path="/api/premium")).status == 402  # 10 units do not fit in the 5 left
    assert gt.decide(req(tok, path="/api/a")).ok, "5 paid units are still unused"


class _UsedCounterBlip(g.MemoryStore):
    """The store fails once, on the quota counter, after the nonce was recorded."""

    def __init__(self):
        super().__init__()
        self.failed = False

    def incr_by(self, key, by, ttl_ms):
        if ":used:" in key and not self.failed:
            self.failed = True
            raise ConnectionError("redis blip")
        return super().incr_by(key, by, ttl_ms)


@pytest.mark.xfail(strict=True, reason=(
    "P7: a single-use receipt's nonce is consumed before the quota counter is incremented. If that "
    "increment fails the agent gets 503 'retry shortly' — and the retry is refused as 'already spent'. "
    "The agent paid and was never served; refund() does not give the nonce back either."
))
def test_a_store_blip_after_the_nonce_check_does_not_burn_a_single_use_receipt():
    gt = gate(store=_UsedCounterBlip())
    tok = token(unit_quota=1)
    assert gt.decide(req(tok)).status == 503
    assert gt.decide(req(tok)).ok
