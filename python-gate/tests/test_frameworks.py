"""The README's FastAPI and Flask snippets, run for real (skipped when the
framework is not installed)."""

import pytest

import aifinpay_gate as g
from test_gate import KEY, MID, NOW, jwk, token


def make_gate():
    return g.Gate(MID, routes=[g.Route("/create", "premium", methods={"POST"}), g.Route("/api/*")],
                  jwks={"keys": [jwk(KEY)]}, now=lambda: NOW)


def test_fastapi_add_middleware_and_request_state():
    fastapi = pytest.importorskip("fastapi")
    from fastapi.testclient import TestClient

    app = fastapi.FastAPI()
    app.add_middleware(g.AifpGateMiddleware, gate=make_gate())

    @app.post("/create")
    async def create(request: fastapi.Request):
        return {"remaining": request.state.aifp["remaining"]}

    @app.get("/public")
    async def public():
        return {"ok": True}

    c = TestClient(app)
    assert c.post("/create").status_code == 402
    r = c.post("/create", headers={"AIFP-Receipt": token(resource="/create", unit_quota=30)})
    assert r.status_code == 200 and r.json() == {"remaining": 20} and r.headers["aifp-quota-remaining"] == "20"
    assert c.get("/public").json() == {"ok": True}
    assert c.get("/.well-known/x402.json").json()["merchant_id"] == MID


def test_flask_wsgi_app_and_environ():
    flask = pytest.importorskip("flask")
    app = flask.Flask(__name__)
    app.wsgi_app = g.AifpGateWSGI(app.wsgi_app, make_gate())

    @app.get("/api/data")
    def data():
        return {"used": flask.request.environ["aifp"]["used"]}

    c = app.test_client()
    assert c.get("/api/data").status_code == 402
    r = c.get("/api/data", headers={"AIFP-Receipt": token(resource="/api/*")})
    assert r.status_code == 200 and r.get_json() == {"used": 1} and r.headers["AIFP-Quota-Remaining"] == "9"
