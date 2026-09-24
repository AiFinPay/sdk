"""The ASGI and WSGI adapters: a decision is a response, a paid call reaches
the app with its metering context and the quota header."""

import asyncio
import io
import json

import aifinpay_gate as g
from test_gate import KEY, MID, NOW, jwk, token


def make_gate(**kw):
    return g.Gate(MID, routes=[g.Route("/paid"), g.Route("/boom")], jwks={"keys": [jwk(KEY)]}, now=lambda: NOW, **kw)


# ── ASGI ────────────────────────────────────────────────────────────────────


async def app(scope, receive, send):
    status = 500 if scope["path"] == "/boom" else 200
    body = json.dumps({"path": scope["path"], "aifp": (scope.get("state") or {}).get("aifp")}).encode()
    await send({"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json")]})
    await send({"type": "http.response.body", "body": body})


def call_asgi(mw, path, headers=None, method="GET"):
    sent = []

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(m):
        sent.append(m)

    scope = {"type": "http", "method": method, "path": path,
             "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]}
    asyncio.run(mw(scope, receive, send))
    start = sent[0]
    body = b"".join(m.get("body", b"") for m in sent[1:])
    return start["status"], {k.decode(): v.decode() for k, v in start["headers"]}, json.loads(body)


def test_asgi_answers_402_itself_and_passes_everything_else_through():
    mw = g.AifpGateMiddleware(app, make_gate())
    status, headers, body = call_asgi(mw, "/paid")
    assert status == 402 and headers["content-type"] == "application/json" and body["protocol"] == "AIFP-1"
    assert call_asgi(mw, "/free")[0] == 200


def test_asgi_serves_a_paid_call_with_context_and_quota_header():
    status, headers, body = call_asgi(g.AifpGateMiddleware(app, make_gate()), "/paid", {"AIFP-Receipt": token()})
    assert status == 200 and headers["aifp-quota-remaining"] == "9"
    assert body["aifp"]["receipt_id"] == "rcpt_1" and body["aifp"]["mode"] == "paid"


def test_asgi_serves_discovery():
    status, headers, body = call_asgi(g.AifpGateMiddleware(app, make_gate()), "/.well-known/x402.json")
    assert status == 200 and body["merchant_id"] == MID
    assert [r["resource"] for r in body["resources"]] == ["/paid", "/boom"]


def test_asgi_refunds_a_5xx_only_when_asked():
    gt = make_gate()
    call_asgi(g.AifpGateMiddleware(app, gt), "/boom", {"AIFP-Receipt": token(resource="/boom")})
    assert gt.store.get("aifp:used:rcpt_1") == 1
    gt = make_gate()
    call_asgi(g.AifpGateMiddleware(app, gt, refund_on_error=True), "/boom", {"AIFP-Receipt": token(resource="/boom")})
    assert gt.store.get("aifp:used:rcpt_1") == 0


# ── WSGI ────────────────────────────────────────────────────────────────────


def wsgi_app(environ, start_response):
    status = "500 Internal Server Error" if environ["PATH_INFO"] == "/boom" else "200 OK"
    start_response(status, [("Content-Type", "application/json")])
    return [json.dumps({"aifp": environ.get("aifp")}).encode()]


def call_wsgi(mw, path, headers=None, method="GET"):
    environ = {"PATH_INFO": path, "REQUEST_METHOD": method, "wsgi.input": io.BytesIO()}
    for k, v in (headers or {}).items():
        environ["HTTP_" + k.upper().replace("-", "_")] = v
    captured = {}

    def start_response(status, hdrs, exc_info=None):
        captured["status"], captured["headers"] = status, dict(hdrs)

    body = b"".join(mw(environ, start_response))
    return captured["status"], captured["headers"], json.loads(body)


def test_wsgi_answers_402_and_serves_a_paid_call():
    mw = g.AifpGateWSGI(wsgi_app, make_gate())
    status, _, body = call_wsgi(mw, "/paid")
    assert status.startswith("402") and body["error"] == "AIFP-402"
    status, headers, body = call_wsgi(mw, "/paid", {"AIFP-Receipt": token()})
    assert status == "200 OK" and headers["AIFP-Quota-Remaining"] == "9" and body["aifp"]["used"] == 1


def test_wsgi_passes_other_paths_through_and_serves_discovery():
    mw = g.AifpGateWSGI(wsgi_app, make_gate())
    assert call_wsgi(mw, "/free")[0] == "200 OK"
    assert call_wsgi(mw, "/.well-known/x402.json")[2]["protocol"] == "AIFP-1"
