"""Independent S06 controls. Original signing/payment fixtures are read-only;
no author reporting-v2 tests imported. No external transport/dependencies."""
import asyncio
import ast
import copy
import json
import socket
import sys
import threading
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import Request, build_opener
from unittest.mock import Mock

import pytest
from aifinpay_gate import Gate, GateReporter, GateReporterV2, Route, AifpGateMiddleware, AifpGateWSGI
from test_gate import KEY, NOW, jwk, token  # original receipt fixture, actual verifier

MID = "mrch_0123456789abcdef"
CAP = "I" * 43
ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "python/tests"))
from test_aifp1 import Harness, pinned as original_pin  # original financial fixture, not S06 author test
import aifinpay.client as payer
from aifinpay_gate.reporter import _NoRedirect


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def fact(**over):
    return dict(id=str(uuid.uuid4()), name="access_admitted", resource="/paid", at=utc(),
                channel="api", consent="denied", **over)


class Response:
    def __init__(self, count=1, status=200, duplicate=False, body=None):
        self.status = status
        self.raw = json.dumps(body if body is not None else dict(version=2,
            accepted=0 if duplicate else count, duplicates=count if duplicate else 0, received_at=utc())).encode()
    def __enter__(self): return self
    def __exit__(self, *_): pass
    def read(self, n): return self.raw[:n]


@pytest.fixture
def reporter():
    r = GateReporterV2(merchant_id=MID, merchant_secret="independent-fixture",
                       supported=["access_challenged", "access_admitted", "resource_response_completed"])
    r._opener = Mock()
    r._opener.open.side_effect = lambda req, **kw: Response(len(json.loads(req.data).get("events", [1])))
    # Keep automatic health out of scheduler controls; public health is explicitly made due in its control.
    with r._condition: r._health_at = time.monotonic() + 3600
    yield r
    r.close(timeout=1)


def test_v1_ast_unchanged_and_no_dual_producer(reporter):
    def legacy(path):
        return ast.dump(next(n for n in ast.parse(path.read_text()).body if isinstance(n, ast.ClassDef) and n.name == "GateReporter"))
    assert legacy(ROOT / "python-gate/aifinpay_gate/reporter.py") == legacy(ROOT.parent / "aifinpay-sdk/python-gate/aifinpay_gate/reporter.py")
    import tomllib
    for pkg in ("python-gate", "python"):
        a = tomllib.loads((ROOT / pkg / "pyproject.toml").read_text())
        b = tomllib.loads((ROOT.parent / "aifinpay-sdk" / pkg / "pyproject.toml").read_text())
        del a["project"]["version"]; del b["project"]["version"]
        assert a == b
    legacy_reporter = GateReporter(merchant_id=MID, merchant_secret="independent-fixture")
    try:
        with pytest.raises(ValueError, match="one reporting version"):
            Gate(MID, resource="/paid", reporting=reporter, on_event=legacy_reporter.on_event)
    finally: legacy_reporter.close(timeout=.1)


@pytest.mark.parametrize("over", [
    {"name": "payment_confirmed"}, {"name": "paywall_viewed"}, {"wallet": "spoof"},
    {"mode": "live"}, {"origin": "https://foreign.invalid"}, {"source": "hosted"},
    {"reason": "private freeform exception"}, {"reporting_token": "bad\r\nheader"},
    {"client_id": "20000000-0000-4000-8000-000000000001"},
    {"at": "2026-02-30T00:00:00.000Z"}, {"at": "2099-01-01T00:00:00.000Z"},
    {"resource": "/paid?wallet=secret"}, {"resource": "https://foreign.invalid/paid"},
])
def test_untrusted_fields_refuse_without_transport_or_throw(reporter, over):
    e = fact(); e.update(over)
    assert reporter.on_event(e) is False
    assert reporter.stats["dropped"] == 1 and reporter.stats["pending"] == 0
    reporter.flush(timeout=.1)
    reporter._opener.open.assert_not_called()


def test_lost_ack_equal_retry_and_conflict_immutable_facts(reporter):
    reporter._opener.open.side_effect = [TimeoutError("private diagnostic"), Response(duplicate=True)]
    e = fact(); original = copy.deepcopy(e)
    assert reporter.on_event(e); assert reporter.on_event(dict(e))
    assert not reporter.on_event(dict(e, channel="browser"))
    e["resource"] = "/mutated"
    assert reporter.flush()["delivered"] == 0
    reporter.flush(timeout=.02); assert reporter._opener.open.call_count == 1
    with reporter._condition:
        item = reporter._queue[0]
        assert .7 < item["next_at"] - time.monotonic() <= 1
        item["next_at"] = 0; reporter._condition.notify_all()
    assert reporter.flush()["delivered"] == 1
    calls = reporter._opener.open.call_args_list
    assert calls[0].args[0].data == calls[1].args[0].data
    assert json.loads(calls[1].args[0].data)["events"] == [original]
    assert "private diagnostic" not in str(reporter.stats)


@pytest.mark.parametrize("status", [400, 403, 409, 302])
def test_permanent_refusal_and_redirect_never_retry(reporter, status):
    reporter._opener.open.side_effect = lambda *a, **k: Response(status=status)
    reporter.on_event(fact()); reporter.flush(); reporter.flush(timeout=.02)
    assert reporter._opener.open.call_count == 1
    assert reporter.stats["pending"] == 0 and reporter.stats["dropped"] == 1


def test_max_five_attempts_and_15min_age(reporter):
    reporter._opener.open.side_effect = lambda *a, **k: Response(status=503)
    reporter.on_event(fact())
    for attempt in range(5):
        reporter.flush(timeout=.3)
        if attempt < 4:
            with reporter._condition:
                item = reporter._queue[0]
                assert 2 ** attempt - .3 < item["next_at"] - time.monotonic() <= 2 ** attempt
                item["next_at"] = 0; reporter._condition.notify_all()
    assert reporter._opener.open.call_count == 5
    assert reporter.stats["pending"] == 0 and reporter.stats["dropped"] == 1
    reporter.on_event(fact())
    with reporter._condition:
        reporter._queue[0]["created"] = time.monotonic() - 901
    reporter.flush(timeout=.3)
    assert reporter._opener.open.call_count == 5 and reporter.stats["dropped"] == 2


def test_inflight_capacity_bounded_batches_drop_coverage(reporter):
    entered, release = threading.Event(), threading.Event()
    bodies = []
    def send(req, **kw):
        bodies.append(req.data)
        if len(bodies) == 1: entered.set(); assert release.wait(2)
        return Response(len(json.loads(req.data)["events"]))
    reporter._opener.open.side_effect = send
    for _ in range(1000): assert reporter.on_event(fact())
    thread = threading.Thread(target=reporter.flush); thread.start()
    assert entered.wait(1)
    try:
        assert reporter.stats["pending"] == 1000
        assert not reporter.on_event(fact())
    finally: release.set(); thread.join(3)
    assert not thread.is_alive()
    assert reporter.stats["delivered"] == 1000 and reporter.stats["dropped"] == 1
    assert reporter.stats["last_sample"] is None
    assert len(bodies) == 20
    assert all(len(json.loads(b)["events"]) == 50 and len(b) <= 65536 for b in bodies)


def test_actual_three_second_deadline_no_transport_thread_accumulation(reporter):
    entered, release = threading.Event(), threading.Event()
    def send(*a, **kw): entered.set(); release.wait(5); return Response()
    reporter._opener.open.side_effect = send
    reporter.on_event(fact()); start = time.monotonic()
    try:
        assert reporter.flush(timeout=3.5)["last_error"] == "timeout"
        assert entered.is_set() and 2.9 <= time.monotonic() - start < 3.5
        assert reporter._http(reporter._endpoint, {"version": 2, "events": []})[1] == "timeout"
        assert reporter._opener.open.call_count == 1
    finally: release.set()


def test_health_event_reservation_and_close_isolation(reporter):
    entered, release = threading.Event(), threading.Event()
    def send(req, **kw): entered.set(); assert release.wait(2); return Response()
    reporter._opener.open.side_effect = send
    reporter.on_event(fact())
    thread = threading.Thread(target=reporter.flush); thread.start(); assert entered.wait(1)
    try:
        with reporter._condition: reporter._health_at = 0
        assert reporter.health() is False
        with reporter._condition: assert reporter._sending is True
    finally: release.set(); thread.join(3)
    assert reporter.stats["delivered"] == 1 and reporter.stats["dropped"] == 0
    reporter.close(timeout=1); assert reporter.stats["closed"]
    assert not reporter.on_event(fact()) and not reporter.health()


def test_health_retry_has_minimum_five_seconds(reporter):
    reporter._opener.open.side_effect = lambda *a, **k: Response(status=503)
    with reporter._condition: reporter._health_at = 0
    reporter.health()
    with reporter._condition: assert reporter._health_at - time.monotonic() > 4.8
    assert reporter.stats["last_sample"] is None


class Recorder:
    def __init__(self): self.events = []
    def on_event(self, event): self.events.append(event)


def real_gate(record, context=None):
    return Gate(MID, routes=[Route("/paid")], jwks={"keys": [jwk(KEY)]}, now=lambda: NOW,
                reporting=record, reporting_context=context)


def scope(paid=True):
    headers = [(b"aifp-reporting-token", CAP.encode()), (b"user-agent", b"forged-wallet"),
               (b"x-forwarded-for", b"192.0.2.1"), (b"aifp-agent-id", b"spoofed-identity")]
    if paid: headers.append((b"aifp-receipt", token(aud=MID, resource="/paid", unit_quota=10).encode()))
    return dict(type="http", path="/paid", method="GET", headers=headers, state={})


@pytest.mark.parametrize("status,outcome", [(200, "success"), (302, "redirect"), (503, "error")])
def test_actual_asgi_terminal_once_and_default_privacy(status, outcome):
    record = Recorder()
    async def app(s, receive, send):
        await send(dict(type="http.response.start", status=status, headers=[]))
        await send(dict(type="http.response.body", body=b"one", more_body=True))
        assert len(record.events) == 1
        await send(dict(type="http.response.body", body=b"two"))
    async def receive(): return dict(type="http.request", body=b"")
    async def send(message): pass
    asyncio.run(AifpGateMiddleware(app, real_gate(record))(scope(), receive, send))
    assert [e["name"] for e in record.events] == ["access_admitted", "resource_response_completed"]
    assert record.events[-1]["outcome"] == outcome and record.events[-1]["status"] == status
    assert all(e["reporting_token"] == CAP and "client_id" not in e for e in record.events)
    assert all(e["channel"] == "unknown" for e in record.events)
    assert not any(x in json.dumps(record.events) for x in ("192.0.2.1", "spoofed-identity", "forged-wallet"))


def test_asgi_paid_send_abort_once_and_reporting_exception_no_access_repeat():
    record = Recorder(); access = []
    async def app(s, receive, send):
        access.append(1); await send(dict(type="http.response.start", status=200, headers=[]))
        await send(dict(type="http.response.body", body=b"partial", more_body=True))
    async def receive(): return dict(type="http.disconnect")
    async def send(m):
        if m["type"] == "http.response.body": raise ConnectionError("private socket")
    with pytest.raises(ConnectionError): asyncio.run(AifpGateMiddleware(app, real_gate(record))(scope(), receive, send))
    assert len(access) == 1 and len(record.events) == 2
    assert record.events[-1]["outcome"] == "abort"
    class Outage:
        def on_event(self, e): raise RuntimeError("private storage")
    async def ok(m): pass
    asyncio.run(AifpGateMiddleware(app, real_gate(Outage()))(scope(), receive, ok))
    assert len(access) == 2


def test_SEC_SDK_02_asgi_challenge_body_abort_is_not_finished402():
    record = Recorder(); downstream = []
    async def app(*args): downstream.append(1)
    async def receive(): return dict(type="http.disconnect")
    async def send(m):
        if m["type"] == "http.response.body": raise ConnectionError("body aborted")
    with pytest.raises(ConnectionError): asyncio.run(AifpGateMiddleware(app, real_gate(record))(scope(False), receive, send))
    assert downstream == []
    assert record.events == [], "challenge requires finished402, not only response.start"


@pytest.mark.parametrize("status,outcome", [(200, "success"), (302, "redirect"), (503, "error")])
def test_actual_flask_wsgi_terminal_once_privacy(status, outcome):
    from flask import Flask
    record = Recorder(); app = Flask(__name__)
    @app.get("/paid")
    def paid(): return "original", status
    app.wsgi_app = AifpGateWSGI(app.wsgi_app, real_gate(record))
    response = app.test_client().get("/paid", headers={"AIFP-Receipt": token(aud=MID, resource="/paid", unit_quota=10),
        "AIFP-Reporting-Token": CAP, "User-Agent": "forged", "X-Forwarded-For": "192.0.2.1"})
    assert response.get_data() == b"original" and response.status_code == status
    response.close()
    assert [e["name"] for e in record.events] == ["access_admitted", "resource_response_completed"]
    assert record.events[-1]["outcome"] == outcome
    assert all(e["reporting_token"] == CAP and "client_id" not in e for e in record.events)
    assert "192.0.2.1" not in json.dumps(record.events)


def test_wsgi_early_close_does_not_create_success_or_duplicate():
    record = Recorder()
    def app(env, start):
        start("200 OK", []); return iter([b"one", b"two"])
    env = {"PATH_INFO": "/paid", "REQUEST_METHOD": "GET", "HTTP_AIFP_RECEIPT": token(aud=MID, resource="/paid", unit_quota=10)}
    result = AifpGateWSGI(app, real_gate(record))(env, lambda *a: None)
    assert next(result) == b"one"; result.close(); result.close()
    assert len(record.events) == 2 and record.events[-1]["outcome"] == "abort"


def test_asgi_finished402_bad_context_cannot_grant_access():
    record = Recorder(); downstream = []
    async def app(*a): downstream.append(1)
    async def receive(): return dict(type="http.request", body=b"")
    async def send(m): pass
    gt = real_gate(record, lambda req: {"consent": "denied", "client_id": str(uuid.uuid4())})
    asyncio.run(AifpGateMiddleware(app, gt)(scope(False), receive, send))
    assert downstream == [] and record.events == []
    record = Recorder()
    asyncio.run(AifpGateMiddleware(app, real_gate(record))(scope(False), receive, send))
    assert [e["name"] for e in record.events] == ["access_challenged"]


@pytest.mark.parametrize("url", ["https://foreign.invalid/v1/quote", "https://api.aifinpay.io/v1/pay",
    "https://api.aifinpay.io/.well-known/jwks.json", "https://api.aifinpay.io/v1/quote?raw=id",
    "https://api.aifinpay.io@foreign.invalid/v1/quote", "https://api.aifinpay.io/v1/quote#raw"])
def test_payer_no_foreign_financial_or_redirect_target(url):
    assert payer._reporting_headers(CAP, url, "https://api.aifinpay.io") == {}


def test_independent_payment_reporting_loss_once_and_recovery_privacy(monkeypatch):
    dep = original_pin.__wrapped__(monkeypatch)
    h = Harness(dep); calls = []; original = h.server.post
    def send(url, **kw):
        calls.append((url, copy.deepcopy(kw)))
        # Optional correlation unavailable to server; financial request remains intact.
        if url.endswith("/v1/quote"): kw.pop("headers", None)
        return original(url, **kw)
    h.server.post = send
    assert h.fetch(reporting_token=CAP).status_code == 200
    assert h.fetch(reporting_token="invalid\r\nheader").status_code == 200
    assert h.server.quotes == 1 and len(h.server.pays) == 1 and len(h.chain.sent) == 1
    assert next(k for u, k in calls if u.endswith("/v1/quote"))["headers"] == {"AIFP-Reporting-Token": CAP}
    assert all("AIFP-Reporting-Token" not in k.get("headers", {}) for u, k in calls if not u.endswith("/v1/quote"))
    assert CAP not in json.dumps(h.journal) + json.dumps(h.receipts) + json.dumps(h.server.pays) + json.dumps(h.ledger._memory)


def test_payer_call_scoped_headers_no_auth_repeat_or_persistence():
    agent = payer.Agent.new(base_url="https://api.aifinpay.io")
    agent._session = Mock(); agent._session.request.return_value.status_code = 200
    agent.pay("https://api.aifinpay.io/v1/quote", method="POST", reporting_token=CAP)
    agent.pay("https://foreign.invalid/data", reporting_token=CAP)
    calls = agent._session.request.call_args_list
    assert calls[0].kwargs["headers"]["AIFP-Reporting-Token"] == CAP
    assert "AIFP-Reporting-Token" not in calls[1].kwargs["headers"]
    assert all(c.kwargs["allow_redirects"] is False for c in calls)
    assert CAP not in str(agent._session.headers)


def test_real_http_lost_ack_once_and_redirect_refusal(reporter):
    bodies, accepted = [], {}
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *a): pass
        def do_POST(self):
            data = self.rfile.read(int(self.headers["Content-Length"])); bodies.append(data)
            assert self.path.endswith("/gate-events")
            assert self.headers["AIFP-Merchant-Secret"] == "independent-fixture"
            events = json.loads(data)["events"]
            if len(bodies) == 1:
                for e in events: accepted[e["id"]] = e
                self.connection.shutdown(socket.SHUT_RDWR); self.connection.close(); return
            if len(bodies) == 3:
                self.send_response(302); self.send_header("Location", "/must-not-follow"); self.end_headers(); return
            self.send_response(200); self.end_headers()
            self.wfile.write(Response(len(events), duplicate=True).raw)
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True); worker.start()
    native = build_opener(_NoRedirect())
    class OwnedTransport:
        def open(self, req, timeout):
            assert req.full_url == f"https://api.aifinpay.io/v2/merchants/{MID}/gate-events"
            local = f"http://127.0.0.1:{server.server_port}/v2/merchants/{MID}/gate-events"
            response = native.open(Request(local, data=req.data, headers=dict(req.header_items()), method="POST"), timeout=timeout)
            response.geturl = lambda: req.full_url  # logical HTTPS URL; original no-redirect handler retained
            return response
    reporter._opener = OwnedTransport()
    try:
        reporter.on_event(fact()); reporter.flush(); time.sleep(1.05); reporter.flush()
        assert len(bodies) == 2 and bodies[0] == bodies[1] and len(accepted) == 1
        assert reporter.stats["delivered"] == 1
        reporter.on_event(fact()); reporter.flush(); reporter.flush(timeout=.02)
        assert len(bodies) == 3 and reporter.stats["dropped"] == 1
    finally:
        reporter.close(timeout=1); server.shutdown(); server.server_close(); worker.join(2)
