"""Receipt verification, metering and the adapters' failure paths.

The parity fixtures pin the answers Node gives; these cover what they cannot
record: every way a receipt is refused before it is metered, how a quota is
read off a receipt, replay protection, the JWKS failure modes, and what the
ASGI/WSGI adapters do when the gate itself cannot decide.
"""

import io
import json
import threading
import time
import urllib.error
from types import SimpleNamespace

import pytest

import aifinpay_gate as g
from aifinpay_gate import verify as verify_mod
from aifinpay_gate.verify import JwksUnavailable, RemoteJwks
from test_adapters import app, call_asgi, call_wsgi, wsgi_app
from test_gate import KEY, MID, NOW, OTHER, b64, gate, jwk, req, token

ISS = "https://api.aifinpay.io"


def verifier(keys=None, **kw):
    return g.Verifier(ISS, MID, jwks={"keys": keys if keys is not None else [jwk(KEY)]}, now=lambda: NOW, **kw)


def raw_token(header, payload, key=KEY):
    h = b64(json.dumps(header).encode())
    p = b64(json.dumps(payload).encode())
    return f"{h}.{p}.{b64(key.sign(f'{h}.{p}'.encode()).signature)}"


CLAIMS = {"iss": ISS, "aud": MID, "sub": "0xabc", "exp": NOW + 3600, "resource": "/paid", "unit_quota": 10,
          "receipt_id": "rcpt_1", "nonce": "n1"}


# ── what is refused before any key is consulted ─────────────────────────────


@pytest.mark.parametrize("bad", [
    "only.two",                  # two segments
    "a.b.c.d",                   # four segments
    "x" * 32768 + ".a.b",        # over the 32 KiB ceiling
    12345,                       # not a string at all
    "%%%.%%%.%%%",               # not base64url
])
def test_a_malformed_token_is_invalid_and_never_metered(bad):
    kind, reason = verifier()(bad)
    assert kind == "invalid" and "malformed" in reason
    gt = gate()
    if isinstance(bad, str):
        r = gt.decide(req(bad))
        assert r.status == 403 and r.body["detail"] == g.DETAIL_VERIFY_FAILED
        assert gt.store.get("aifp:used:rcpt_1") is None


@pytest.mark.parametrize("header_json", [b"[]", b'"EdDSA"', b"7"])
def test_a_header_that_is_json_but_not_an_object_is_invalid(header_json):
    tok = f"{b64(header_json)}.{b64(json.dumps(CLAIMS).encode())}.{b64(b'x' * 64)}"
    assert verifier()(tok) == ("invalid", "malformed JWT")


def test_a_payload_that_is_not_an_object_is_invalid():
    h = b64(json.dumps({"alg": "EdDSA", "kid": "k1"}).encode())
    p = b64(b"[1,2,3]")
    tok = f"{h}.{p}.{b64(KEY.sign(f'{h}.{p}'.encode()).signature)}"
    assert verifier()(tok) == ("invalid", "malformed JWT")


@pytest.mark.parametrize("alg", ["HS256", "none", "ES256", None])
def test_only_eddsa_is_accepted_even_when_correctly_signed(alg):
    header = {"typ": "JWT", "kid": "k1"} | ({"alg": alg} if alg else {})
    kind, reason = verifier()(raw_token(header, CLAIMS))
    assert kind == "invalid" and "alg" in reason


def test_a_non_string_kid_is_invalid():
    assert verifier()(raw_token({"alg": "EdDSA", "kid": 7}, CLAIMS)) == ("invalid", 'invalid "kid"')


# ── which keys in the JWKS may verify a receipt ─────────────────────────────


def _good(**over):
    return {**jwk(KEY), **over}


@pytest.mark.parametrize("unusable", [
    _good(kty="RSA"),
    _good(crv="X25519"),
    _good(alg="RS256"),
    _good(use="enc"),
    _good(key_ops=["sign"]),
    {k: v for k, v in jwk(KEY).items() if k != "x"},
    "not-a-key",
])
def test_a_key_that_is_not_an_ed25519_verification_key_is_never_used(unusable):
    kind, reason = verifier([unusable])(token())
    assert (kind, reason) == ("invalid", "no applicable key in the JWKS")


def test_a_key_restricted_to_verify_is_used():
    assert verifier([_good(key_ops=["verify"])])(token())[0] == "ok"


def test_a_token_signed_by_a_different_key_with_the_same_kid_fails_signature_verification():
    assert verifier()(token(key=OTHER)) == ("invalid", "signature verification failed")


def test_a_token_without_kid_is_tried_against_every_candidate_key():
    keys = [jwk(OTHER, "k2"), {**jwk(KEY, "k1"), "x": b64(b"short")}, jwk(KEY, "k3")]
    tok = raw_token({"alg": "EdDSA", "typ": "JWT"}, CLAIMS)
    assert verifier(keys)(tok)[0] == "ok"
    assert verifier(keys[:2])(tok) == ("invalid", "signature verification failed")


# ── claims ──────────────────────────────────────────────────────────────────


def test_issuer_and_audience_are_exact():
    assert verifier()(token(iss="https://evil.example"))[1] == 'unexpected "iss" claim value'
    assert verifier()(token(aud="mrch_other"))[1] == 'unexpected "aud" claim value'
    assert verifier()(token(aud=["mrch_other", MID]))[0] == "ok"
    assert verifier()(token(aud=["mrch_other"]))[1] == 'unexpected "aud" claim value'


@pytest.mark.parametrize("claim,value", [("iat", "1800000000"), ("iat", True), ("nbf", False), ("nbf", "0")])
def test_iat_and_nbf_must_be_numbers(claim, value):
    kind, reason = verifier()(token(**{claim: value}))
    assert kind == "invalid" and claim in reason


@pytest.mark.parametrize("exp", ["1900000000", True, None])
def test_exp_must_be_a_number(exp):
    assert verifier()(token(exp=exp)) == ("invalid", '"exp" claim must be a number')


@pytest.mark.parametrize("nbf,ok", [(NOW + 29, True), (NOW + 30, True), (NOW + 31, False)])
def test_not_before_honours_the_clock_tolerance_and_no_more(nbf, ok):
    assert (verifier()(token(nbf=nbf))[0] == "ok") is ok


@pytest.mark.parametrize("exp,kind", [(NOW + 1, "ok"), (NOW - 29, "ok"), (NOW - 30, "expired"), (NOW - 3600, "expired")])
def test_expiry_honours_the_clock_tolerance_and_no_more(exp, kind):
    assert verifier()(token(exp=exp))[0] == kind


def test_an_expired_receipt_is_answered_with_a_new_offer_not_a_refusal():
    r = gate().decide(req(token(exp=NOW - 600)))
    assert r.status == 402 and r.body["detail"] == g.DETAIL_RECEIPT_EXPIRED


# ── the remote key set ──────────────────────────────────────────────────────


class FakeResponse:
    def __init__(self, body: bytes):
        self._body = io.BytesIO(body)

    def __enter__(self):
        return self

    def __exit__(self, *exc):
        return False

    def read(self, n=-1):
        return self._body.read(n)


def remote_gate(monkeypatch, urlopen):
    monkeypatch.setattr(verify_mod.urllib.request, "urlopen", urlopen)
    return gate(jwks=None)


def test_a_fetched_jwks_verifies_receipts(monkeypatch):
    seen = {}

    def urlopen(request, timeout):
        seen["url"], seen["timeout"] = request.full_url, timeout
        return FakeResponse(json.dumps({"keys": [jwk(KEY)]}).encode())

    assert remote_gate(monkeypatch, urlopen).decide(req(token())).ok
    assert seen == {"url": "https://api.aifinpay.io/.well-known/jwks.json", "timeout": 5}


@pytest.mark.parametrize("failure", [
    urllib.error.URLError("connection refused"),
    TimeoutError("timed out"),
    b"<html>not json</html>",
    b'{"no_keys": []}',
    b'{"keys": "not-a-list"}',
    b"[]",
])
def test_an_unusable_jwks_fails_closed(monkeypatch, failure):
    def urlopen(request, timeout):
        if isinstance(failure, Exception):
            raise failure
        return FakeResponse(failure)

    gt = remote_gate(monkeypatch, urlopen)
    r = gt.decide(req(token()))
    assert (r.status, r.body["error"], r.headers["Retry-After"]) == (503, "AIFP-503-METER", "30")
    assert gt.store.get("aifp:used:rcpt_1") is None


def fake_clock(monkeypatch, start=1000.0):
    clock = [start]
    monkeypatch.setattr(verify_mod, "time", SimpleNamespace(monotonic=lambda: clock[0], time=time.time))
    return clock


def test_a_stale_jwks_is_refetched_after_its_max_age(monkeypatch):
    clock = fake_clock(monkeypatch)
    sets = [[jwk(KEY, "k1")], [jwk(OTHER, "k1")]]  # the issuer replaced the key behind the same kid

    def fetch(uri, timeout):
        return sets.pop(0)

    gt = gate(jwks=None)
    gt.verify.key_set = RemoteJwks("https://x/jwks", fetch=fetch, cache_max_age_s=600, cooldown_s=30)
    assert gt.decide(req(token())).ok
    clock[0] += 601
    r = gt.decide(req(token(receipt_id="rcpt_2")))
    assert r.status == 403, "after max-age the replaced key set is authoritative"
    assert gt.decide(req(token(key=OTHER, receipt_id="rcpt_3"))).ok


def test_an_unknown_kid_does_not_refetch_inside_the_cooldown(monkeypatch):
    clock = fake_clock(monkeypatch)
    rotated = [False]

    def fetch(uri, timeout):
        return [jwk(KEY, "k1")] + ([jwk(OTHER, "k2")] if rotated[0] else [])

    gt = gate(jwks=None)
    gt.verify.key_set = RemoteJwks("https://x/jwks", fetch=fetch, cooldown_s=30)
    assert gt.decide(req(token())).ok
    rotated[0] = True
    clock[0] += 10  # the issuer has rotated, but an unknown kid may not hammer the JWKS
    assert gt.decide(req(token(key=OTHER, kid="k2", receipt_id="rcpt_2"))).status == 403
    clock[0] += 30
    assert gt.decide(req(token(key=OTHER, kid="k2", receipt_id="rcpt_3"))).ok


# ── configuration fails at construction, not at the first paid call ────────


@pytest.mark.parametrize("kw,message", [
    ({"merchant_id": ""}, "merchant_id"),
    ({"resource": "/a", "routes": []}, "not both"),
    ({"replay": "sometimes"}, "replay"),
    ({"on_store_error": "ignore"}, "on_store_error"),
])
def test_an_invalid_gate_is_refused_at_construction(kw, message):
    args = {"merchant_id": MID, "jwks": {"keys": []}} | kw
    with pytest.raises(ValueError, match=message):
        g.Gate(args.pop("merchant_id"), **args)


@pytest.mark.parametrize("weight", [0, -1, 2.5, "4"])
def test_an_unusable_mount_weight_falls_back_to_the_tier_price_not_to_free(weight):
    r = gate(tier="complex", weight=weight).decide(req())
    assert r.status == 402 and r.body["unit_weight"] == 4


@pytest.mark.parametrize("kw", [
    {"pattern": "api/*"},
    {"pattern": "/api*"},
    {"pattern": "/a/*/b"},
    {"pattern": "/x", "weight": 0},
    {"pattern": "/x", "weight": 1.5},
    {"pattern": "/x", "tier": "basic"},
])
def test_an_invalid_route_is_refused(kw):
    with pytest.raises(ValueError):
        g.Route(**kw)


def test_route_methods_are_case_insensitive():
    gt = gate(routes=[g.Route("/create", "premium", methods={"post"})])
    assert gt.decide(req(path="/create", method="POST")).status == 402
    assert gt.decide(req(path="/create", method="get")) is None


# ── refusals that cost the agent nothing ────────────────────────────────────


def test_a_merchant_veto_applies_to_free_routes_and_to_exempt_readers():
    veto = lambda ctx: False  # noqa: E731
    free = gate(routes=[g.Route("/health", paywall=False)], allow=veto).decide(req(path="/health"))
    assert free.status == 403 and free.body["detail"] == "blocked by merchant policy"
    exempt = gate(should_charge=lambda r: False, allow=veto).decide(req())
    assert exempt.status == 403


def test_an_exempt_reader_is_served_free_and_told_so():
    r = gate(should_charge=lambda r: False).decide(req())
    assert r.ok and r.headers == {"AIFP-Paywall": "exempt"} and r.aifp["mode"] == "exempt" and r.aifp["weight"] == 0


@pytest.mark.parametrize("receipt_id", [None, "", 42, ["rcpt"]])
def test_a_receipt_that_cannot_be_metered_is_refused(receipt_id):
    gt = gate()
    r = gt.decide(req(token(receipt_id=receipt_id)))
    assert r.status == 403 and "cannot be metered" in r.body["detail"]


@pytest.mark.parametrize("typ", ["access", "settlement", ""])
def test_only_quota_receipts_buy_calls(typ):
    r = gate().decide(req(token(typ_aifp=typ)))
    assert r.status == 403 and "not spendable" in r.body["detail"]


def test_agent_match_is_enforced_only_when_the_agent_names_itself():
    gt = gate(require_agent_match=True)
    assert gt.decide(req(token(), **{"AIFP-Agent-Id": "0xdef"})).status == 403
    assert gt.decide(req(token(), **{"AIFP-Agent-Id": "0xabc"})).ok
    assert gt.decide(req(token())).ok


# ── how much a receipt buys ─────────────────────────────────────────────────


def spend(gt, tok, n, **kw):
    return [gt.decide(req(tok, **kw)).status for _ in range(n)]


def test_a_numeric_string_quota_is_read_as_a_number():
    assert spend(gate(), token(unit_quota="3"), 4) == [200, 200, 200, 402]


def test_a_fractional_quota_buys_only_whole_calls():
    gt = gate()
    assert spend(gt, token(unit_quota=2.5), 3) == [200, 200, 402]


@pytest.mark.parametrize("quota", ["Infinity", "-Infinity", "0x10", "", None])
def test_a_quota_that_is_not_a_finite_positive_number_is_refused(quota):
    r = gate().decide(req(token(unit_quota=quota, quota=None if quota is None else 0)))
    if quota is None:  # no unit_quota and a zero legacy quota: one call at the tier weight
        assert r.ok and r.aifp["unit_quota"] == 1
    else:
        assert r.status == 403 and "unit_quota" in r.body["detail"]


def test_a_legacy_request_quota_converts_at_the_tier_it_was_priced_for():
    # 3 premium requests bought before billing units = 30 units; a premium call costs 10.
    gt = gate(tier="premium")
    assert spend(gt, token(unit_quota=None, quota=3, tier="premium"), 4) == [200, 200, 200, 402]
    gt = gate(tier="standard")
    statuses = spend(gt, token(unit_quota=None, quota=3, tier="premium", receipt_id="rcpt_2"), 31)
    assert statuses.count(200) == 30 and statuses[-1] == 402


def test_remaining_is_reported_per_call_in_billing_units():
    gt = gate(tier="complex")
    r = gt.decide(req(token(unit_quota=10)))
    assert r.aifp["weight"] == 4 and r.aifp["used"] == 4 and r.headers[g.HEADER_QUOTA_REMAINING] == "6"


# ── replay protection ───────────────────────────────────────────────────────


def test_a_single_use_receipt_is_spent_exactly_once_under_concurrency():
    gt, tok = gate(), token(unit_quota=1, nonce="n-once")
    results, barrier = [], threading.Barrier(50)

    def hit():
        barrier.wait()
        results.append(gt.decide(req(tok)))

    threads = [threading.Thread(target=hit) for _ in range(50)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    assert sum(r.ok for r in results) == 1
    assert all(r.body["detail"] == "receipt already spent (single-use)" for r in results if not r.ok)


@pytest.mark.parametrize("nonce", [None, "", 5])
def test_a_single_use_receipt_without_a_nonce_is_refused(nonce):
    r = gate().decide(req(token(unit_quota=1, nonce=nonce)))
    assert r.status == 403 and "nonce" in r.body["detail"]


def test_replay_always_makes_a_multi_call_receipt_single_presentation():
    gt = gate(replay="always")
    assert spend(gt, token(unit_quota=10), 2) == [200, 403]


def test_replay_off_meters_a_single_call_receipt_without_a_nonce():
    gt = gate(replay="off")
    assert spend(gt, token(unit_quota=1, nonce=None), 2) == [200, 402]


class FailingNonceStore(g.MemoryStore):
    def incr_by(self, key, by, ttl_ms):
        if ":nonce:" in key:
            raise ConnectionError("redis down")
        return super().incr_by(key, by, ttl_ms)


def test_a_store_failure_on_the_nonce_check_fails_closed_by_default():
    r = gate(store=FailingNonceStore()).decide(req(token(unit_quota=1)))
    assert (r.status, r.headers["Retry-After"]) == (503, "5")


def test_a_store_failure_on_the_nonce_check_serves_uncounted_only_when_opened():
    r = gate(store=FailingNonceStore(), on_store_error="open").decide(req(token(unit_quota=1)))
    assert r.ok and r.headers == {"AIFP-Meter": "degraded"} and r.aifp["used"] == 0


# ── refunds are best effort and never raise ─────────────────────────────────


def test_refund_ignores_anything_that_was_not_a_paid_call():
    gt = gate(should_charge=lambda r: False)
    gt.refund(None)
    gt.refund({})
    gt.refund(gt.decide(req()).aifp)  # exempt: nothing was metered
    paid = gate()
    r = paid.decide(req(token()))
    paid.refund({**r.aifp, "weight": 0})
    assert paid.store.get("aifp:used:rcpt_1") == 1


class NoDecrStore:
    def __init__(self):
        self.inner = g.MemoryStore()

    def incr_by(self, *a):
        return self.inner.incr_by(*a)


class RaisingDecrStore(g.MemoryStore):
    def decr_by(self, key, by):
        raise ConnectionError("redis down")


@pytest.mark.parametrize("store", [NoDecrStore, RaisingDecrStore])
def test_refund_on_a_store_that_cannot_decrement_is_a_no_op(store):
    gt = gate(store=store())
    r = gt.decide(req(token()))
    gt.refund(r.aifp)  # must not raise


# ── stores ──────────────────────────────────────────────────────────────────


def test_a_full_memory_store_makes_room_from_expired_counters_only():
    s = g.MemoryStore(max_keys=1)
    s.incr_by("old", 1, 1)
    time.sleep(0.01)
    assert s.incr_by("new", 1, 60_000) == 1
    assert s.get("old") is None


def test_decrementing_a_missing_counter_creates_nothing():
    s = g.MemoryStore()
    assert s.decr_by("missing", 3) == 0
    assert s.get("missing") is None


# ── discovery ───────────────────────────────────────────────────────────────


def test_discovery_lists_what_is_for_sale():
    assert gate().discovery_resources() == [{"resource": "/paid", "tier": "standard"}]
    assert g.Gate(MID, jwks={"keys": []}).discovery_resources() == []
    gt = gate(routes=[g.Route("/a", "premium"), g.Route("/health", paywall=False)])
    assert gt.discovery_resources() == [{"resource": "/a", "tier": "premium"}]


# ── adapters: the gate's own failures ───────────────────────────────────────


class ExplodingGate(g.Gate):
    def decide(self, request):
        raise RuntimeError("bug in the gate")


def exploding(**kw):
    return ExplodingGate(MID, routes=[g.Route("/paid")], jwks={"keys": [jwk(KEY)]}, now=lambda: NOW, **kw)


def test_asgi_fails_closed_when_the_gate_cannot_decide():
    status, _, body = call_asgi(g.AifpGateMiddleware(app, exploding()), "/paid")
    assert status == 503 and body["error"] == "AIFP-503-METER"


def test_asgi_passes_through_on_a_gate_failure_only_when_opened():
    status, _, body = call_asgi(g.AifpGateMiddleware(app, exploding(on_store_error="open")), "/paid")
    assert status == 200 and body["aifp"] is None


def test_wsgi_fails_closed_when_the_gate_cannot_decide():
    status, _, body = call_wsgi(g.AifpGateWSGI(wsgi_app, exploding()), "/paid")
    assert status.startswith("503") and body["error"] == "AIFP-503-METER"
    status, _, body = call_wsgi(g.AifpGateWSGI(wsgi_app, exploding(on_store_error="open")), "/paid")
    assert status == "200 OK" and body["aifp"] is None


def make_gate(**kw):
    kw.setdefault("jwks", {"keys": [jwk(KEY)]})
    return g.Gate(MID, routes=[g.Route("/paid"), g.Route("/boom")], now=lambda: NOW, **kw)


def test_asgi_answers_a_refusal_with_its_status_and_retry_header():
    status, _, body = call_asgi(g.AifpGateMiddleware(app, make_gate()), "/paid", {"AIFP-Receipt": token(key=OTHER)})
    assert status == 403 and body["detail"] == g.DETAIL_VERIFY_FAILED

    def down(uri, timeout):
        raise JwksUnavailable("down")

    gt = make_gate(jwks=None)
    gt.verify.key_set = RemoteJwks("https://x/jwks", fetch=down)
    status, headers, body = call_asgi(g.AifpGateMiddleware(app, gt), "/paid", {"AIFP-Receipt": token()})
    assert (status, headers["retry-after"], body["error"]) == (503, "30", "AIFP-503-METER")


def test_asgi_leaves_non_http_scopes_alone():
    seen = []

    async def lifespan_app(scope, receive, send):
        seen.append(scope["type"])

    import asyncio

    async def noop(*_):
        return None

    asyncio.run(g.AifpGateMiddleware(lifespan_app, make_gate())({"type": "lifespan"}, noop, noop))
    assert seen == ["lifespan"]


def test_discovery_can_be_left_to_the_app():
    mw = g.AifpGateMiddleware(app, make_gate(), serve_discovery=False)
    status, _, body = call_asgi(mw, "/.well-known/x402.json")
    assert status == 200 and body["path"] == "/.well-known/x402.json"
    status, _, body = call_wsgi(g.AifpGateWSGI(wsgi_app, make_gate(), serve_discovery=False), "/.well-known/x402.json")
    assert status == "200 OK" and "aifp" in body


def test_wsgi_refunds_a_5xx_only_when_asked():
    gt = make_gate()
    call_wsgi(g.AifpGateWSGI(wsgi_app, gt), "/boom", {"AIFP-Receipt": token(resource="/boom")})
    assert gt.store.get("aifp:used:rcpt_1") == 1
    gt = make_gate()
    call_wsgi(g.AifpGateWSGI(wsgi_app, gt, refund_on_error=True), "/boom", {"AIFP-Receipt": token(resource="/boom")})
    assert gt.store.get("aifp:used:rcpt_1") == 0
    gt = make_gate()
    call_wsgi(g.AifpGateWSGI(wsgi_app, gt, refund_on_error=True), "/paid", {"AIFP-Receipt": token()})
    assert gt.store.get("aifp:used:rcpt_1") == 1


def test_wsgi_reads_content_type_from_its_cgi_name():
    charge_json = lambda r: r.header("Content-Type") == "application/json"  # noqa: E731
    gt = g.Gate(MID, routes=[g.Route("/paid")], jwks={"keys": [jwk(KEY)]}, now=lambda: NOW, should_charge=charge_json)
    mw = g.AifpGateWSGI(wsgi_app, gt)
    environ = {"PATH_INFO": "/paid", "REQUEST_METHOD": "POST", "wsgi.input": io.BytesIO(),
               "CONTENT_TYPE": "application/json"}
    captured = {}
    mw(environ, lambda status, headers, exc_info=None: captured.setdefault("status", status))
    assert captured["status"].startswith("402")
    assert call_wsgi(mw, "/paid", method="POST")[0] == "200 OK"
