"""Shadow mode — the same decision, the same event, a 200 instead of a refusal.

Two things must hold or the mode is worthless. A site in shadow sees in its
dashboard exactly what it would see in enforce: the event stream is identical,
request for request, including who asked. And a site that never set ``mode``
keeps the paywall it has: nothing here flips a live 402 into a pass-through.
The recorded Node scenarios in test_parity.py hold the two ports to the same
answers; this file covers what the fixture cannot (a failing store, adapters).
"""

import pytest

import aifinpay_gate as g
from test_adapters import app, call_asgi
from test_gate import MID, OTHER, gate, req, token

GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"
BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Safari/605.1.15"


class FailingStore:
    def incr_by(self, *_a):
        raise RuntimeError("store down")


def recording(**kw):
    events = []
    return gate(on_event=events.append, **kw), events


@pytest.mark.parametrize("mode", [None, "enforce"])
def test_a_config_without_mode_is_enforce_and_unchanged(mode):
    gt, events = recording(**({"mode": mode} if mode else {}))
    no_receipt = gt.decide(req(**{"User-Agent": GPTBOT_UA}))
    assert (no_receipt.ok, no_receipt.status, no_receipt.headers) == (False, 402, {"Content-Type": "application/json"})
    bad = gt.decide(req(token(resource="/elsewhere")))
    assert (bad.ok, bad.status, bad.headers) == (False, 403, {"Content-Type": "application/json"})
    paid = gt.decide(req(token()))
    assert paid.status == 200 and list(paid.headers) == [g.HEADER_QUOTA_REMAINING]
    assert [e["kind"] for e in events] == ["402", "403", "serve"]


@pytest.mark.parametrize("mode", ["Shadow", "observe", "off", "", None, 1])
def test_an_unknown_mode_is_refused(mode):
    with pytest.raises(ValueError, match="mode must be"):
        gate(mode=mode)


def test_shadow_serves_a_would_be_402_and_hands_the_handler_the_refusal():
    gt, events = recording(mode="shadow")
    r = gt.decide(req(**{"User-Agent": GPTBOT_UA}))
    assert (r.ok, r.status) == (True, 200)
    assert r.headers == {g.HEADER_MODE: "shadow", g.HEADER_SHADOW_STATUS: "402"}
    assert r.aifp == {
        "agent": None, "receipt_id": "", "resource": "/paid", "weight": 0, "unit_quota": 0, "used": 0,
        "remaining": 0, "mode": "shadow",
        "shadow": {"status": 402, "error": "AIFP-402", "weight": 1,
                   "detail": "Payment Required — prepay a batch of requests and retry with the AIFP-Receipt header"},
    }
    assert events == [{"kind": "402", "resource": "/paid", "weight": 1, "detail": None,
                       "operator": "openai", "ua_class": "ai_crawler", "verified": False}]


def test_shadow_serves_a_would_be_403_and_503():
    gt, _ = recording(mode="shadow")
    forged = gt.decide(req(token(key=OTHER)))
    assert (forged.ok, forged.status, forged.headers[g.HEADER_SHADOW_STATUS]) == (True, 200, "403")
    assert forged.aifp["shadow"]["status"] == 403 and forged.aifp["shadow"]["error"] == "AIFP-403"

    broken, events = recording(mode="shadow", store=FailingStore())
    down = broken.decide(req(token()))
    assert (down.ok, down.status, down.headers) == (True, 200, {g.HEADER_MODE: "shadow", g.HEADER_SHADOW_STATUS: "503"})
    assert down.aifp["shadow"] == {"status": 503, "error": "AIFP-503-METER",
                                   "detail": "quota store unavailable — retry shortly", "weight": 1}
    assert [e["kind"] for e in events] == ["meter_error"]


def test_shadow_serves_what_enforce_serves_exactly_as_enforce_does_plus_the_header():
    gt = gate(mode="shadow", should_charge=g.known_ai_agent)
    paid = gt.decide(req(token()))
    assert paid.headers == {g.HEADER_QUOTA_REMAINING: "9", g.HEADER_MODE: "shadow"}
    assert paid.aifp["mode"] == "paid" and paid.aifp["remaining"] == 9
    human = gt.decide(req(**{"User-Agent": BROWSER_UA}))
    assert human.headers == {"AIFP-Paywall": "exempt", g.HEADER_MODE: "shadow"} and human.aifp["mode"] == "exempt"
    free = gate(mode="shadow", routes=[g.Route("/free", paywall=False)]).decide(req(path="/free"))
    assert free.headers == {"AIFP-Paywall": "off", g.HEADER_MODE: "shadow"} and free.aifp["mode"] == "open"
    assert gate(mode="shadow", routes=[g.Route("/paid")]).decide(req(path="/other")) is None


def _script(mode):
    events = []
    gt = gate(mode=mode, on_event=events.append, should_charge=g.known_ai_agent)
    broken = gate(mode=mode, on_event=events.append, store=FailingStore())
    batch = token(unit_quota=2, receipt_id="rcpt_aa", nonce="n-aa")
    results = [
        gt.decide(req(**{"User-Agent": GPTBOT_UA})),
        gt.decide(req(**{"User-Agent": BROWSER_UA})),
        gt.decide(req(token(key=OTHER), **{"User-Agent": GPTBOT_UA})),
        gt.decide(req(token(resource="/elsewhere"))),
        gt.decide(req(token(exp=1))),
        gt.decide(req(batch)),
        gt.decide(req(batch)),
        gt.decide(req(batch)),
        broken.decide(req(batch)),
        gt.decide(req()),
    ]
    return events, results


def test_shadow_and_enforce_emit_the_identical_event_stream():
    enforce_events, enforce = _script("enforce")
    shadow_events, shadow = _script("shadow")
    assert shadow_events == enforce_events
    assert [e["kind"] for e in shadow_events] == [
        "402", "serve", "403", "403", "402", "serve", "serve", "402", "meter_error", "402"]
    assert [r.status for r in enforce] == [402, 200, 403, 403, 402, 200, 200, 402, 503, 402]
    assert [r.status for r in shadow] == [200] * 10
    assert all(r.ok and r.headers[g.HEADER_MODE] == "shadow" for r in shadow)
    assert [r.headers.get(g.HEADER_SHADOW_STATUS) for r in shadow] == [
        "402", None, "403", "403", "402", None, None, "402", "503", "402"]


def test_shadow_is_not_a_paid_admission_for_reporting_v2():
    reporter = g.GateReporterV2(merchant_id="mrch_0123456789abcdef", merchant_secret="synthetic",
                                supported=["access_admitted"])
    gt = gate(mode="shadow", reporting=reporter)
    r = gt.decide(req(**{"User-Agent": GPTBOT_UA}))
    assert r.ok and gt.reporting_for(req(), r) is None


def test_asgi_in_shadow_runs_the_app_and_says_so_in_the_headers():
    from test_gate import KEY, NOW, jwk
    gt = g.Gate(MID, routes=[g.Route("/paid")], jwks={"keys": [jwk(KEY)]}, now=lambda: NOW, mode="shadow",
                should_charge=g.known_ai_agent)
    mw = g.AifpGateMiddleware(app, gt)
    status, headers, body = call_asgi(mw, "/paid", {"User-Agent": GPTBOT_UA})
    assert status == 200 and headers["aifp-mode"] == "shadow" and headers["aifp-shadow-status"] == "402"
    assert body["path"] == "/paid" and body["aifp"]["mode"] == "shadow" and body["aifp"]["shadow"]["status"] == 402
    status, headers, body = call_asgi(mw, "/paid", {"User-Agent": BROWSER_UA})
    assert status == 200 and headers["aifp-mode"] == "shadow" and "aifp-shadow-status" not in headers


def test_wsgi_in_shadow_runs_the_app_and_says_so_in_the_headers():
    from test_gate import KEY, NOW, jwk

    def wsgi_app(environ, start_response):
        start_response("200 OK", [("Content-Type", "text/plain")])
        return [environ["aifp"]["mode"].encode()]

    gt = g.Gate(MID, routes=[g.Route("/paid")], jwks={"keys": [jwk(KEY)]}, now=lambda: NOW, mode="shadow")
    captured = {}

    def start_response(status, headers, exc_info=None):
        captured["status"], captured["headers"] = status, dict(headers)

    body = b"".join(g.AifpGateWSGI(wsgi_app, gt)({"PATH_INFO": "/paid", "REQUEST_METHOD": "GET",
                                                    "HTTP_USER_AGENT": GPTBOT_UA}, start_response))
    assert captured["status"] == "200 OK" and body == b"shadow"
    assert captured["headers"][g.HEADER_MODE] == "shadow" and captured["headers"][g.HEADER_SHADOW_STATUS] == "402"
