"""An HTML page that passes through the gate carries a Link to /llms.txt and
/.well-known/x402.json, so an agent that opened the home page — not an API —
finds the payment instructions. JSON never carries it, and nothing about a
decision, a status or a metered unit changes. Same header as @aifinpay/gate."""

import asyncio
import io
import json
import pathlib

import aifinpay_gate as g
from test_gate import KEY, MID, NOW, jwk, token

LINK = ('</llms.txt>; rel="alternate"; type="text/markdown"; title="AI agents: access and payment", '
        '</.well-known/x402.json>; rel="describedby"; type="application/json"')
HOME = b"<!doctype html><title>Home</title>"
FIXTURE = json.loads((pathlib.Path(__file__).parent / "fixtures" / "parity.json").read_text())


def test_the_header_and_the_html_check_match_the_node_package():
    for case in FIXTURE["discovery_link"]["headers"]:
        assert g.discovery_link_header(case["args"]) == case["header"], case
    for content_type, html in FIXTURE["discovery_link"]["html"]:
        assert g.is_html_content_type(content_type) is html, content_type
    assert g.discovery_link_header() == LINK
    assert g.LLMS_TXT_PATH == "/llms.txt"


def make_gate():
    return g.Gate(MID, routes=[g.Route("/paid")], jwks={"keys": [jwk(KEY)]}, now=lambda: NOW)


def asgi_app(kind, extra=()):
    async def app(scope, receive, send):
        html = scope["path"] != "/data"
        ctype = b"text/html; charset=utf-8" if html else b"application/json"
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(b"content-type", ctype), *extra]})
        await send({"type": "http.response.body", "body": HOME if html else b"{}"})
    return app


def call_asgi(mw, path, headers=None, method="GET"):
    sent = []

    async def receive():
        return {"type": "http.request", "body": b""}

    async def send(m):
        sent.append(m)

    scope = {"type": "http", "method": method, "path": path,
             "headers": [(k.lower().encode(), v.encode()) for k, v in (headers or {}).items()]}
    asyncio.run(mw(scope, receive, send))
    return sent[0]["status"], [(k.decode(), v.decode()) for k, v in sent[0]["headers"]]


def links(headers):
    return [v for k, v in headers if k.lower() == "link"]


def test_asgi_html_pages_carry_it_json_and_the_402_do_not():
    mw = g.AifpGateMiddleware(asgi_app("html"), make_gate())
    status, headers = call_asgi(mw, "/")
    assert status == 200 and links(headers) == [LINK]
    assert links(call_asgi(mw, "/", method="HEAD")[1]) == [LINK]
    assert links(call_asgi(mw, "/data")[1]) == []
    status, headers = call_asgi(mw, "/paid")
    assert status == 402 and links(headers) == []
    status, headers = call_asgi(mw, "/paid", {"AIFP-Receipt": token()})
    assert status == 200 and links(headers) == [LINK] and dict(headers)["aifp-quota-remaining"] == "9"


def test_asgi_keeps_the_pages_own_link_and_can_be_switched_off_or_moved():
    own = (b"link", b'</style.css>; rel="preload"; as="style"')
    mw = g.AifpGateMiddleware(asgi_app("html", [own]), make_gate())
    assert links(call_asgi(mw, "/")[1]) == ['</style.css>; rel="preload"; as="style"', LINK]
    assert links(call_asgi(g.AifpGateMiddleware(asgi_app("html"), make_gate(), discovery_link=False), "/")[1]) == []
    moved = g.AifpGateMiddleware(asgi_app("html"), make_gate(), discovery_link={"llms_txt": "/agents.md", "x402": False})
    assert links(call_asgi(moved, "/")[1]) == [
        '</agents.md>; rel="alternate"; type="text/markdown"; title="AI agents: access and payment"']


def wsgi_app(environ, start_response):
    html = environ["PATH_INFO"] != "/data"
    start_response("200 OK", [("Content-Type", "text/html" if html else "application/json")])
    return [HOME if html else b"{}"]


def call_wsgi(mw, path, headers=None):
    environ = {"PATH_INFO": path, "REQUEST_METHOD": "GET", "wsgi.input": io.BytesIO()}
    for k, v in (headers or {}).items():
        environ["HTTP_" + k.upper().replace("-", "_")] = v
    captured = {}

    def start_response(status, hdrs, exc_info=None):
        captured["status"], captured["headers"] = status, list(hdrs)

    b"".join(mw(environ, start_response))
    return captured["status"], captured["headers"]


def test_wsgi_html_pages_carry_it_json_and_the_402_do_not():
    mw = g.AifpGateWSGI(wsgi_app, make_gate())
    assert links(call_wsgi(mw, "/")[1]) == [LINK]
    assert links(call_wsgi(mw, "/data")[1]) == []
    status, headers = call_wsgi(mw, "/paid")
    assert status.startswith("402") and links(headers) == []
    status, headers = call_wsgi(mw, "/paid", {"AIFP-Receipt": token()})
    assert status == "200 OK" and links(headers) == [LINK]
    assert links(call_wsgi(g.AifpGateWSGI(wsgi_app, make_gate(), discovery_link=False), "/")[1]) == []


def test_the_reported_paths_carry_it_too():
    # With reporting on, both adapters take a separate response path.
    class Recorder:
        def on_event(self, event):
            pass

    def reporting_gate():
        return g.Gate(MID, routes=[g.Route("/paid")], jwks={"keys": [jwk(KEY)]}, now=lambda: NOW,
                      reporting=Recorder(), reporting_context=lambda _req: {"channel": "api", "consent": "denied"})

    status, headers = call_wsgi(g.AifpGateWSGI(wsgi_app, reporting_gate()), "/paid", {"AIFP-Receipt": token()})
    assert status == "200 OK" and links(headers) == [LINK]
    status, headers = call_asgi(g.AifpGateMiddleware(asgi_app("html"), reporting_gate()), "/paid",
                                {"AIFP-Receipt": token()})
    assert status == 200 and links(headers) == [LINK]
