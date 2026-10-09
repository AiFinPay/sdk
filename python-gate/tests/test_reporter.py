"""Offline reporter acceptance: no server, RPC, keys or payments."""
import json
import threading
from unittest.mock import Mock

import pytest
from aifinpay_gate import Gate, GateReporter, MemoryStore, Route, SimpleRequest
from aifinpay_gate.reporter import _NoRedirect, _RedirectBlocked

MERCHANT = "mrch_0123456789abcdef"


class Response:
    def __init__(self, count=1, duplicates=0, status=200, raw=None):
        self.status = status
        self.raw = raw or json.dumps({"accepted": count - duplicates, "duplicates": duplicates}).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, size):
        return self.raw[:size]


@pytest.fixture
def reporter():
    instance = GateReporter(merchant_id=MERCHANT, merchant_secret="test-secret")
    instance._opener = Mock()
    instance._opener.open.side_effect = lambda req, timeout: Response(len(json.loads(req.data)["events"]))
    yield instance
    instance.close()


def event(resource="/api/*", kind="402", **extra):
    return {"kind": kind, "resource": resource, "weight": 1, **extra}


def test_wire_allowlist_batches_and_hook_isolation(reporter):
    reporter.on_event(event(kind="serve", exempt=True))
    reporter.on_event(event(kind="403"))
    for _ in range(51):
        reporter.on_event(event(agent="private", receipt_id="jwt-private", detail="customer-content"))
    assert reporter._opener.open.call_count == 0
    result = reporter.flush()
    assert result["delivered"] == 51
    assert reporter._opener.open.call_count == 2
    req = reporter._opener.open.call_args_list[0].args[0]
    assert req.full_url == f"https://api.aifinpay.io/v1/merchants/{MERCHANT}/gate-events"
    assert req.get_header("Aifp-merchant-secret") == "test-secret"
    wire = json.loads(req.data)["events"]
    assert len(wire) == 50
    assert set(wire[0]) == {"id", "kind", "resource", "at"}
    assert wire[0]["at"].endswith("Z")
    assert "test-secret" not in str(result) + repr(reporter)
    for resource in ("/a", "/b"):
        gate = Gate(merchant_id=MERCHANT, routes=[Route(pattern=resource, tier="standard")],
                    store=MemoryStore(), on_event=reporter.on_event)
        assert gate.decide(SimpleRequest(resource)).status == 402
    assert reporter.stats["queued"] == 2


def test_retry_same_identity_and_dedup_ack(reporter):
    reporter._opener.open.side_effect = [TimeoutError("secret timeout"), Response(1, duplicates=1)]
    reporter.on_event(event())
    assert reporter.flush()["last_error"] == "timeout"
    assert reporter.stats["queued"] == 1
    assert reporter.flush()["delivered"] == 1
    calls = reporter._opener.open.call_args_list
    assert calls[0].args[0].data == calls[1].args[0].data
    assert calls[0].kwargs["timeout"] == 3.0


@pytest.mark.parametrize("status", [400, 401, 403, 302, 307, 308])
def test_permanent_auth_and_redirect_stop(reporter, status):
    reporter._opener.open.side_effect = lambda *args, **kwargs: Response(status=status)
    reporter.on_event(event())
    assert reporter.flush()["stopped"] is True
    reporter.on_event(event())
    assert reporter.flush()["dropped"] == 2
    assert reporter._opener.open.call_count == 1


def test_real_redirect_handler_never_creates_followup_request():
    with pytest.raises(_RedirectBlocked):
        _NoRedirect().redirect_request(Mock(), Mock(), 302, "Moved", {"Location": "https://attacker.invalid"}, "https://attacker.invalid")


def test_backpressure_concurrent_threads_and_payment_path(reporter):
    threads = [threading.Thread(target=lambda: [reporter.on_event(event()) for _ in range(120)]) for _ in range(10)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()
    assert reporter.stats["queued"] == 1000
    assert reporter.stats["dropped"] == 200
    gate = Gate(merchant_id=MERCHANT, resource="/api", store=MemoryStore(), on_event=reporter.on_event)
    assert gate.decide(SimpleRequest("/api")).status == 402
    assert reporter.stats["dropped"] == 201


def test_finite_retries_and_expiry(reporter):
    reporter._opener.open.side_effect = lambda *args, **kwargs: Response(status=503)
    reporter.on_event(event())
    for _ in range(5):
        reporter.flush()
    assert reporter._opener.open.call_count == 5
    assert reporter.stats["last_error"] == "retry_exhausted"
    assert reporter.stats["dropped"] == 1
    reporter.on_event(event())
    with reporter._condition:
        reporter._queue[0]["created"] -= 901
    reporter.flush()
    assert reporter.stats["last_error"] == "expired"
    assert reporter.stats["dropped"] == 2


@pytest.mark.parametrize("resource", ["/api?q=private", "https://host/api", "/api#x", "/a/../b", "//host", "/a%2Fb", "/café", "/a+b", "/" + "x" * 512])
def test_canonical_resource_rejects_privacy_and_contract_poison(reporter, resource):
    reporter.on_event(event(resource))
    assert reporter.stats["queued"] == 0
    assert reporter.stats["last_error"] == "invalid_event"


@pytest.mark.parametrize("api_base", ["http://host", "https://user:pass@host", "https://host/api", "https://host?q=x", "https://host#x", "https://host:bad"])
def test_config_rejects_unsafe_origins(api_base):
    with pytest.raises(ValueError, match="HTTPS origin"):
        GateReporter(merchant_id=MERCHANT, merchant_secret="test-secret", api_base=api_base)


def test_bounded_response_and_sanitized_diagnostics(reporter):
    reporter._opener.open.side_effect = lambda *args, **kwargs: Response(raw=b"secret" * 1000)
    reporter.on_event(event())
    assert reporter.flush()["last_error"] == "invalid_response"
    assert reporter.stats["queued"] == 1


def test_close_deadline_and_no_new_work(reporter):
    started, unblock = threading.Event(), threading.Event()
    def blocked(*args, **kwargs):
        started.set()
        unblock.wait(5)
        return Response()
    reporter._opener.open.side_effect = blocked
    reporter.on_event(event())
    reporter.flush(timeout=0.05)
    assert started.wait(1)
    result = reporter.close(timeout=0.01)
    assert result["closed"] is True
    assert result["queued"] == 0
    assert result["last_error"] == "shutdown"
    reporter.on_event(event())
    unblock.set()
    reporter._worker.join(1)
    assert not reporter._worker.is_alive()
    assert reporter._opener.open.call_count == 1


def test_background_success_does_not_accumulate_ids(reporter):
    complete = threading.Event()
    reporter.DELAY = 0.01
    reporter._opener.open.side_effect = lambda *args, **kwargs: (complete.set(), Response())[1]
    for _ in range(5):
        complete.clear()
        reporter.on_event(event())
        assert complete.wait(1)
        with reporter._condition:
            while reporter._sending:
                reporter._condition.wait(1)
            assert len(reporter._flush_attempted) == 0
    assert reporter.stats["delivered"] == 5


def test_forked_instance_never_uses_inherited_lock(reporter, monkeypatch):
    monkeypatch.setattr("aifinpay_gate.reporter.os.getpid", lambda: reporter._pid + 1)
    reporter.on_event(event())
    assert reporter.stats["last_error"] == "wrong_process"
    assert reporter.close()["closed"] is True


def test_reporting_outage_preserves_real_paid_quota(reporter):
    from test_gate import KEY, NOW, jwk, req, token
    reporter._opener.open.side_effect = lambda *args, **kwargs: Response(status=503)
    gate = Gate(merchant_id=MERCHANT, resource="/paid", store=MemoryStore(),
                jwks={"keys": [jwk(KEY)]}, now=lambda: NOW, on_event=reporter.on_event)
    receipt = token(aud=MERCHANT, unit_quota=2)
    first = gate.decide(req(receipt))
    assert first.status == 200 and first.aifp["remaining"] == 1
    reporter.flush()
    second = gate.decide(req(receipt))
    assert second.status == 200 and second.aifp["remaining"] == 0
    assert gate.decide(req(receipt)).status == 402


@pytest.mark.parametrize("framework", ["fastapi", "flask"])
def test_framework_hooks_report_challenge_and_admission(reporter, framework):
    from test_gate import KEY, NOW, jwk, token
    from aifinpay_gate import AifpGateMiddleware, AifpGateWSGI
    gate = Gate(merchant_id=MERCHANT, resource="/api", store=MemoryStore(),
                jwks={"keys": [jwk(KEY)]}, now=lambda: NOW, on_event=reporter.on_event)
    if framework == "fastapi":
        fastapi = pytest.importorskip("fastapi")
        from fastapi.testclient import TestClient
        app = fastapi.FastAPI()
        app.add_middleware(AifpGateMiddleware, gate=gate)
        @app.get("/api")
        def handler():
            return {"ok": True}
        client = TestClient(app)
    else:
        flask = pytest.importorskip("flask")
        app = flask.Flask(__name__)
        app.wsgi_app = AifpGateWSGI(app.wsgi_app, gate)
        @app.get("/api")
        def handler():
            return {"ok": True}
        client = app.test_client()
    assert client.get("/api").status_code == 402
    receipt = token(aud=MERCHANT, resource="/api", unit_quota=2)
    assert client.get("/api", headers={"AIFP-Receipt": receipt}).status_code == 200
    assert reporter.flush()["delivered"] == 2
    wire = json.loads(reporter._opener.open.call_args.args[0].data)["events"]
    assert [item["kind"] for item in wire] == ["402", "serve"]
    assert all(item["resource"] == "/api" for item in wire)
    assert receipt not in str(wire)


def test_actual_exempt_gate_callback_is_not_reported(reporter):
    gate = Gate(merchant_id=MERCHANT, resource="/api", should_charge=lambda req: False,
                store=MemoryStore(), on_event=reporter.on_event)
    assert gate.decide(SimpleRequest("/api")).status == 200
    assert reporter.stats["queued"] == 0
