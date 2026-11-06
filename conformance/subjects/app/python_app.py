"""The integration a merchant writes from python-gate/README.md: Route list, Redis counters, the v1 reporter."""
import hashlib
import json
import os
import re
import urllib.request
from urllib.parse import unquote

import redis
from aifinpay_gate import AifpGateMiddleware, AifpGateWSGI, Gate, GateReporter, RedisStore, Route, known_ai_agent
from starlette.applications import Starlette
from starlette.responses import Response
from starlette.routing import Route as Route_

env = os.environ
profile = json.loads(env["AIFP_PROFILE"])
marker = env["AIFP_MARKER"]
merchant = env["AIFP_MERCHANT_ID"]
reporter = GateReporter(merchant_id=merchant, merchant_secret=env["AIFP_MERCHANT_SECRET"], api_base=env["AIFP_API"])


def record():
    with urllib.request.urlopen(f"{env['AIFP_API']}/v1/merchants/{merchant}", timeout=2) as r:
        return json.loads(r.read())


try:
    policy = record()
except Exception:
    policy = None

gate = Gate(
    merchant,
    routes=[Route(r["pattern"], r["tier"], paywall=r.get("paywall", True)) for r in profile["resources"]],
    mode=profile["mode"],
    store=RedisStore(redis.Redis(host="127.0.0.1", port=int(env["REDIS_PORT"]))),
    jwks_uri=f"{env['AIFP_API']}/.well-known/jwks.json",
    api_base=env["AIFP_API"],
    should_charge=known_ai_agent if profile["charge"] == "agents" else None,
    operator_policy=policy,
    on_event=reporter.on_event,
)


def lenient(raw):
    path = raw.replace("\\", "/")
    for _ in range(3):
        path = re.sub(r"%([0-9a-fA-F]{2})", lambda m: chr(int(m[1], 16)) if int(m[1], 16) < 128 else m[0], path)
    out = []
    for part in path.split("/"):
        segment = part.split(";")[0]
        if segment in ("", "."):
            continue
        if segment == "..":
            if out:
                out.pop()
        else:
            out.append(segment)
    return "/" + "/".join(out).lower()


def answer(method, path, body, names):
    canonical = lenient(path)
    headers = {"content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=600", "x-origin-hit": "1",
               "x-origin-saw": ",".join(names)}
    if canonical == "/paid/err503":
        return 503, {**headers, "cache-control": "no-cache"}, b"ORIGIN-503"
    if method == "POST" and canonical == "/free/echo":
        headers["x-origin-sha256"] = hashlib.sha256(body).hexdigest()
    return 200, headers, f"<html><body>{marker} {canonical}</body></html>".encode()


async def asgi_origin(scope, receive, send):
    if scope["path"] == "/__conformance/flush":
        reporter.flush(timeout=3)
        await send({"type": "http.response.start", "status": 200, "headers": []})
        await send({"type": "http.response.body", "body": b"{}"})
        return
    body = b""
    while True:
        message = await receive()
        body += message.get("body", b"")
        if not message.get("more_body"):
            break
    raw = scope.get("raw_path", b"").decode("latin-1") or scope["path"]
    status, headers, payload = answer(scope["method"], raw, body, [k.decode("latin-1") for k, _ in scope["headers"]])
    existing = [(k.encode(), v.encode()) for k, v in headers.items()]
    await send({"type": "http.response.start", "status": status, "headers": existing})
    await send({"type": "http.response.body", "body": b"" if scope["method"] == "HEAD" else payload})


def wsgi_origin(environ, start_response):
    if environ["PATH_INFO"] == "/__conformance/flush":
        reporter.flush(timeout=3)
        start_response("200 OK", [])
        return [b"{}"]
    length = int(environ.get("CONTENT_LENGTH") or 0)
    body = environ["wsgi.input"].read(length) if length else b""
    names = [k[5:].replace("_", "-").lower() for k in environ if k.startswith("HTTP_")]
    status, headers, payload = answer(environ["REQUEST_METHOD"], environ.get("REQUEST_URI") or environ["PATH_INFO"], body, names)
    start_response(f"{status} {'OK' if status == 200 else 'Error'}", list(headers.items()))
    return [b"" if environ["REQUEST_METHOD"] == "HEAD" else payload]




async def starlette_handler(request):
    body = await request.body()
    status, headers, payload = answer(request.method, request.url.path, body, list(request.headers.keys()))
    return Response(b"" if request.method == "HEAD" else payload, status_code=status, headers=headers)


async def flush_handler(_request):
    reporter.flush(timeout=3)
    return Response(b"{}")


METHODS = ["GET", "HEAD", "POST", "OPTIONS"]
native = Starlette(routes=[
    Route_("/__conformance/flush", flush_handler),
    Route_("/paid", starlette_handler, methods=METHODS),
    Route_("/report", starlette_handler, methods=METHODS),
    Route_("/paid/{rest:path}", starlette_handler, methods=METHODS),
    Route_("/paid-internal/{rest:path}", starlette_handler, methods=METHODS),
    Route_("/free/{rest:path}", starlette_handler, methods=METHODS),
    Route_("/open/{rest:path}", starlette_handler, methods=METHODS),
    Route_("/paidx/{rest:path}", starlette_handler, methods=METHODS),
])

# A merchant's app routes natively; AIFP_ROUTING=lenient puts the gate in front of one that resolves spellings itself.
asgi = AifpGateMiddleware(asgi_origin if env.get("AIFP_ROUTING") == "lenient" else native, gate=gate)
wsgi = AifpGateWSGI(wsgi_origin, gate)

if __name__ == "__main__":
    port = int(env["PORT"])
    if env.get("AIFP_SERVER") == "wsgi":
        from waitress import serve

        serve(wsgi, host="127.0.0.1", port=port, threads=16, _quiet=True)
    else:
        import uvicorn

        uvicorn.run(asgi, host="127.0.0.1", port=port, log_level="warning")
