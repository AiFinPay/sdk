"""Regressions for bugs found by the coverage pass (AiFinPay/sdk#96).

Each test states behaviour the gate lacked: a spent batch refilling inside the
clock tolerance (P1), a malformed header or a truncated JWKS response escaping
as an exception that a fail-open adapter served free (P2, P9), a method string
that made a route free (P3), an unvalidated mount tier (P5), units stranded by
a refused call (P6) and a single-use receipt burned by a store blip (P7).

P1, P5, P6 and P7 are shared with the Node gate (gate/src/core.ts), which this
package ports line for line; gate/tests/regressions.test.ts holds their twins.
"""

import http.client
import threading

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


def test_a_spent_batch_stays_spent_inside_the_clock_tolerance(monkeypatch):
    clock = [float(NOW)]
    monkeypatch.setattr(stores_mod, "time", type("T", (), {"monotonic": staticmethod(lambda: clock[0])}))
    gt = g.Gate(MID, resource="/paid", jwks={"keys": [jwk(KEY)]}, now=lambda: clock[0])
    tok = token(unit_quota=2, exp=NOW + 60)
    assert [gt.decide(req(tok)).status for _ in range(3)] == [200, 200, 402]
    clock[0] = NOW + 70  # 10 s past exp, inside the 30 s tolerance
    assert not gt.decide(req(tok)).ok


def test_a_pathologically_nested_header_is_refused_not_raised():
    r = gate().decide(req(DEEP))
    assert r.status == 403


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


def test_a_truncated_jwks_response_fails_closed(monkeypatch):
    monkeypatch.setattr(verify_mod.urllib.request, "urlopen", lambda *a, **k: _TruncatedJwks())
    r = gate(jwks=None).decide(req(token()))
    assert r.status == 503


def test_a_single_method_given_as_a_string_still_gates_the_route():
    route = g.Route("/paid", methods="post")
    assert route.methods == frozenset({"POST"})
    gt = gate(routes=[route])
    r = gt.decide(req(path="/paid", method="POST"))
    assert r is not None and r.status == 402
    assert gt.decide(req(path="/paid", method="GET")) is None, "other methods are not this route"


def test_an_unknown_gate_tier_is_refused_like_an_unknown_route_tier():
    with pytest.raises(ValueError):
        g.Gate(MID, resource="/x", tier="Premium", jwks={"keys": []})


def test_a_call_that_does_not_fit_does_not_consume_the_units_that_remain():
    gt = gate(routes=[g.Route("/api/*"), g.Route("/api/premium", "premium")])
    tok = token(resource="/api/*", unit_quota=10)
    assert [gt.decide(req(tok, path="/api/a")).status for _ in range(5)] == [200] * 5
    refused = gt.decide(req(tok, path="/api/premium"))  # 10 units do not fit in the 5 left
    assert (refused.status, refused.body["detail"]) == (402, g.DETAIL_QUOTA_EXHAUSTED)
    served = [gt.decide(req(tok, path="/api/a")) for _ in range(6)]
    assert [r.aifp["remaining"] for r in served[:5]] == [4, 3, 2, 1, 0], "the 5 paid units are all spendable"
    assert served[5].status == 402


def test_concurrent_mixed_weights_never_serve_more_units_than_were_paid_for():
    # 25 units, 300 concurrent calls of weight 1 and 10. Undoing refused
    # increments must not let the served total exceed what was bought.
    gt = gate(routes=[g.Route("/api/*"), g.Route("/api/premium", "premium")])
    tok = token(resource="/api/*", unit_quota=25)
    results = []
    lock = threading.Lock()

    def hit(path):
        r = gt.decide(req(tok, path=path))
        with lock:
            results.append(r)

    threads = [threading.Thread(target=hit, args=("/api/premium" if i % 3 == 0 else "/api/a",)) for i in range(300)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    spent = sum(r.aifp["weight"] for r in results if r.ok)
    assert spent <= 25
    assert gt.store.get("aifp:used:rcpt_1") == spent, "every refused increment was undone, and only those"


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


def test_a_store_blip_after_the_nonce_check_does_not_burn_a_single_use_receipt():
    gt = gate(store=_UsedCounterBlip())
    tok = token(unit_quota=1)
    assert gt.decide(req(tok)).status == 503
    assert gt.decide(req(tok)).ok
    assert gt.decide(req(tok)).status == 403, "once served, the receipt is spent"


def test_a_store_blip_on_a_fail_open_gate_keeps_the_nonce_it_served():
    # Open, the blip is served un-metered — that call used the receipt, so a
    # replay after the store recovers is refused as before.
    gt = gate(store=_UsedCounterBlip(), on_store_error="open")
    tok = token(unit_quota=1)
    r = gt.decide(req(tok))
    assert r.ok and r.headers.get("AIFP-Meter") == "degraded"
    assert gt.decide(req(tok)).status == 403


def test_a_single_use_receipt_refused_for_weight_stays_usable_for_a_call_that_fits():
    gt = gate(routes=[g.Route("/api/*"), g.Route("/api/premium", "premium")])
    tok = token(resource="/api/*", unit_quota=1)
    assert gt.decide(req(tok, path="/api/premium")).status == 402
    assert gt.decide(req(tok, path="/api/a")).ok
    assert gt.decide(req(tok, path="/api/a")).status == 403
