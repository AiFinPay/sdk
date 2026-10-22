"""Who asked — operator, ua_class, verified on every gate event, as in Node.

A User-Agent is a claim: a scanner sending "ChatGPT-User" must never become a
verified OpenAI agent. Only a receipt this gate verified makes an event
verified, and the raw User-Agent never leaves the request. The table itself is
held equal to Node's by tests/test_parity.py.
"""
import json
import time
from unittest.mock import Mock

import pytest

import aifinpay_gate as g
from aifinpay_gate import GateReporter
from test_gate import OTHER, gate, req, token

CHATGPT_USER_UA = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot"
BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/126.0 Safari/537.36"
MERCHANT = "mrch_0123456789abcdef"
LEGACY = {"id", "kind", "resource", "at"}
IDENTITY = {"operator", "ua_class", "verified"}


def recording(**kw):
    events = []
    return gate(on_event=events.append, **kw), events


def test_every_row_uses_the_closed_enums_and_classifies_to_itself():
    assert g.AI_AGENT_UA_MARKERS == tuple(row[0] for row in g.AI_AGENT_UA_TABLE)
    for marker, operator, ua_class in g.AI_AGENT_UA_TABLE:
        assert operator in g.GATE_OPERATORS and ua_class in g.UA_CLASSES
        ua = f"Mozilla/5.0 (compatible; {marker.upper()}/1.0)"
        assert g.classify_agent(g.SimpleRequest("/", {"User-Agent": ua})) == {
            "operator": operator, "ua_class": ua_class, "verified": False}


@pytest.mark.parametrize("headers,expected", [
    ({"User-Agent": CHATGPT_USER_UA}, ("openai", "ai_agent_browser")),
    ({"User-Agent": "Mozilla/5.0 (compatible; Claude-SearchBot/1.0)"}, ("anthropic", "ai_crawler")),
    ({"User-Agent": "CCBot/2.0 (https://commoncrawl.org/faq/)"}, ("commoncrawl", "ai_crawler")),
    ({"User-Agent": BROWSER_UA}, ("unknown", "human")),
    ({}, ("unknown", "unknown")),
    ({"User-Agent": CHATGPT_USER_UA, "AIFP-Agent-Id": "agt_1"}, ("aifinpay", "aifp_agent")),
])
def test_classify_agent(headers, expected):
    who = g.classify_agent(g.SimpleRequest("/", headers))
    assert (who["operator"], who["ua_class"], who["verified"]) == (*expected, False)
    assert g.known_ai_agent(g.SimpleRequest("/", headers)) is (who["ua_class"] != "human")


@pytest.mark.parametrize("should_charge", [None, g.known_ai_agent])
def test_spoofed_chatgpt_user_without_receipt_is_not_verified(should_charge):
    gt, events = recording(should_charge=should_charge)
    assert gt.decide(req(**{"User-Agent": CHATGPT_USER_UA})).status == 402
    assert [(e["kind"], e["operator"], e["ua_class"], e["verified"]) for e in events] == [
        ("402", "openai", "ai_agent_browser", False)]


def test_a_receipt_signed_by_someone_else_is_not_verified():
    gt, events = recording()
    assert gt.decide(req(token(key=OTHER), **{"User-Agent": CHATGPT_USER_UA})).status == 403
    assert events[0]["verified"] is False and events[0]["ua_class"] == "aifp_agent"


def test_a_valid_receipt_is_verified_whatever_the_user_agent_says():
    gt, events = recording()
    tok = token(unit_quota=2)
    for _ in range(3):
        gt.decide(req(tok, **{"User-Agent": CHATGPT_USER_UA}))
    assert [(e["kind"], e["operator"], e["ua_class"], e["verified"]) for e in events] == [
        ("serve", "aifinpay", "aifp_agent", True),
        ("serve", "aifinpay", "aifp_agent", True),
        ("402", "aifinpay", "aifp_agent", True),
    ]


def test_every_event_kind_carries_all_three():
    seen = {}

    class Down:
        def incr_by(self, *_a):
            raise RuntimeError("store down")

    def hit(gt_kwargs, *args, **headers):
        gate(on_event=lambda e: seen.__setitem__(e["kind"], e), **gt_kwargs).decide(req(*args, **headers))

    hit({})                                       # 402
    hit({}, token())                              # serve
    hit({}, token(resource="/other"))             # 403
    hit({"store": Down()}, token())               # meter_error
    assert sorted(seen) == ["402", "403", "meter_error", "serve"]
    for kind, e in seen.items():
        assert IDENTITY <= set(e), kind
        assert e["operator"] in g.GATE_OPERATORS and e["ua_class"] in g.UA_CLASSES and type(e["verified"]) is bool
    assert seen["serve"]["verified"] is True and seen["402"]["verified"] is False


def test_never_copies_user_agent_ip_or_headers():
    gt, events = recording()
    headers = {"User-Agent": "Mozilla/5.0 (compatible; GPTBot/1.2; tracking-token-123)",
               "X-Forwarded-For": "203.0.113.7", "Cookie": "session=abc"}
    gt.decide(req(**headers))
    gt.decide(req(token(), **headers))
    text = json.dumps(events)
    assert len(events) == 2
    for leaked in ("GPTBot", "tracking-token", "203.0.113.7", "session=abc", "Mozilla"):
        assert leaked not in text


# ── reporter ────────────────────────────────────────────────────────────────


class Response:
    def __init__(self, count=1, status=200):
        self.status = status
        self.raw = json.dumps({"accepted": count, "duplicates": 0}).encode()

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False

    def read(self, size):
        return self.raw[:size]


def echo(request, timeout):
    return Response(len(json.loads(request.data)["events"]))


@pytest.fixture
def reporter():
    instance = GateReporter(merchant_id=MERCHANT, merchant_secret="test-secret")
    instance._opener = Mock()
    instance._opener.open.side_effect = echo
    yield instance
    instance.close()


def sent(reporter, n):
    return json.loads(reporter._opener.open.call_args_list[n].args[0].data)["events"]


def ev(kind="402", **extra):
    return {"kind": kind, "resource": "/api/*", "weight": 1, **extra}


CRAWLER = {"operator": "openai", "ua_class": "ai_crawler", "verified": False}


def test_reporter_sends_identity_and_exempt_only_for_agents(reporter):
    reporter.on_event(ev(**CRAWLER))
    reporter.on_event(ev("serve", exempt=True, operator="anthropic", ua_class="ai_agent_browser", verified=False))
    reporter.on_event(ev("serve", exempt=True, operator="unknown", ua_class="human", verified=False))
    reporter.on_event(ev("serve", exempt=True, operator="unknown", ua_class="unknown", verified=False))
    reporter.on_event(ev("serve", exempt=True))
    reporter.on_event(ev("serve", agent="agt_private", receipt_id="rcpt_private",
                         operator="aifinpay", ua_class="aifp_agent", verified=True))
    assert reporter.flush()["delivered"] == 3
    wire = sent(reporter, 0)
    assert [set(e) for e in wire] == [LEGACY | IDENTITY, LEGACY | IDENTITY | {"exempt"}, LEGACY | IDENTITY]
    assert wire[1]["exempt"] is True and wire[2]["verified"] is True
    assert "private" not in json.dumps(wire)


def test_reporter_drops_an_identity_outside_the_enums(reporter):
    reporter.on_event(ev(operator="Mozilla/5.0", ua_class="ai_crawler", verified=False))
    reporter.on_event(ev(operator="openai", ua_class="ai_crawler", verified="yes"))
    reporter.on_event(ev("serve", exempt=True, operator="openai", ua_class="bot", verified=False))
    reporter.flush()
    assert [set(e) for e in sent(reporter, 0)] == [LEGACY, LEGACY]


def test_reporter_falls_back_to_the_legacy_shape_for_an_old_backend(reporter):
    calls = iter([Response(status=400)])
    reporter._opener.open.side_effect = lambda request, timeout: next(calls, None) or echo(request, timeout)
    reporter.on_event(ev(**CRAWLER))
    reporter.on_event(ev("serve", exempt=True, **CRAWLER))
    first = reporter.flush()
    # The exempt serve is dropped: an old backend would count it as a paid serve.
    assert first["stopped"] is False and first["dropped"] == 1 and first["last_error"] == "rejected"
    reporter.on_event(ev(**CRAWLER))
    reporter.on_event(ev("serve", exempt=True, **CRAWLER))
    assert reporter.flush()["delivered"] == 2
    assert reporter.stats["queued"] == 0
    later = [e for n in range(1, reporter._opener.open.call_count) for e in sent(reporter, n)]
    assert [set(e) for e in later] == [LEGACY, LEGACY]
    assert sent(reporter, 0)[0]["id"] in {e["id"] for e in later}


def test_reporter_still_stops_on_a_400_for_the_legacy_shape(reporter):
    reporter._opener.open.side_effect = lambda *_a, **_k: Response(status=400)
    reporter.on_event(ev(**CRAWLER))
    reporter.flush()
    for _ in range(200):
        if reporter.stats["stopped"]:
            break
        time.sleep(0.02)
    assert reporter.stats["stopped"] is True
    assert set(sent(reporter, reporter._opener.open.call_count - 1)[0]) == LEGACY
