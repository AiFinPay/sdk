"""S06 author controls, frozen wire and real adapters; no external requests."""
import asyncio
import copy
import json
import threading
import uuid
import time
from datetime import datetime, timezone
from unittest.mock import Mock

import pytest
from aifinpay_gate import AifpGateMiddleware, AifpGateWSGI, Gate, GateReporterV2, Route, SimpleRequest
from test_gate import KEY, NOW, jwk, token

MID = "mrch_0123456789abcdef"
CAP = "A" * 43


def utc():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def event(**over):
    return {"id": str(uuid.uuid4()), "name": "access_challenged", "resource": "/api/*",
            "at": utc(), "channel": "unknown", "consent": "denied", **over}


class Response:
    def __init__(self, body, status=200):
        self.status, self.raw = status, json.dumps(body).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def read(self, size):
        return self.raw[:size]


def health_ack(duplicate=False):
    # Exact body of the backend's POST /v2/merchants/:id/reporting/health handler.
    return Response({"version": 2, "duplicate": duplicate})


@pytest.fixture
def reporter():
    r = GateReporterV2(merchant_id=MID, merchant_secret="synthetic-secret",
                       supported=["access_challenged", "access_admitted", "resource_response_completed"])
    r._opener = Mock()
    r._opener.open.side_effect = lambda req, timeout: (
        health_ack() if req.full_url.endswith("/reporting/health")
        else Response({"version": 2, "accepted": len(json.loads(req.data).get("events", [1])), "duplicates": 0, "received_at": utc()}))
    yield r
    r.close(timeout=1)


def test_v2_wire_copy_and_batches(reporter):
    original = event(reporting_token=CAP)
    expected = copy.deepcopy(original)
    reporter.on_event(original)
    original["resource"] = "/private?q=secret"
    for _ in range(50):
        reporter.on_event(event())
    assert reporter.flush()["delivered"] == 51
    calls = reporter._opener.open.call_args_list
    assert len(calls) == 2
    req = calls[0].args[0]
    assert req.full_url == f"https://api.aifinpay.io/v2/merchants/{MID}/gate-events"
    assert req.get_header("Aifp-merchant-secret") == "synthetic-secret"
    wire = json.loads(req.data)
    assert set(wire) == {"version", "events"} and wire["version"] == 2
    assert len(wire["events"]) == 50 and wire["events"][0] == expected
    assert "synthetic-secret" not in repr(reporter) + str(reporter.stats)


@pytest.mark.parametrize("over", [
    {"wallet": "claimed"}, {"agent": "unverified"}, {"body": "secret"}, {"mode": "live"},
    {"name": "payment_confirmed"}, {"name": "paywall_viewed"}, {"client_id": str(uuid.uuid4())},
    {"reporting_token": "a.b.c"}, {"reporting_token": None}, {"outcome": "success"},
    {"resource": "/api?q=secret"}, {"resource": "/api/{secret}"}, {"at": "2026-02-30T00:00:00.000Z"},
    {"status": 200}, {"reason": "private exception"}, {"channel": "bot"}, {"id": "not-uuid"},
    {"name": "resource_response_completed", "outcome": "success", "status": 302},
    {"name": "resource_response_completed", "outcome": "error", "status": 200},
    {"name": "resource_response_completed", "outcome": "redirect", "status": True},
])
def test_strict_keys_privacy_and_completion_validation(reporter, over):
    assert reporter.on_event(event(**over)) is False
    assert reporter.stats["queued"] == 0 and reporter.stats["dropped"] == 1


def test_retry_stable_facts_backoff_and_duplicate_ack(reporter):
    reporter._opener.open.side_effect = [TimeoutError("secret"), Response({"version": 2, "accepted": 0, "duplicates": 1, "received_at": utc()})]
    reporter.on_event(event())
    reporter.flush()
    assert reporter.stats["retries"] == 1 and reporter.stats["last_error"] == "timeout"
    reporter.flush(timeout=.01)
    assert reporter._opener.open.call_count == 1, "flush must not bypass retry backoff"
    with reporter._condition:
        item = reporter._queue[0]
        assert .8 < item["next_at"] - __import__("time").monotonic() <= 1
        item["next_at"] = 0
        reporter._condition.notify_all()
    assert reporter.flush()["delivered"] == 1
    assert reporter._opener.open.call_args_list[0].args[0].data == reporter._opener.open.call_args_list[1].args[0].data


@pytest.mark.parametrize("status", [400, 403, 409, 413, 302])
def test_no_retry_permanent_or_redirect(reporter, status):
    reporter._opener.open.side_effect = lambda *_a, **_k: Response({"version": 2, "error": "event_conflict", "retryable": False}, status)
    reporter.on_event(event())
    reporter.flush()
    reporter.flush()
    assert reporter._opener.open.call_count == 1
    assert reporter.stats["dropped"] == 1 and reporter.stats["queued"] == 0


@pytest.mark.parametrize("ack", [
    {"accepted": 1, "duplicates": 0},
    {"version": 2, "accepted": True, "duplicates": 0, "received_at": utc()},
    {"version": 2, "accepted": 1, "duplicates": 0, "received_at": utc(), "payload": "secret"},
    {"version": 2, "accepted": 0, "duplicates": 0, "received_at": utc()},
])
def test_bad_ack_never_delivered(reporter, ack):
    reporter._opener.open.side_effect = lambda *_a, **_k: Response(ack)
    reporter.on_event(event())
    assert reporter.flush()["delivered"] == 0
    assert reporter.stats["queued"] == 1


def test_health_sequence_overflow_and_fork(reporter, monkeypatch):
    threads = [threading.Thread(target=lambda: [reporter.on_event(event()) for _ in range(120)]) for _ in range(10)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    sample = reporter.health_sample()
    assert sample["pending"] == 1000 and sample["dropped"] == "200"
    assert set(sample) == {"version", "producer_id", "sequence", "at", "supported", "pending", "dropped", "retries", "last_error"}
    assert int(reporter.health_sample()["sequence"]) > int(sample["sequence"])
    monkeypatch.setattr("aifinpay_gate.reporter.os.getpid", lambda: reporter._pid + 1)
    with reporter._condition:
        assert reporter.on_event(event()) is False
        assert reporter.health_sample() is None
        assert reporter.close()["last_error"] == "wrong_process"


def test_scoped_flow_response_and_explicit_consent(reporter):
    body = {"version": 2, "flow_id": str(uuid.uuid4()), "reporting_token": CAP,
            "expires_at": utc(), "mode": "live", "resource": "/api/*"}
    # Use a valid future expiry; a stale/mismatched response is refused.
    from datetime import timedelta
    body["expires_at"] = (datetime.now(timezone.utc) + timedelta(minutes=15)).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    reporter._opener.open.side_effect = lambda *_a, **_k: Response(body)
    request_id = str(uuid.uuid4())
    flow = reporter.mint_flow(resource="/api/*", request_id=request_id, consent="denied")
    assert flow is not None and flow.reporting_token == CAP
    assert CAP not in repr(flow)
    req = reporter._opener.open.call_args.args[0]
    assert req.full_url.endswith("/reporting/flows")
    assert json.loads(req.data) == {"version": 2, "request_id": request_id, "resource": "/api/*", "channel": "unknown", "consent": "denied"}
    assert reporter.mint_flow(resource="/api/*", consent="denied", client_id=str(uuid.uuid4())) is None
    body["resource"] = "/other"
    assert reporter.mint_flow(resource="/api/*") is None


class Recorder:
    def __init__(self):
        self.events = []

    def on_event(self, event):
        self.events.append(event)


def gate(record):
    return Gate(MID, routes=[Route("/api/*")], jwks={"keys": [jwk(KEY)]}, now=lambda: NOW,
                reporting=record, reporting_context=lambda _req: {"channel": "api", "consent": "denied"})


@pytest.mark.parametrize("status,outcome", [(200, "success"), (302, "redirect"), (500, "error")])
def test_asgi_real_stream_once_only(status, outcome):
    record = Recorder()
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": status, "headers": []})
        await send({"type": "http.response.body", "body": b"one", "more_body": True})
        assert [e["name"] for e in record.events] == ["access_admitted"]
        await send({"type": "http.response.body", "body": b"two"})
    async def run():
        async def receive():
            return {"type": "http.request"}
        async def send(msg):
            pass
        await AifpGateMiddleware(app, gate(record))({"type": "http", "path": "/api/x", "headers": [(b"aifp-receipt", token(aud=MID, resource="/api/", scope="prefix").encode())]}, receive, send)
    asyncio.run(run())
    assert len(record.events) == 2
    assert record.events[-1]["outcome"] == outcome and record.events[-1]["status"] == status


@pytest.mark.parametrize("failure", ["disconnect", "exception", "send", "cancel"])
def test_asgi_abort_and_error_never_success(failure):
    record = Recorder()
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": []})
        if failure == "disconnect":
            await receive()
            return
        if failure == "cancel":
            raise asyncio.CancelledError()
        if failure == "exception":
            raise ValueError("private")
        await send({"type": "http.response.body", "body": b"private"})
    async def run():
        async def receive():
            return {"type": "http.disconnect"}
        async def send(msg):
            if failure == "send" and msg["type"] == "http.response.body":
                raise OSError("private")
        await AifpGateMiddleware(app, gate(record))({"type": "http", "path": "/api/x", "headers": [(b"aifp-receipt", token(aud=MID, resource="/api/", scope="prefix").encode())]}, receive, send)
    if failure == "disconnect":
        asyncio.run(run())
    else:
        with pytest.raises((ValueError, OSError, asyncio.CancelledError)):
            asyncio.run(run())
    assert len(record.events) == 2 and record.events[-1]["outcome"] == "abort"
    assert "private" not in str(record.events)


def test_wsgi_stream_exhaustion_and_early_close():
    for abort in (False, True):
        record = Recorder()
        closed = []
        def app(env, start):
            start("200 OK", [])
            def stream():
                try:
                    yield b"one"
                    yield b"two"
                finally:
                    closed.append(True)
            return stream()
        stream = AifpGateWSGI(app, gate(record))({"PATH_INFO": "/api/x", "HTTP_AIFP_RECEIPT": token(aud=MID, resource="/api/", scope="prefix")}, lambda *_: None)
        assert [e["name"] for e in record.events] == ["access_admitted"]
        assert next(iter(stream)) == b"one"
        assert len(record.events) == 1
        if not abort:
            assert list(stream) == [b"two"]
        stream.close()
        stream.close()
        assert len(record.events) == 2 and closed == [True]
        assert record.events[-1]["outcome"] == ("abort" if abort else "success")


def test_challenge_only_after_emitted_headers_and_no_view():
    record = Recorder()
    def app(*_):
        raise AssertionError("challenge must not run app")
    middleware = AifpGateWSGI(app, gate(record))
    result = middleware({"PATH_INFO": "/api/x"}, lambda *_: None)
    assert record.events == []
    assert list(result)
    assert [e["name"] for e in record.events] == ["access_challenged"]


@pytest.mark.parametrize("failure", [None, "start", "body", "cancel", "telemetry"])
def test_asgi_challenge_requires_successful_terminal_body(failure):
    record, sent, downstream = Recorder(), [], []
    g = gate(record)
    g.refund = Mock()
    if failure == "telemetry":
        record.on_event = Mock(side_effect=RuntimeError("synthetic reporting outage"))
    async def app(*_):
        downstream.append(True)
    async def receive():
        return {"type": "http.request", "body": b""}
    async def send(message):
        assert record.events == [], "no challenge before terminal body succeeds"
        sent.append(message)
        if failure == "start" and message["type"] == "http.response.start":
            raise ConnectionError("synthetic header abort")
        if message["type"] == "http.response.body":
            if failure == "body":
                raise ConnectionError("synthetic body abort")
            if failure == "cancel":
                raise asyncio.CancelledError()
    scope = {"type": "http", "path": "/api/x", "method": "GET", "headers": [], "state": {}}
    middleware = AifpGateMiddleware(app, g, refund_on_error=True)
    if failure in ("start", "body", "cancel"):
        with pytest.raises(asyncio.CancelledError if failure == "cancel" else ConnectionError):
            asyncio.run(middleware(scope, receive, send))
        assert record.events == []
    else:
        asyncio.run(middleware(scope, receive, send))
        assert sent[-1]["type"] == "http.response.body" and not sent[-1].get("more_body", False)
        if failure == "telemetry":
            record.on_event.assert_called_once()
            assert record.events == []
        else:
            assert [e["name"] for e in record.events] == ["access_challenged"]
    assert downstream == [] and sent[0]["status"] == 402
    g.refund.assert_not_called()


def test_reporting_context_failure_does_not_change_gate():
    record = Recorder()
    g = gate(record)
    g.reporting_context = lambda _: (_ for _ in ()).throw(ValueError("secret"))
    assert g.decide(SimpleRequest("/api/x")).status == 402
    record.on_event = lambda _: (_ for _ in ()).throw(RuntimeError("secret"))
    assert list(AifpGateWSGI(lambda *_: [], g)({"PATH_INFO": "/api/x"}, lambda *_: None))


def test_pending_duplicate_and_conflict_before_age_checks(reporter):
    old = event()
    assert reporter.on_event(old)
    assert reporter.on_event(dict(reversed(list(old.items()))))
    assert reporter.stats["pending"] == 1
    assert reporter.on_event({**old, "channel": "api"}) is False
    assert reporter.stats["pending"] == 1 and reporter.stats["dropped"] == 1


def test_five_attempts_exact_backoff_and_expiry(reporter):
    reporter._opener.open.side_effect = lambda *_a, **_kw: Response({}, 503)
    reporter.on_event(event())
    for attempt in range(1, 6):
        reporter.flush()
        with reporter._condition:
            if attempt < 5:
                item = reporter._queue[0]
                assert item["attempts"] == attempt
                assert 2 ** (attempt - 1) - .5 < item["next_at"] - time.monotonic() <= 2 ** (attempt - 1)
                item["next_at"] = 0
                reporter._condition.notify_all()
    assert reporter.stats["dropped"] == 1 and reporter.stats["retries"] == 4
    assert reporter.stats["last_error"] == "retry_exhausted"
    assert reporter._opener.open.call_count == 5
    reporter.on_event(event())
    with reporter._condition:
        reporter._queue[0]["created"] -= 901
    reporter.flush()
    assert reporter.stats["dropped"] == 2 and reporter._opener.open.call_count == 5


def test_health_wire_stable_lost_ack_and_acknowledged_coverage(reporter):
    assert reporter.stats["last_sample"] is None
    reporter._opener.open.side_effect = [TimeoutError("secret"), health_ack(duplicate=True)]
    reporter._health_at = 0
    assert reporter.health() is False
    assert reporter.stats["last_sample"] is None
    assert reporter.health() is False
    assert reporter._opener.open.call_count == 1
    reporter._health_at = 0
    assert reporter.health() is True
    calls = reporter._opener.open.call_args_list
    assert calls[0].args[0].data == calls[1].args[0].data
    assert calls[0].args[0].full_url.endswith("/reporting/health")
    sample = reporter.stats["last_sample"]
    assert sample["pending"] == 0 and sample["dropped"] == "0"
    assert "secret" not in json.dumps(sample)


@pytest.mark.parametrize("body", [
    {"version": 2, "accepted": 1, "duplicates": 0, "received_at": "2026-10-09T12:00:00.000Z"},
    {"duplicate": False},
    {"version": 1, "duplicate": False},
    {"version": 2, "duplicate": "false"},
    {"version": 2, "duplicate": 0},
    {"version": 2, "duplicate": False, "accepted": 1},
])
def test_health_refuses_anything_but_the_backend_acknowledgment(reporter, body):
    reporter._opener.open.side_effect = lambda req, timeout: Response(body)
    reporter._health_at = 0
    assert reporter.health() is False
    assert reporter.stats["last_sample"] is None


def test_health_background_delivery_and_new_process_sequence(reporter):
    original = reporter.health_sample()
    finished = threading.Event()
    reporter._opener.open.side_effect = lambda req, timeout: (finished.set(), health_ack())[1]
    with reporter._condition:
        reporter._health_at = 0
        reporter._condition.notify_all()
    assert finished.wait(1)
    # Wait for worker commit into stats, bounded without real requests.
    deadline = time.monotonic() + 1
    while reporter.stats["last_sample"] is None and time.monotonic() < deadline:
        time.sleep(.005)
    assert reporter.stats["last_sample"] is not None
    fresh = GateReporterV2(merchant_id=MID, merchant_secret="synthetic", supported=["access_challenged"])
    try:
        assert fresh.health_sample()["sequence"] == "1"
        assert fresh.health_sample()["producer_id"] != original["producer_id"]
    finally:
        fresh.close(timeout=0)


def test_end_to_end_deadline_does_not_spawn_unbounded_transport(reporter):
    entered, release = threading.Event(), threading.Event()
    def hanging(*_, **__):
        entered.set()
        release.wait(1)
        return Response({"version": 2, "accepted": 1, "duplicates": 0, "received_at": utc()})
    reporter._opener.open.side_effect = hanging
    reporter.HTTP_TIMEOUT = .03
    reporter.on_event(event())
    assert reporter.flush(timeout=.5)["last_error"] == "timeout"
    assert entered.is_set()
    with reporter._condition:
        reporter._queue[0]["next_at"] = 0
        reporter._condition.notify_all()
    reporter.flush(timeout=.2)
    assert reporter._opener.open.call_count == 1
    release.set()


@pytest.mark.parametrize("status", [200, 302, 500])
def test_wsgi_terminal_status_and_write_api(status):
    record = Recorder()
    writes = []
    def start(status_line, headers):
        return writes.append
    def app(env, start):
        write = start(f"{status} Synthetic", [])
        write(b"private")
        return []
    out = AifpGateWSGI(app, gate(record))({"PATH_INFO": "/api/x", "HTTP_AIFP_RECEIPT": token(aud=MID, resource="/api/", scope="prefix")}, start)
    assert writes == [b"private"] and len(record.events) == 1
    assert list(out) == []
    assert record.events[-1]["status"] == status
    assert record.events[-1]["outcome"] == ("success" if status == 200 else "redirect" if status == 302 else "error")


@pytest.mark.parametrize("failure", ["before_app", "iterator", "write", "close_before_next"])
def test_wsgi_abort_without_fabricated_headers(failure):
    record = Recorder()
    def start(*_):
        return lambda _: (_ for _ in ()).throw(OSError("private"))
    def app(env, start):
        if failure == "before_app":
            raise RuntimeError("private")
        write = start("200 OK", [])
        if failure == "write":
            write(b"secret")
        def chunks():
            if failure == "iterator":
                raise ValueError("private")
            yield b"secret"
        return chunks()
    def call():
        return AifpGateWSGI(app, gate(record))({"PATH_INFO": "/api/x", "HTTP_AIFP_RECEIPT": token(aud=MID, resource="/api/", scope="prefix")}, start)
    if failure == "close_before_next":
        stream = call()
        stream.close()
    else:
        with pytest.raises((RuntimeError, ValueError, OSError)):
            list(call())
    assert len(record.events) == 2 and record.events[-1]["outcome"] == "abort"
    assert "status" not in record.events[-1]
    assert "secret" not in str(record.events) and "private" not in str(record.events)


def test_asgi_trailers_and_exception_after_finish_are_once_only():
    record = Recorder()
    async def app(scope, receive, send):
        await send({"type": "http.response.start", "status": 200, "headers": [], "trailers": True})
        await send({"type": "http.response.body", "body": b"secret"})
        assert len(record.events) == 1
        await send({"type": "http.response.trailers", "headers": []})
        raise ValueError("private")
    async def run():
        async def send(_):
            pass
        async def receive():
            return {"type": "http.request"}
        await AifpGateMiddleware(app, gate(record))({"type": "http", "path": "/api/x", "headers": [(b"aifp-receipt", token(aud=MID, resource="/api/", scope="prefix").encode())]}, receive, send)
    with pytest.raises(ValueError):
        asyncio.run(run())
    assert len(record.events) == 2 and record.events[-1]["outcome"] == "success"


@pytest.mark.parametrize("framework", ["fastapi", "flask"])
def test_actual_framework_v2_consent_and_telemetry_outage(reporter, framework):
    g = Gate(MID, resource="/api", jwks={"keys": [jwk(KEY)]}, now=lambda: NOW, reporting=reporter,
             reporting_context=lambda _: {"channel": "api", "consent": "denied"})
    if framework == "fastapi":
        from fastapi import FastAPI
        from fastapi.testclient import TestClient
        app = FastAPI()
        app.add_middleware(AifpGateMiddleware, gate=g)
        @app.get("/api")
        def handler():
            return {"ok": True}
        client = TestClient(app)
    else:
        from flask import Flask
        app = Flask(__name__)
        app.wsgi_app = AifpGateWSGI(app.wsgi_app, g)
        @app.get("/api")
        def handler():
            return {"ok": True}
        client = app.test_client()
    assert client.get("/api").status_code == 402
    receipt = token(aud=MID, resource="/api", unit_quota=2)
    admitted = client.get("/api", headers={"AIFP-Receipt": receipt})
    assert admitted.status_code == 200
    if framework == "flask":
        admitted.get_data()  # Werkzeug defaults to an unbuffered iterable.
    assert [i["event"]["name"] for i in reporter._queue] == ["access_challenged", "access_admitted", "resource_response_completed"]
    assert all("client_id" not in i["event"] for i in reporter._queue)
    assert receipt not in str(reporter._queue)
    reporter._opener.open.side_effect = lambda *_a, **_kw: Response({}, 503)
    reporter.flush()
    second = client.get("/api", headers={"AIFP-Receipt": receipt})
    assert second.status_code == 200
    if framework == "flask":
        second.get_data()
    assert client.get("/api", headers={"AIFP-Receipt": receipt}).status_code == 402
    assert g.store.get("aifp:used:rcpt_1") == 2


def test_granted_observed_id_context_and_header_never_wallet(reporter):
    client_id = str(uuid.uuid4())
    g = Gate(MID, resource="/api", reporting=reporter,
             reporting_context=lambda _: {"channel": "browser", "consent": "granted", "client_id": client_id})
    observation = g.reporting_for(SimpleRequest("/api", {"AIFP-Agent-Id": "not-an-identity"}), g.decide(SimpleRequest("/api")))
    g.report_observation(observation, "access_challenged")
    wire = reporter._queue[0]["event"]
    assert wire["client_id"] == client_id and wire["consent"] == "granted"
    assert "not-an-identity" not in str(wire)
    req = SimpleRequest("/api", {"AIFP-Reporting-Token": CAP})
    g.report_observation(g.reporting_for(req, g.decide(req)), "access_challenged")
    assert reporter._queue[-1]["event"]["reporting_token"] == CAP
    assert reporter._queue[-1]["event"]["client_id"] == client_id
    invalid = SimpleRequest("/api", {"AIFP-Reporting-Token": "invalid"})
    g.report_observation(g.reporting_for(invalid, g.decide(invalid)), "access_challenged")
    assert "reporting_token" not in reporter._queue[-1]["event"]
    g.reporting_context = None
    req = SimpleRequest("/api", {"AIFP-Reporting-Token": CAP})
    g.report_observation(g.reporting_for(req, g.decide(req)), "access_challenged")
    assert reporter._queue[-1]["event"]["reporting_token"] == CAP
    assert "client_id" not in reporter._queue[-1]["event"]


def test_exempt_discovery_uncovered_and_v1_dualsend_refusal(reporter):
    from aifinpay_gate import GateReporter
    g = Gate(MID, routes=[Route("/api/*")], should_charge=lambda _: False, reporting=reporter)
    assert g.reporting_for(SimpleRequest("/api/x"), g.decide(SimpleRequest("/api/x"))) is None
    assert g.reporting_for(SimpleRequest("/free"), None) is None
    legacy = GateReporter(merchant_id=MID, merchant_secret="synthetic")
    try:
        with pytest.raises(ValueError, match="one reporting version"):
            Gate(MID, resource="/api", reporting=reporter, on_event=legacy.on_event)
        with pytest.raises(ValueError, match="v2 producer"):
            Gate(MID, resource="/api", reporting=legacy)
    finally:
        legacy.close(timeout=0)


@pytest.mark.parametrize("supported", [[], ["paywall_viewed"], ["access_challenged", "access_challenged"], "access_challenged"])
def test_supported_declared_exact_stages_only(supported):
    with pytest.raises(ValueError):
        GateReporterV2(merchant_id=MID, merchant_secret="synthetic", supported=supported)


def test_full_actual_deadline_and_close_drops(reporter):
    entered, release = threading.Event(), threading.Event()
    def hanging(*_, **__):
        entered.set()
        release.wait(4)
        return Response({"version": 2, "accepted": 1, "duplicates": 0, "received_at": utc()})
    reporter._opener.open.side_effect = hanging
    reporter.on_event(event())
    started = time.monotonic()
    try:
        assert reporter.flush(timeout=3.5)["last_error"] == "timeout"
        assert 2.9 <= time.monotonic() - started < 3.5
        assert reporter.stats["pending"] == 1
        assert reporter.close(timeout=0)["dropped"] == 1
        assert reporter.on_event(event()) is False
    finally:
        release.set()


def test_public_health_cannot_release_inflight_event_reservation(reporter):
    entered, release = threading.Event(), threading.Event()
    def blocking(req, timeout):
        entered.set()
        assert release.wait(2)
        return Response({"version": 2, "accepted": len(json.loads(req.data)["events"]),
                         "duplicates": 0, "received_at": utc()})
    reporter._opener.open.side_effect = blocking
    reporter.on_event(event())
    flushing = threading.Thread(target=reporter.flush)
    flushing.start()
    try:
        assert entered.wait(1)
        with reporter._condition:
            reporter._health_at = 0
        assert reporter.health() is False
        with reporter._condition:
            assert reporter._sending is True
            reporter._health_at = time.monotonic() + 5
        assert reporter.stats["pending"] == 1
        assert reporter._opener.open.call_count == 1
    finally:
        release.set()
        flushing.join(2)
    assert not flushing.is_alive()
    assert reporter.stats["delivered"] == 1 and reporter.stats["pending"] == 0


def test_actual_os_fork_does_not_acquire_inherited_locks(reporter):
    import os
    # This project targets POSIX; no conditional skip of the required control.
    read_fd, write_fd = os.pipe()
    with reporter._condition, reporter._io_lock, reporter._health_lock:
        pid = os.fork()
        if pid == 0:
            try:
                ok = (reporter.on_event(event()) is False and reporter.health() is False
                      and reporter.health_sample() is None and reporter.mint_flow(resource="/api/*") is None
                      and reporter.close()["pending"] is None)
                os.write(write_fd, b"ok" if ok else b"failed")
            finally:
                os._exit(0)
    os.close(write_fd)
    try:
        import select
        assert select.select([read_fd], [], [], 2)[0], "fork inherited a locked mutex"
        assert os.read(read_fd, 6) == b"ok"
    finally:
        os.close(read_fd)
        # Kill only a still-running owned child on a failing safety control.
        finished, _ = os.waitpid(pid, os.WNOHANG)
        if not finished:
            os.kill(pid, 9)
            os.waitpid(pid, 0)


@pytest.mark.parametrize("response_mode", ["dedupe", "conflict", "redirect"])
def test_actual_loopback_frozen_http_and_no_redirect(reporter, response_mode):
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    from urllib.request import build_opener
    from aifinpay_gate.reporter import _NoRedirect
    requests = []
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
            requests.append((self.path, body))
            assert set(body) == {"version", "events"} and body["version"] == 2
            assert self.headers["AIFP-Merchant-Secret"] == "synthetic-secret"
            if response_mode == "redirect":
                self.send_response(307)
                self.send_header("Location", "/must-not-follow")
                self.end_headers()
                return
            if response_mode == "conflict":
                status, result = 409, {"version": 2, "error": "event_conflict", "retryable": False}
            else:
                status, result = 200, {"version": 2, "accepted": 0, "duplicates": len(body["events"]), "received_at": utc()}
            raw = json.dumps(result).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)
    # HTTP is injected only at this synthetic loopback transport boundary.
    # The public constructor still refuses every non-HTTPS origin.
    server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
    worker = threading.Thread(target=server.serve_forever, daemon=True)
    worker.start()
    reporter._endpoint = f"http://127.0.0.1:{server.server_port}/v2/merchants/{MID}/gate-events"
    reporter._opener = build_opener(_NoRedirect())
    try:
        reporter.on_event(event())
        state = reporter.flush()
        assert state["delivered"] == (1 if response_mode == "dedupe" else 0)
        assert state["dropped"] == (0 if response_mode == "dedupe" else 1)
        assert len(requests) == 1 and requests[0][0] == f"/v2/merchants/{MID}/gate-events"
    finally:
        reporter.close(timeout=0)
        server.shutdown()
        server.server_close()
        worker.join(1)
