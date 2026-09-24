"""WSGI middleware — Flask, Django, Bottle, any WSGI app.

    from aifinpay_gate import Gate, Route, AifpGateWSGI
    app.wsgi_app = AifpGateWSGI(app.wsgi_app, Gate("mrch_…", routes=[Route("/api/*")]))

Paid calls reach the app with the metering context in ``environ["aifp"]``
(Flask: ``request.environ["aifp"]``).
"""

import json
from typing import Any, Dict, Optional

from .core import Gate
from .discovery import DISCOVERY_PATH, build_discovery_document

_STATUS = {200: "200 OK", 402: "402 Payment Required", 403: "403 Forbidden", 503: "503 Service Unavailable"}


class _WsgiRequest:
    def __init__(self, environ: Dict[str, Any]):
        self.path = environ.get("PATH_INFO") or "/"
        self.method = environ.get("REQUEST_METHOD", "GET")
        self._environ = environ

    def header(self, name: str) -> Optional[str]:
        key = name.upper().replace("-", "_")
        if key in ("CONTENT_TYPE", "CONTENT_LENGTH"):
            return self._environ.get(key)
        return self._environ.get("HTTP_" + key)


def _json(start_response, status: int, headers: Dict[str, str], body: Any):
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    hdrs = [(k, v) for k, v in headers.items() if k.lower() != "content-type"]
    hdrs += [("Content-Type", "application/json"), ("Content-Length", str(len(raw)))]
    start_response(_STATUS.get(status, f"{status} Error"), hdrs)
    return [raw]


class AifpGateWSGI:
    def __init__(self, app, gate: Gate, serve_discovery: bool = True, refund_on_error: bool = False):
        self.app = app
        self.gate = gate
        self.serve_discovery = serve_discovery
        self.refund_on_error = refund_on_error
        self._discovery = build_discovery_document(gate.merchant_id, gate.discovery_resources(),
                                                   gate.api_base or "https://api.aifinpay.io")

    def __call__(self, environ, start_response):
        req = _WsgiRequest(environ)
        if self.serve_discovery and req.method == "GET" and req.path == DISCOVERY_PATH:
            return _json(start_response, 200, {"Cache-Control": "public, max-age=300"}, self._discovery)
        try:
            result = self.gate.decide(req)
        except Exception:  # noqa: BLE001 — a bug in this package, not a payment decision
            if self.gate.on_store_error == "open":
                return self.app(environ, start_response)
            return _json(start_response, 503, {}, {"error": "AIFP-503-METER",
                                                   "detail": "payment gate unavailable — retry shortly"})
        if result is None:
            return self.app(environ, start_response)
        if not result.ok:
            return _json(start_response, result.status, result.headers, result.body)

        environ["aifp"] = result.aifp
        extra = list(result.headers.items())

        def start_with_headers(status, headers, exc_info=None):
            if self.refund_on_error and str(status)[:1] == "5":
                self.gate.refund(result.aifp)
            return start_response(status, list(headers) + extra, exc_info) if exc_info else \
                start_response(status, list(headers) + extra)

        return self.app(environ, start_with_headers)
