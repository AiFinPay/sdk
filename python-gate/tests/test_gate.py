"""What the Node fixtures cannot record: concurrency, TTLs, failing stores and
key sets, routes mode, and the places this port is deliberately stricter."""

import base64
import json
import threading

import nacl.signing
import pytest

import aifinpay_gate as g
from aifinpay_gate.verify import JwksUnavailable, RemoteJwks

KEY = nacl.signing.SigningKey(b"\x07" * 32)
OTHER = nacl.signing.SigningKey(b"\x0a" * 32)
MID = "mrch_test"
NOW = 1_800_000_000


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def jwk(key, kid="k1"):
    return {"kty": "OKP", "crv": "Ed25519", "x": b64(bytes(key.verify_key)), "kid": kid, "alg": "EdDSA"}


def token(key=KEY, kid="k1", **claims):
    c = {"iss": "https://api.aifinpay.io", "aud": MID, "sub": "0xabc", "iat": NOW, "exp": NOW + 3600,
         "resource": "/paid", "scope": "exact", "unit_quota": 10, "receipt_id": "rcpt_1", "nonce": "n1"}
    c.update(claims)
    c = {k: v for k, v in c.items() if v is not None}
    h = b64(json.dumps({"alg": "EdDSA", "typ": "JWT", "kid": kid}).encode())
    p = b64(json.dumps(c).encode())
    return f"{h}.{p}.{b64(key.sign(f'{h}.{p}'.encode()).signature)}"


def gate(**kw):
    kw.setdefault("jwks", {"keys": [jwk(KEY)]})
    if "routes" not in kw:
        kw.setdefault("resource", "/paid")
    return g.Gate(MID, now=lambda: NOW, **kw)


def req(tok=None, path="/paid", method="GET", **headers):
    if tok:
        headers["AIFP-Receipt"] = tok
    return g.SimpleRequest(path, headers, method)


# ── metering ────────────────────────────────────────────────────────────────


def test_a_burst_serves_exactly_the_batch_and_each_remaining_count_once():
    gt, tok = gate(), token(unit_quota=50)
    results, barrier = [], threading.Barrier(200)

    def hit():
        barrier.wait()
        results.append(gt.decide(req(tok)))

    threads = [threading.Thread(target=hit) for _ in range(200)]
    [t.start() for t in threads]
    [t.join() for t in threads]
    served = [r for r in results if r.ok]
    assert len(served) == 50
    assert sorted(r.aifp["remaining"] for r in served) == list(range(50))
    assert all(r.status == 402 and r.body["detail"] == g.DETAIL_QUOTA_EXHAUSTED for r in results if not r.ok)


class RecordingStore(g.MemoryStore):
    def __init__(self):
        super().__init__()
        self.calls = []

    def incr_by(self, key, by, ttl_ms):
        self.calls.append((key, by, ttl_ms))
        return super().incr_by(key, by, ttl_ms)


def test_the_counter_is_keyed_by_receipt_and_dies_with_it():
    store = RecordingStore()
    gate(store=store, key_prefix="tenant1:").decide(req(token(exp=NOW + 120)))
    assert store.calls == [("tenant1:used:rcpt_1", 1, 120_000)]


def test_the_ttl_is_floored_at_one_second():
    store = RecordingStore()
    gate(store=store).decide(req(token(exp=NOW + 0.2)))
    assert store.calls[0][2] == 1000


def test_the_ttl_is_set_on_the_first_write_only():
    s = g.MemoryStore()
    s.incr_by("k", 1, 50)
    s.incr_by("k", 1, 10_000_000)
    assert s.get("k") == 2
    import time
    time.sleep(0.06)
    assert s.get("k") is None, "a later write must not have extended the TTL"


def test_a_full_memory_store_refuses_instead_of_forgetting_a_live_counter():
    s = g.MemoryStore(max_keys=2)
    s.incr_by("a", 1, 60_000)
    s.incr_by("b", 1, 60_000)
    with pytest.raises(g.StoreCapacityError):
        s.incr_by("c", 1, 60_000)
    assert s.get("a") == 1 and s.get("b") == 1


class BrokenStore:
    def incr_by(self, *a):
        raise ConnectionError("redis down")


def test_a_failing_store_closes_by_default():
    r = gate(store=BrokenStore()).decide(req(token()))
    assert (r.status, r.body["error"], r.headers["Retry-After"]) == (503, "AIFP-503-METER", "5")


def test_a_failing_store_can_be_opened_explicitly_and_says_so():
    r = gate(store=BrokenStore(), on_store_error="open").decide(req(token()))
    assert r.ok and r.headers == {"AIFP-Meter": "degraded"} and r.aifp["used"] == 0


def test_a_refused_call_spends_nothing():
    gt = gate()
    gt.decide(req(token(resource="/other")))
    assert gt.store.get("aifp:used:rcpt_1") is None


def test_refund_gives_the_units_back():
    gt = gate()
    r = gt.decide(req(token()))
    gt.refund(r.aifp)
    assert gt.store.get("aifp:used:rcpt_1") == 0


# ── stricter than Node, on purpose ─────────────────────────────────────────


def test_a_receipt_without_exp_is_refused():
    assert gate().decide(req(token(exp=None))).status == 403


@pytest.mark.parametrize("quota", ["lots", 0, -5])
def test_a_receipt_without_a_usable_quota_is_refused_not_served_forever(quota):
    r = gate().decide(req(token(unit_quota=quota)))
    assert r.status == 403 and "unit_quota" in r.body["detail"]


def test_a_crit_header_is_refused():
    tok = token()
    h, p, _ = tok.split(".")
    header = json.loads(base64.urlsafe_b64decode(h + "=="))
    h2 = b64(json.dumps({**header, "crit": ["exp"]}).encode())
    signed = f"{h2}.{p}.{b64(KEY.sign(f'{h2}.{p}'.encode()).signature)}"
    assert gate().decide(req(signed)).status == 403


# ── the key set ─────────────────────────────────────────────────────────────


def test_an_unreachable_jwks_fails_closed_with_503():
    def down(uri, timeout):
        raise JwksUnavailable("ECONNREFUSED")

    gt = gate(jwks=None)
    gt.verify.key_set = RemoteJwks("https://api.aifinpay.io/.well-known/jwks.json", fetch=down)
    r = gt.decide(req(token()))
    assert (r.status, r.body["error"], r.headers["Retry-After"]) == (503, "AIFP-503-METER", "30")


def test_a_rotated_key_is_picked_up_after_the_cooldown_and_the_jwks_is_cached():
    fetched = []
    keys = [[jwk(KEY, "k1")], [jwk(KEY, "k1"), jwk(OTHER, "k2")]]

    def fetch(uri, timeout):
        fetched.append(uri)
        return keys[min(len(fetched) - 1, 1)]

    gt = gate(jwks=None)
    gt.verify.key_set = RemoteJwks("https://x/jwks", fetch=fetch, cooldown_s=0)
    assert gt.decide(req(token())).ok
    assert gt.decide(req(token())).ok and len(fetched) == 1, "cached"
    assert gt.decide(req(token(key=OTHER, kid="k2", receipt_id="rcpt_2"))).ok
    assert len(fetched) == 2


# ── routes mode (middleware over a whole app) ───────────────────────────────


def routes_gate():
    return gate(routes=[
        g.Route("/create", "premium", methods={"POST"}),
        g.Route("/api/*"),
        g.Route("/api/search", "complex"),
        g.Route("/api/health", paywall=False),
    ])


def test_unmatched_paths_and_methods_are_not_this_gates_business():
    gt = routes_gate()
    assert gt.decide(req(path="/")) is None
    assert gt.decide(req(path="/create", method="GET")) is None
    assert gt.decide(req(path="/create", method="POST")).status == 402


def test_the_longest_pattern_wins_and_prices_the_call():
    r = routes_gate().decide(req(path="/api/search"))
    assert (r.body["resource"], r.body["tier"], r.body["unit_weight"]) == ("/api/search", "complex", 4)
    r = routes_gate().decide(req(path="/api/other"))
    assert (r.body["resource"], r.body["unit_weight"]) == ("/api/*", 1)


def test_a_wildcard_receipt_is_checked_against_the_real_path():
    gt = routes_gate()
    assert gt.decide(req(token(resource="/api/*"), path="/api/x")).ok
    assert gt.decide(req(token(resource="/api/*", receipt_id="rcpt_2"), path="/elsewhere")) is None


def test_a_free_route_is_served_without_touching_a_batch():
    gt = routes_gate()
    r = gt.decide(req(token(), path="/api/health"))
    assert r.ok and r.aifp["mode"] == "open" and gt.store.get("aifp:used:rcpt_1") is None


def test_routes_are_validated():
    with pytest.raises(ValueError):
        g.Route("/backtest/*/bid")
    with pytest.raises(ValueError):
        g.Route("/x", tier="Premium")


def test_hooks_that_raise_never_turn_into_errors():
    def boom(*_):
        raise RuntimeError("x")

    gt = gate(on_event=boom, allow=boom, should_charge=boom)
    assert gt.decide(req()).status == 402  # a raising should_charge charges
    assert gt.decide(req(token())).ok  # a raising allow is "no opinion"


def test_the_allow_veto_refuses_before_metering():
    gt = gate(allow=lambda ctx: ctx["agent"] != "0xabc")
    r = gt.decide(req(token()))
    assert r.status == 403 and gt.store.get("aifp:used:rcpt_1") is None
