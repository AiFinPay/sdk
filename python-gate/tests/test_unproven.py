"""Unproven pays: the reader cookie, verified search bots and the predicate built from them."""

import json
import pathlib
import threading

import pytest

import aifinpay_gate as g
from aifinpay_gate import unproven as u
from test_gate import KEY, NOW, gate, token

VECTORS = json.loads((pathlib.Path(__file__).resolve().parents[2] / "conformance" / "vectors" / "reader-proof-v1.json").read_text("utf-8"))

READER_KEY = "reader-key-0123456789abcdef0123456789"
CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"
GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)"
BINGBOT = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)"
GOOGLE_IP = "66.249.66.1"
GOOGLE_NAME = "crawl-66-249-66-1.googlebot.com"


@pytest.mark.parametrize("v", VECTORS["issue"], ids=lambda v: v["name"])
def test_issue_vectors(v):
    assert g.ReaderProof(v["key"], VECTORS["ttl_seconds"]).issue(v["user_agent"], v["now"]) == v["cookie"]


@pytest.mark.parametrize("v", VECTORS["verify"], ids=lambda v: v["name"])
def test_verify_vectors(v):
    assert g.ReaderProof(v["key"]).verify(v["cookie_header"], v["user_agent"], v["now"]) is v["valid"]


def test_cookie_name_and_set_cookie_match_the_spec():
    proof = g.ReaderProof(READER_KEY)
    assert proof.cookie_name == VECTORS["cookie"]
    assert proof.set_cookie("1.x") == VECTORS["set_cookie"].replace("<value>", "1.x")


def test_an_issued_cookie_verifies_for_its_user_agent_until_it_expires():
    proof = g.ReaderProof(READER_KEY)
    value = proof.issue(CHROME, NOW)
    assert proof.verify(f"__aifp_human={value}", CHROME, NOW + 1)
    assert not proof.verify(f"__aifp_human={value}", CHROME, NOW + 2592000)
    assert not proof.verify(f"__aifp_human={value}", GOOGLEBOT, NOW + 1)
    assert not proof.verify(f"__aifp_human={value}", None, NOW + 1)
    assert proof.verify(f"__aifp_human={proof.issue(None, NOW)}", "", NOW + 1)


def test_a_short_key_is_refused():
    with pytest.raises(ValueError):
        g.ReaderProof("short")


class FakeDns:
    def __init__(self, ptr=None, a=None, aaaa=None):
        self.ptr, self.a, self.aaaa, self.calls = ptr or {}, a or {}, aaaa or {}, 0

    def _answer(self, table, key):
        self.calls += 1
        if key not in table:
            raise OSError("not found")
        return table[key]

    def reverse(self, ip):
        return self._answer(self.ptr, ip)

    def resolve4(self, name):
        return self._answer(self.a, name)

    def resolve6(self, name):
        return self._answer(self.aaaa, name)


def google():
    return FakeDns({GOOGLE_IP: [GOOGLE_NAME]}, {GOOGLE_NAME: [GOOGLE_IP]})


def test_a_real_googlebot_is_search():
    assert g.verify_search_bot(GOOGLEBOT, GOOGLE_IP, google()) == "search"


def test_a_ptr_outside_the_operator_domain_is_not():
    dns = FakeDns({"1.2.3.4": ["host.example.com"]}, {"host.example.com": ["1.2.3.4"]})
    assert g.verify_search_bot(GOOGLEBOT, "1.2.3.4", dns) is None


def test_a_ptr_the_forward_lookup_does_not_confirm_is_not():
    dns = FakeDns({"1.2.3.4": [GOOGLE_NAME]}, {GOOGLE_NAME: [GOOGLE_IP]})
    assert g.verify_search_bot(GOOGLEBOT, "1.2.3.4", dns) is None


def test_a_look_alike_suffix_is_not():
    dns = FakeDns({"1.2.3.4": ["crawl.evilgooglebot.com"]}, {"crawl.evilgooglebot.com": ["1.2.3.4"]})
    assert g.verify_search_bot(GOOGLEBOT, "1.2.3.4", dns) is None


def test_a_google_name_for_a_crawler_claiming_bing_is_not():
    assert g.verify_search_bot(BINGBOT, GOOGLE_IP, google()) is None


def test_a_user_agent_naming_no_search_operator_is_not_looked_up():
    dns = google()
    assert g.verify_search_bot(CHROME, GOOGLE_IP, dns) is None
    assert g.verify_search_bot("GPTBot/1.2 Googlebot", GOOGLE_IP, dns) is None
    assert dns.calls == 0


def test_a_resolver_that_raises_is_not_free():
    class Broken(FakeDns):
        def reverse(self, ip):
            raise OSError("SERVFAIL")

    assert g.verify_search_bot(GOOGLEBOT, GOOGLE_IP, Broken({}, {GOOGLE_NAME: [GOOGLE_IP]})) is None

    class BrokenForward(FakeDns):
        def resolve4(self, name):
            raise OSError("SERVFAIL")

    assert g.verify_search_bot(GOOGLEBOT, GOOGLE_IP, BrokenForward({GOOGLE_IP: [GOOGLE_NAME]})) is None


def test_a_resolver_that_hangs_times_out_as_not_free():
    release = threading.Event()

    class Hangs(FakeDns):
        def reverse(self, ip):
            release.wait(5)
            return [GOOGLE_NAME]

    try:
        assert g.verify_search_bot(GOOGLEBOT, GOOGLE_IP, Hangs({}, {GOOGLE_NAME: [GOOGLE_IP]}), timeout=0.05) is None
    finally:
        release.set()


def test_ipv6_is_confirmed_against_aaaa_in_any_spelling():
    ip = "2001:4860:4801:10::1"
    name = "crawl-2001-4860-4801-10--1.googlebot.com"
    dns = FakeDns({ip: [name + "."]}, aaaa={name: ["2001:4860:4801:0010:0000:0000:0000:0001"]})
    assert g.verify_search_bot(GOOGLEBOT, "2001:4860:4801:10:0:0:0:1", dns) == "search"


def test_an_ipv4_mapped_address_is_checked_as_ipv4():
    assert g.verify_search_bot(GOOGLEBOT, f"::ffff:{GOOGLE_IP}", google()) == "search"


def test_a_value_that_is_not_an_address_is_not_looked_up():
    assert g.verify_search_bot(GOOGLEBOT, "crawl.googlebot.com", google()) is None
    assert g.verify_search_bot(GOOGLEBOT, None, google()) is None


def test_the_cache_keeps_24h_verified_and_1h_refused_by_the_injected_clock():
    dns = google()
    assert g.verify_search_bot(GOOGLEBOT, GOOGLE_IP, dns, now=NOW) == "search"
    first = dns.calls
    assert g.verify_search_bot(GOOGLEBOT, GOOGLE_IP, dns, now=NOW + 86399) == "search"
    assert dns.calls == first
    assert g.verify_search_bot(GOOGLEBOT, GOOGLE_IP, dns, now=NOW + 86400) == "search"
    assert dns.calls > first

    neg = FakeDns({"1.2.3.4": ["host.example.com"]})
    assert g.verify_search_bot(GOOGLEBOT, "1.2.3.4", neg, now=NOW) is None
    neg.ptr["1.2.3.4"] = [GOOGLE_NAME]
    neg.a[GOOGLE_NAME] = ["1.2.3.4"]
    assert g.verify_search_bot(GOOGLEBOT, "1.2.3.4", neg, now=NOW + 3599) is None
    assert neg.calls == 1
    assert g.verify_search_bot(GOOGLEBOT, "1.2.3.4", neg, now=NOW + 3600) == "search"


def test_the_cache_is_bounded(monkeypatch):
    monkeypatch.setattr(u, "SEARCH_BOT_CACHE_MAX", 50)
    dns = FakeDns()
    ip = lambda i: f"10.0.{i >> 8}.{i & 255}"  # noqa: E731
    for i in range(51):
        g.verify_search_bot(GOOGLEBOT, ip(i), dns, now=1)
    before = dns.calls
    g.verify_search_bot(GOOGLEBOT, ip(50), dns, now=1)
    assert dns.calls == before
    g.verify_search_bot(GOOGLEBOT, ip(0), dns, now=1)
    assert dns.calls == before + 1


PROOF = g.ReaderProof(READER_KEY)


def r(ip=None, **headers):
    return g.SimpleRequest("/paid", {k.replace("_", "-"): v for k, v in headers.items()}, ip=ip)


def cookie():
    return f"__aifp_human={PROOF.issue(CHROME)}"


def bot(ua, ip):
    return g.verify_search_bot(ua, ip, BOT_DNS)


BOT_DNS = google()
CHARGE = g.unproven_pays(PROOF, verify_search_bot=bot)

TABLE = [
    ("reader with a valid cookie", lambda: r(User_Agent=CHROME, Cookie=cookie()), False),
    ("browser without a cookie", lambda: r(User_Agent=CHROME), True),
    ("reader cookie under another User-Agent", lambda: r(User_Agent=GOOGLEBOT, Cookie=cookie()), True),
    ("verified Googlebot", lambda: r(GOOGLE_IP, User_Agent=GOOGLEBOT), False),
    ("Googlebot User-Agent from another address", lambda: r("1.2.3.4", User_Agent=GOOGLEBOT), True),
    ("Googlebot without a client address", lambda: r(User_Agent=GOOGLEBOT), True),
    ("reader cookie with an AIFP-Agent-Id", lambda: r(User_Agent=CHROME, Cookie=cookie(), **{"AIFP-Agent-Id": "0x" + "0" * 40}), True),
    ("verified Googlebot with an AIFP-Receipt", lambda: r(GOOGLE_IP, User_Agent=GOOGLEBOT, **{"AIFP-Receipt": "x.y.z"}), True),
    ("AI crawler", lambda: r(GOOGLE_IP, User_Agent="GPTBot/1.2"), True),
    ("no User-Agent", lambda: r(), True),
]


@pytest.mark.parametrize("name,build,expected", TABLE, ids=[t[0] for t in TABLE])
def test_predicate_table(name, build, expected):
    assert CHARGE(build()) is expected


def test_a_verified_bot_outside_free_bots_pays():
    assert g.unproven_pays(PROOF, verify_search_bot=bot, free_bots=["preview"])(r(GOOGLE_IP, User_Agent=GOOGLEBOT)) is True


def test_a_bot_verifier_that_raises_charges():
    def broken(ua, ip):
        raise RuntimeError("down")

    assert g.unproven_pays(PROOF, verify_search_bot=broken)(r(GOOGLE_IP, User_Agent=GOOGLEBOT)) is True


def test_a_reader_proof_is_required():
    with pytest.raises(TypeError):
        g.unproven_pays(None)


def test_in_a_gate_a_reader_is_exempt_a_stranger_gets_402_a_receipt_is_metered():
    gt = gate(should_charge=g.unproven_pays(PROOF, verify_search_bot=bot))
    reader = gt.decide(r(User_Agent=CHROME, Cookie=f"__aifp_human={PROOF.issue(CHROME, NOW)}"))
    assert reader.ok and reader.headers.get("AIFP-Paywall") == "exempt"
    assert gt.decide(r(User_Agent=CHROME)).status == 402
    paid = gt.decide(r(User_Agent=CHROME, **{"AIFP-Receipt": token(KEY)}))
    assert paid.ok and paid.status == 200 and paid.headers.get("AIFP-Paywall") != "exempt"


def test_the_adapters_carry_the_client_address():
    from aifinpay_gate.asgi import _AsgiRequest
    from aifinpay_gate.wsgi import _WsgiRequest

    assert _WsgiRequest({"PATH_INFO": "/", "REMOTE_ADDR": GOOGLE_IP}).ip == GOOGLE_IP
    assert _AsgiRequest({"path": "/", "client": (GOOGLE_IP, 4242), "headers": []}).ip == GOOGLE_IP
    assert _AsgiRequest({"path": "/", "headers": []}).ip is None
