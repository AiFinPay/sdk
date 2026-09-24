"""ASGI middleware — FastAPI, Starlette, Quart, Litestar, any ASGI app.

    from aifinpay_gate import Gate, Route, AifpGateMiddleware
    gate = Gate("mrch_…", routes=[Route("/create", "premium", methods={"POST"})])
    app.add_middleware(AifpGateMiddleware, gate=gate)

Paid calls reach the handler with the metering context in
``request.state.aifp`` (Starlette) — i.e. ``scope["state"]["aifp"]``. A gate
decision is always a response, never an exception: a 402 routed through an
app's error handler would come out as a 500, and an agent cannot pay a 500.
"""

import asyncio
import json
from typing import Any, Dict, Optional

from .core import Gate, GateResult
from .discovery import DISCOVERY_PATH, build_discovery_document


class _AsgiRequest:
    def __init__(self, scope: Dict[str, Any]):
        self.path = scope.get("path") or "/"
        self.method = scope.get("method", "GET")
        self._headers: Dict[str, str] = {}
        for k, v in scope.get("headers") or []:
            name = k.decode("latin-1").lower()
            self._headers.setdefault(name, v.decode("latin-1"))

    def header(self, name: str) -> Optional[str]:
        return self._headers.get(name.lower())


async def _send_json(send, status: int, headers: Dict[str, str], body: Any) -> None:
    raw = json.dumps(body, ensure_ascii=False, separators=(",", ":")).encode()
    hdrs = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in headers.items() if k.lower() != "content-type"]
    hdrs += [(b"content-type", b"application/json"), (b"content-length", str(len(raw)).encode())]
    await send({"type": "http.response.start", "status": status, "headers": hdrs})
    await send({"type": "http.response.body", "body": raw})


class AifpGateMiddleware:
    def __init__(self, app, gate: Gate, serve_discovery: bool = True, refund_on_error: bool = False):
        self.app = app
        self.gate = gate
        self.serve_discovery = serve_discovery
        self.refund_on_error = refund_on_error
        self._discovery = build_discovery_document(gate.merchant_id, gate.discovery_resources(),
                                                   gate.api_base or "https://api.aifinpay.io")

    async def __call__(self, scope, receive, send):
        if scope.get("type") != "http":
            return await self.app(scope, receive, send)
        req = _AsgiRequest(scope)
        if self.serve_discovery and req.method == "GET" and req.path == DISCOVERY_PATH:
            return await _send_json(send, 200, {"Cache-Control": "public, max-age=300"}, self._discovery)
        # decide() may block on a JWKS fetch or a Redis round-trip; keep that
        # off the event loop.
        try:
            result: Optional[GateResult] = await asyncio.get_running_loop().run_in_executor(
                None, self.gate.decide, req
            )
        except Exception:  # noqa: BLE001 — a bug in this package, not a payment decision
            if self.gate.on_store_error == "open":
                return await self.app(scope, receive, send)
            return await _send_json(send, 503, {}, {"error": "AIFP-503-METER",
                                                    "detail": "payment gate unavailable — retry shortly"})
        if result is None:
            return await self.app(scope, receive, send)
        if not result.ok:
            return await _send_json(send, result.status, result.headers, result.body)

        scope.setdefault("state", {})["aifp"] = result.aifp
        extra = [(k.lower().encode("latin-1"), v.encode("latin-1")) for k, v in result.headers.items()]
        status_seen = {}

        async def send_with_headers(message):
            if message["type"] == "http.response.start":
                status_seen["status"] = message.get("status", 200)
                message = {**message, "headers": list(message.get("headers") or []) + extra}
            await send(message)

        try:
            await self.app(scope, receive, send_with_headers)
        finally:
            if self.refund_on_error and status_seen.get("status", 500) >= 500:
                self.gate.refund(result.aifp)
