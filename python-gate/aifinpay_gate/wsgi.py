"""WSGI middleware — Flask, Django, Bottle, any WSGI app.

    from aifinpay_gate import Gate, Route, AifpGateWSGI
    app.wsgi_app = AifpGateWSGI(app.wsgi_app, Gate("mrch_…", routes=[Route("/api/*")]))

Paid calls reach the app with the metering context in ``environ["aifp"]``
(Flask: ``request.environ["aifp"]``).
"""

import json
import threading
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


class _ReportingIterable:
    """Observe exhaustion, early close and iteration exceptions exactly once.

    WSGI exposes delivery only through iteration/write/close, not socket ACK.
    Keep underlying close available even if the server closes before first next.
    """
    def __init__(self, iterable, emitted, finish):
        self._iterable, self._iterator = iterable, iter(iterable)
        self._emitted, self._finish = emitted, finish
        self._closed = False

    def __iter__(self):
        return self

    def __next__(self):
        if self._closed:
            raise StopIteration
        try:
            chunk = next(self._iterator)
            if chunk:
                self._emitted()
            return chunk
        except StopIteration:
            self._emitted()
            self._finish(False, None)
            self.close()
            raise
        except BaseException:
            self._finish(True, "upstream_error")
            self.close()
            raise

    def close(self):
        if self._closed:
            return
        self._closed = True
        self._finish(True, "client_abort")
        close = getattr(self._iterable, "close", None)
        if close:
            close()


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
        observation = self.gate.reporting_for(req, result)
        if observation is not None:
            return self._reported(environ, start_response, req, result, observation)
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

    def _reported(self, environ, start_response, req, result, observation):
        state = {"status": None, "sent": False, "terminal": False, "challenged": False}
        lock = threading.Lock()
        extra = list(result.headers.items()) if result.ok else []

        def emitted():
            with lock:
                state["sent"] = state["status"] is not None
                if result.status == 402 and state["sent"] and not state["challenged"]:
                    state["challenged"] = True
                    self.gate.report_observation(observation, "access_challenged", reason=(
                        "quota_exhausted" if (result.body or {}).get("detail") == "quota exhausted — prepay the next batch"
                        else "receipt_rejected" if req.header("AIFP-Receipt") else "receipt_missing"))

        def finish(abort, reason):
            with lock:
                if state["terminal"] or not result.ok:
                    return
                state["terminal"] = True
                status = state["status"] if state["sent"] else None
                outcome = "abort" if abort or status is None else (
                    "success" if 200 <= status < 300 else "redirect" if 300 <= status < 400 else "error")
                self.gate.report_observation(observation, "resource_response_completed", outcome=outcome,
                                             **({"status": status} if status is not None else {}),
                                             **({"reason": reason} if reason else {}))

        def start_observed(status, headers, exc_info=None):
            write = start_response(status, list(headers) + extra, exc_info) if exc_info else start_response(status, list(headers) + extra)
            state["status"] = int(str(status).split(" ", 1)[0])
            if self.refund_on_error and result.ok and str(status)[:1] == "5":
                self.gate.refund(result.aifp)
            if write is None:
                return None
            def write_observed(data):
                try:
                    write(data)
                except BaseException:
                    finish(True, "client_abort")
                    raise
                emitted()
            return write_observed

        if not result.ok:
            return _ReportingIterable(_json(start_observed, result.status, result.headers, result.body), emitted, finish)
        environ["aifp"] = result.aifp
        self.gate.report_observation(observation, "access_admitted")
        try:
            return _ReportingIterable(self.app(environ, start_observed), emitted, finish)
        except BaseException:
            finish(True, "upstream_error")
            raise
