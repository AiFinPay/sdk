"""Gate identity on every merchant-secret request and the traffic summary sender, against the shared vectors."""
import json
import pathlib
import re
import tomllib
from urllib.error import HTTPError

import pytest
from aifinpay_gate import (AifpGateMiddleware, AifpGateWSGI, Gate, GateReporter, GateReporterV2, MemoryStore,
                           ReaderProof, Route, SimpleRequest, known_ai_agent, unproven_pays)
from aifinpay_gate.identity import VERSION, charge_of, gate_headers
from aifinpay_gate.reporter import _utc_now
from aifinpay_gate.asgi import _AsgiRequest
from aifinpay_gate.traffic import (ABSENT, TrafficSender, TrafficTally, _utc, counted, country_of, edge_counted,
                                   network_of, section_of)

from test_gate import KEY, NOW, jwk, token

ROOT = pathlib.Path(__file__).resolve().parents[2]
IDENTITY = json.loads((ROOT / "conformance" / "vectors" / "gate-identity-v1.json").read_text("utf-8"))
TRAFFIC = json.loads((ROOT / "conformance" / "vectors" / "gate-traffic-v1.json").read_text("utf-8"))
MERCHANT = "mrch_0123456789abcdef"
API = f"https://api.aifinpay.io/v1/merchants/{MERCHANT}"
GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)"
BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36"


def parse(header):
    return dict(part.split("=") for part in header.split("; "))


class Response:
    def __init__(self, status=200, body=b""):
        self.status, self.body = status, body

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self, size):
        return self.body[:size]


class Opener:
    """Answers each route as the API would; `status` maps a route suffix to a refusal."""

    def __init__(self, status=None):
        self.status = status or {}
        self.calls = []

    def open(self, request, timeout):
        self.calls.append(request)
        url = request.full_url
        for suffix, code in self.status.items():
            if url.endswith(suffix):
                raise HTTPError(url, code, "refused", {}, None)
        data = json.loads(request.data)
        if url.endswith("/receipt-use"):
            return Response(body=json.dumps({"applied": len(data["uses"]), "ignored": 0}).encode())
        if "/v2/" in url:
            return Response(body=json.dumps({"version": 2, "accepted": len(data["events"]), "duplicates": 0,
                                             "received_at": "2026-11-25T10:00:00.000Z"}).encode())
        if url.endswith("/gate-events"):
            return Response(body=json.dumps({"accepted": len(data["events"]), "duplicates": 0}).encode())
        return Response(body=b'{"accepted":true,"duplicate":false,"rows":1,"skipped":0}')

    def to(self, suffix):
        return [r for r in self.calls if r.full_url.endswith(suffix)]

    def windows(self):
        return [json.loads(r.data) for r in self.to("/gate-traffic")]


reporters = []


def new_reporter(opener=None, cls=GateReporter, **kw):
    r = cls(merchant_id=MERCHANT, merchant_secret="test-secret", **kw)
    r._opener = opener or Opener()
    reporters.append(r)
    return r


@pytest.fixture(autouse=True)
def _close_reporters():
    yield
    for r in reporters:
        r.close(timeout=2)
    reporters.clear()


def get(path="/blog/a", ua=None, **headers):
    if ua:
        headers["User-Agent"] = ua
    return SimpleRequest(path, headers)


# ── identity ────────────────────────────────────────────────────────────────

def test_the_version_is_the_manifest_s():
    manifest = tomllib.loads((ROOT / "python-gate" / "pyproject.toml").read_text("utf-8"))
    assert VERSION == manifest["project"]["version"]


@pytest.mark.parametrize("vector", IDENTITY["format"], ids=[v["name"] for v in IDENTITY["format"]])
def test_formats_every_vector_exactly(vector):
    assert gate_headers(vector["input"]) == {"User-Agent": vector["user_agent"], "AIFP-Gate": vector["header"]}


def test_names_the_charge_rule():
    proof = ReaderProof("k" * 32)
    assert charge_of(known_ai_agent) == "agents"
    assert charge_of(unproven_pays(proof)) == "unproven"
    assert charge_of(None) == "everyone"
    assert charge_of(lambda req: known_ai_agent(req)) == "custom"


@pytest.mark.parametrize("rule,charge", [(known_ai_agent, "agents"), (unproven_pays(ReaderProof("k" * 32)), "unproven"),
                                         (None, "everyone"), (lambda req: True, "custom")])
def test_the_gate_sends_its_own_mode_charge_and_platform(rule, charge):
    reporter = new_reporter()
    gate = Gate(MERCHANT, resource="/api", mode="shadow", should_charge=rule, on_event=reporter.on_event)
    gate.decide(get("/api", GPTBOT))
    reporter.flush(timeout=2)
    [sent] = reporter._opener.to("/gate-events")
    assert parse(sent.get_header("Aifp-gate")) == {"pkg": "py", "ver": VERSION, "platform": "python",
                                                    "mode": "shadow", "charge": charge}
    assert sent.get_header("User-agent") == f"aifinpay-gate-py/{VERSION}"


@pytest.mark.parametrize("adapter,word", [(AifpGateMiddleware, "asgi"), (AifpGateWSGI, "wsgi")])
def test_an_adapter_names_its_platform(adapter, word):
    reporter = new_reporter()
    gate = Gate(MERCHANT, resource="/api", on_event=reporter.on_event)
    adapter(lambda *a: None, gate)
    gate.decide(get("/api", GPTBOT))
    reporter.flush(timeout=2)
    assert parse(reporter._opener.to("/gate-events")[0].get_header("Aifp-gate"))["platform"] == word


def test_identity_rides_events_receipt_use_traffic_and_reporting_v2():
    reporter = new_reporter()
    gate = Gate(MERCHANT, resource="/paid", store=MemoryStore(), jwks={"keys": [jwk(KEY)]}, now=lambda: NOW,
                on_event=reporter.on_event)
    receipt = token(aud=MERCHANT, unit_quota=5, receipt_id="rcpt_00000000000000c4")
    assert gate.decide(get("/paid", GPTBOT)).status == 402
    assert gate.decide(SimpleRequest("/paid", {"AIFP-Receipt": receipt})).status == 200
    reporter.flush(timeout=2)
    reporter.flush_traffic()
    v2 = new_reporter(cls=GateReporterV2, supported=["access_challenged"])
    Gate(MERCHANT, resource="/v2", reporting=v2)
    assert v2.on_event({"id": "10000000-0000-4000-8000-000000000001", "name": "access_challenged", "resource": "/v2",
                        "at": _utc_now(), "channel": "api",
                        "consent": "denied", "reason": "receipt_missing"})
    v2.flush(timeout=2)
    calls = reporter._opener.calls + v2._opener.calls
    for kind in ("/gate-events", "/receipt-use", "/gate-traffic", "/v2/merchants"):
        hits = [r for r in calls if kind in r.full_url]
        assert hits, kind
        for hit in hits:
            assert re.fullmatch(r"pkg=py; ver=[0-9.]+; platform=python; mode=enforce; charge=everyone",
                                hit.get_header("Aifp-gate")), kind
            assert hit.get_header("User-agent") == f"aifinpay-gate-py/{VERSION}", kind


# ── traffic rules ───────────────────────────────────────────────────────────

def test_sections_counted_countries_and_networks_as_the_vectors_say():
    for v in TRAFFIC["sections"]:
        assert section_of(v["target"]) == v["section"], v["target"]
    for v in TRAFFIC["counted"]:
        assert counted(v["target"], v["outcome"]) is v["counted"], v["target"]
    for v in TRAFFIC["countries"]:
        assert country_of(v["value"]) == v["country"], v["value"]
    for v in TRAFFIC["networks"]:
        assert network_of(v["value"]) == v["network"], v["value"]


@pytest.mark.parametrize("vector", TRAFFIC["build"], ids=[v["name"] for v in TRAFFIC["build"]])
def test_builds_every_vector_body_byte_for_byte(vector):
    tally = TrafficTally()
    for r in vector["requests"]:
        tally.add(r["target"], r["ua_class"], r["operator"], r["outcome"],
                  r["country"] if vector["platform"]["country"] else ABSENT,
                  r["network"] if vector["platform"]["network"] else ABSENT, r.get("n", 1))
    assert tally.body(vector["window"]) == vector["body"]


def _joined(lines):
    """Field lines as one value, the way WSGI servers and the ASGI adapter join them."""
    return ", ".join(lines) if lines else None


def test_an_edge_counted_request_as_the_vectors_say():
    for v in TRAFFIC["edge_counted"]["values"]:
        assert edge_counted(_joined(v["lines"])) is v["edge_counted"], v["name"]


@pytest.mark.parametrize("vector", TRAFFIC["edge_counted"]["build"], ids=[v["name"] for v in TRAFFIC["edge_counted"]["build"]])
def test_builds_every_edge_counted_body_byte_for_byte(vector):
    tally = TrafficTally()
    for r in vector["requests"]:
        if not edge_counted(_joined(r.get("edge_counted"))):
            tally.add(r["target"], r["ua_class"], r["operator"], r["outcome"], r["country"], r["network"], r.get("n", 1))
    assert tally.body(vector["window"]) == vector["body"]


# ── traffic from the gate ───────────────────────────────────────────────────

def content_gate(reporter, **kw):
    return Gate(MERCHANT, routes=[Route("/blog/*")], should_charge=known_ai_agent, on_event=reporter.on_event, **kw)


def test_a_reader_is_counted_and_never_forwarded_as_an_event():
    reporter = new_reporter()
    gate = content_gate(reporter)
    assert gate.decide(get("/blog/a-title", BROWSER)).status == 200
    assert gate.decide(get("/blog/a-title", GPTBOT)).status == 402
    reporter.flush(timeout=2)
    events = [e for r in reporter._opener.to("/gate-events") for e in json.loads(r.data)["events"]]
    assert [(e["kind"], e["ua_class"]) for e in events] == [("402", "ai_crawler")]
    reporter.flush_traffic()
    [w] = reporter._opener.windows()
    assert w["classes"] == [["ai_crawler", "challenged", 1], ["human", "served", 1]]
    assert w["operators"] == [["openai", "ai_crawler", "challenged", 1]]
    assert w["sections"] == [["/blog", "ai_crawler", 1]]
    assert w["countries"] == [["ZZ", "ai_crawler", 1], ["ZZ", "human", 1]]
    assert "networks" not in w
    assert "a-title" not in json.dumps(w)
    assert list(w) == ["v", "id", "from", "to", "mode", "charge", "sample", "classes", "operators", "sections",
                       "countries"]
    assert (w["mode"], w["charge"]) == ("enforce", "agents")


def test_a_path_outside_every_route_is_counted_as_served():
    reporter = new_reporter()
    gate = content_gate(reporter)
    assert gate.decide(get("/about", GPTBOT)) is None
    reporter.flush_traffic()
    assert reporter._opener.windows()[0]["classes"] == [["ai_crawler", "served", 1]]


def test_an_asset_served_free_is_not_counted():
    reporter = new_reporter()
    gate = content_gate(reporter)
    gate.decide(get("/blog/app.js", BROWSER))
    gate.decide(get("/static/logo.PNG", GPTBOT))
    reporter.flush_traffic()
    assert reporter._opener.windows() == []
    gate.decide(get("/blog/app.js", GPTBOT))
    reporter.flush_traffic()
    assert reporter._opener.windows()[0]["classes"] == [["ai_crawler", "challenged", 1]]


def test_country_and_network_only_from_named_headers_never_a_network_for_a_reader():
    reporter = new_reporter()
    gate = content_gate(reporter, country_header="x-country", network_header="x-asn")
    gate.decide(get("/blog/a", BROWSER, **{"x-country": "de", "x-asn": "3320", "cf-ipcountry": "US"}))
    gate.decide(get("/blog/a", GPTBOT, **{"x-country": "US", "x-asn": "AS8075"}))
    reporter.flush_traffic()
    [w] = reporter._opener.windows()
    assert w["countries"] == [["DE", "human", 1], ["US", "ai_crawler", 1]]
    assert w["networks"] == [["AS8075", "ai_crawler", 1]]


def test_country_header_none_sends_no_countries():
    reporter = new_reporter()
    gate = content_gate(reporter, country_header=None)
    gate.decide(get("/blog/a", BROWSER, **{"cf-ipcountry": "US"}))
    reporter.flush_traffic()
    assert "countries" not in reporter._opener.windows()[0]


def test_shadow_reports_the_decision_and_a_paid_admission_is_paid():
    reporter = new_reporter()
    gate = Gate(MERCHANT, resource="/paid", mode="shadow", jwks={"keys": [jwk(KEY)]}, now=lambda: NOW,
                on_event=reporter.on_event)
    receipt = token(aud=MERCHANT, unit_quota=5, receipt_id="rcpt_00000000000000c5")
    assert gate.decide(get("/paid", GPTBOT)).status == 200
    assert gate.decide(SimpleRequest("/paid", {"AIFP-Receipt": receipt})).status == 200
    reporter.flush_traffic()
    [w] = reporter._opener.windows()
    assert w["classes"] == [["ai_crawler", "challenged", 1], ["aifp_agent", "paid", 1]]
    assert w["mode"] == "shadow"


def test_an_edge_counted_request_is_answered_and_reported_the_same_and_left_out_of_the_summary():
    receipt = token(aud=MERCHANT, unit_quota=5, receipt_id="rcpt_00000000000000c7")

    def run(extra):
        reporter = new_reporter()
        gate = Gate(MERCHANT, resource="/paid", store=MemoryStore(), jwks={"keys": [jwk(KEY)]}, now=lambda: NOW,
                    should_charge=known_ai_agent, on_event=reporter.on_event)
        answers = [json.dumps(gate.decide(SimpleRequest("/paid", {**h, **extra})).as_dict(), sort_keys=True)
                   for h in ({"User-Agent": BROWSER}, {"User-Agent": GPTBOT}, {"AIFP-Receipt": receipt},
                             {"AIFP-Receipt": receipt})]
        reporter.flush(timeout=2)
        reporter.flush_traffic()
        events = [{k: v for k, v in e.items() if k not in ("id", "at")}
                  for r in reporter._opener.to("/gate-events") for e in json.loads(r.data)["events"]]
        return answers, events, reporter._opener.windows()

    marked, plain = run({"AIFP-Edge-Counted": "1"}), run({})
    assert marked[0] == plain[0]
    assert json.loads(marked[0][1])["status"] == 402
    assert marked[1] == plain[1]
    assert [e["kind"] for e in marked[1]] == ["402", "serve", "serve"]
    assert marked[2] == []
    assert plain[2][0]["classes"] == [["ai_crawler", "challenged", 1], ["aifp_agent", "paid", 2], ["human", "served", 1]]


def test_only_one_value_of_exactly_1_leaves_a_request_out_of_the_summary():
    reporter = new_reporter()
    gate = content_gate(reporter)
    left, kept = ["1", " 1 ", "\t1"], ["0", "true", "", "1, 1", "1,", "01", "yes"]
    for value in left + kept:
        assert gate.decide(get("/blog/a", GPTBOT, **{"aifp-edge-counted": value})).status == 402
    gate.decide(get("/blog/a", GPTBOT))
    reporter.flush_traffic()
    assert reporter._opener.windows()[0]["classes"] == [["ai_crawler", "challenged", len(kept) + 1]]


def test_the_asgi_adapter_reads_a_repeated_edge_counted_field_as_repeated():
    def scope(*values):
        return {"type": "http", "path": "/blog/a", "headers": [(b"user-agent", GPTBOT.encode())] + [
            (b"aifp-edge-counted", v.encode()) for v in values]}
    assert _AsgiRequest(scope("1")).header("AIFP-Edge-Counted") == "1"
    assert _AsgiRequest(scope("1", "1")).header("AIFP-Edge-Counted") == "1, 1"
    reporter = new_reporter()
    gate = content_gate(reporter)
    gate.decide(_AsgiRequest(scope("1")))
    gate.decide(_AsgiRequest(scope("1", "1")))
    reporter.flush_traffic()
    assert reporter._opener.windows()[0]["classes"] == [["ai_crawler", "challenged", 1]]


def test_traffic_false_sends_nothing():
    reporter = new_reporter()
    gate = content_gate(reporter, traffic=False)
    gate.decide(get("/blog/a", GPTBOT))
    reporter.flush_traffic()
    reporter.close(timeout=2)
    assert reporter._opener.windows() == []
    assert len(reporter._opener.to("/gate-events")) == 1


def test_a_404_on_traffic_leaves_events_receipt_use_and_serving_untouched():
    reporter = new_reporter(Opener({"/gate-traffic": 404}))
    gate = Gate(MERCHANT, resource="/paid", store=MemoryStore(), jwks={"keys": [jwk(KEY)]}, now=lambda: NOW,
                should_charge=known_ai_agent, on_event=reporter.on_event)
    receipt = token(aud=MERCHANT, unit_quota=5, receipt_id="rcpt_00000000000000c6")
    gate.decide(get("/paid", GPTBOT))
    reporter.flush_traffic()
    assert reporter.stats["traffic"]["paused_until"] is not None
    assert gate.decide(get("/paid", GPTBOT)).status == 402
    assert gate.decide(get("/paid", BROWSER)).status == 200
    assert gate.decide(SimpleRequest("/paid", {"AIFP-Receipt": receipt})).status == 200
    reporter.flush(timeout=2)
    reporter.flush_traffic()
    stats = reporter.stats
    assert stats["stopped"] is False and stats["delivered"] == 3 and stats["uses"]["delivered"] == 1
    assert len(reporter._opener.to("/gate-traffic")) == 1
    # And the other way round: a stopped event reporter leaves traffic sending.
    other = new_reporter(Opener({"/gate-events": 401}))
    gate2 = content_gate(other)
    gate2.decide(get("/blog/a", GPTBOT))
    other.flush(timeout=2)
    assert other.stats["stopped"] is True
    gate2.decide(get("/blog/a", GPTBOT))
    other.flush_traffic()
    assert other._opener.windows()[0]["classes"] == [["ai_crawler", "challenged", 2]]


# ── the sender, on an injected clock ────────────────────────────────────────

class Clock:
    def __init__(self, at=0.0):
        self.at = at

    def __call__(self):
        return self.at


def sender_with(answers, at=0.0):
    clock = Clock(at)
    bodies = []

    def post(body):
        bodies.append(body)
        return answers.pop(0) if answers else "none"
    return TrafficSender("x", "s", dict, now=clock, post=post, thread=False), clock, bodies


def hit(sender, target="/blog/a"):
    sender.record(target, "ai_crawler", "openai", "challenged", "enforce", "agents")


@pytest.mark.parametrize("scenario", TRAFFIC["sender"]["scenarios"], ids=[s["name"] for s in TRAFFIC["sender"]["scenarios"]])
def test_follows_every_sender_scenario(scenario):
    answers = []
    sender, clock, bodies = sender_with(answers)
    by_from = {}
    for i, step in enumerate(scenario["steps"]):
        if step.get("closed") is not None:
            clock.at = step["at"] - 1
            hit(sender)
            by_from[_utc(step["at"] - 1)] = step["closed"]
        clock.at = step["at"]
        answers[:] = list(step.get("answers", []))
        before = len(bodies)
        sender.flush()
        sent = [by_from.get(json.loads(b)["from"]) for b in bodies[before:]]
        want = scenario["expect"][i]
        assert sent == want["sent"], (scenario["name"], i)
        assert sender.stats["held"] == len(want["held"]), (scenario["name"], i)
        assert sender.stats["paused_until"] == want["paused_until"], (scenario["name"], i)


def test_a_window_closes_300_s_after_its_first_request():
    answers = [200]
    sender, clock, bodies = sender_with(answers, 1_795_600_800)
    hit(sender)
    clock.at += 299
    hit(sender)
    assert bodies == []
    clock.at += 1
    hit(sender)
    sender.flush()
    first = json.loads(bodies[0])
    assert (first["from"], first["to"]) == ("2026-11-25T10:00:00Z", "2026-11-25T10:05:00Z")
    assert first["classes"] == [["ai_crawler", "challenged", 2]]


def test_resends_with_the_same_bytes_and_never_merges_two_windows():
    answers = [503]
    sender, clock, bodies = sender_with(answers)
    hit(sender)
    clock.at = 10
    sender.flush()
    clock.at = 20
    hit(sender, "/docs/x")
    clock.at = 30
    answers[:] = [200, 200]
    sender.flush()
    assert len(bodies) == 3 and bodies[1] == bodies[0]
    assert json.loads(bodies[2])["id"] != json.loads(bodies[0])["id"]
    assert json.loads(bodies[2])["sections"] == [["/docs", "ai_crawler", 1]]
    assert sender.stats["held"] == 0 and sender.stats["sent"] == 2


def test_holds_at_most_three_windows_and_drops_one_an_hour_old():
    answers = []
    sender, clock, _bodies = sender_with(answers)
    for i in range(1, 6):
        clock.at = i * 400 - 1
        hit(sender)
        clock.at = i * 400
        answers[:] = [503]
        sender.flush()
    assert sender.stats["held"] == 3
    clock.at = 5 * 400 + 3601
    sender.flush()
    assert sender.stats["held"] == 0


def test_a_400_pauses_a_day_and_a_429_keeps_the_window():
    answers = [429]
    sender, clock, bodies = sender_with(answers)
    hit(sender)
    clock.at = 5
    sender.flush()
    assert (sender.stats["held"], sender.stats["paused_until"]) == (1, None)
    answers[:] = [400]
    clock.at = 6
    sender.flush()
    assert (sender.stats["held"], sender.stats["paused_until"]) == (0, 6 + 86400)
    hit(sender)
    clock.at = 7
    sender.flush()
    assert len(bodies) == 2


def test_record_never_touches_the_network():
    calls = []
    sender = TrafficSender("x", "s", dict, now=Clock(), post=lambda body: calls.append(body) or 200, thread=False)
    for _ in range(1000):
        hit(sender)
    assert calls == []
