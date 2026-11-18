"""About the page: the shared sanitising vectors, and a 402 that is unchanged unless a site says something."""

import json
import pathlib

import pytest

import aifinpay_gate as g
from test_gate import KEY, jwk, token

VECTORS_DIR = pathlib.Path(__file__).resolve().parents[2] / "conformance" / "vectors"
ABOUT = json.loads((VECTORS_DIR / "about-v1.json").read_text("utf-8"))
GATE = json.loads((VECTORS_DIR / "gate-v1.json").read_text("utf-8"))
MERCHANT = GATE["fixtures"]["merchant_id"]
API = "{{api}}"
AGENT = {"User-Agent": GATE["fixtures"]["user_agents"]["gptbot"]}
FISH = GATE["profiles"]["about-enforce"]["about"]["/paid/a"]
NOW = 1_800_000_000


def dumps(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"))


def golden(name):
    return dumps(GATE["golden"][name])


@pytest.mark.parametrize("v", ABOUT["vectors"], ids=lambda v: v["name"])
def test_about_vectors(v):
    assert dumps(g.page_about(v["value"])) == dumps(v["about"])


def make(about=None, **kw):
    events = []
    gate = g.Gate(MERCHANT, resource="/paid/*", api_base=API, jwks={"keys": [jwk(KEY)]}, now=lambda: NOW,
                  on_event=events.append, **({"about": about} if about is not None else {}), **kw)
    return gate, events


def body402(gate, path="/paid/a", **headers):
    result = gate.decide(g.SimpleRequest(path, {**AGENT, **headers}, "GET"))
    assert result.status == 402
    return dumps(result.body)


def test_build_challenge_without_about_is_byte_for_byte_the_reference_402():
    assert dumps(g.build_challenge(MERCHANT, "/paid/*", "standard", 1, api_base=API)) == golden("challenge.standard")
    assert dumps(g.build_challenge(MERCHANT, "/paid/*", "standard", 1, api_base=API, about=None)) == golden("challenge.standard")


def test_a_gate_without_the_option_sends_the_reference_402():
    assert body402(make()[0]) == golden("challenge.standard")


def test_the_function_adds_about_right_after_resource_as_the_reference_does():
    body = body402(make(lambda r: FISH)[0])
    assert body == golden("challenge.about")
    assert list(json.loads(body))[7:10] == ["resource", "about", "tier"]


def test_the_function_is_handed_the_request():
    seen = []

    def about(r):
        seen.append((r.path, r.header("user-agent")))
        return FISH if r.path == "/paid/a" else None

    gate = make(about)[0]
    assert body402(gate) == golden("challenge.about")
    assert body402(gate, "/paid/b") == golden("challenge.standard")
    assert seen == [("/paid/a", AGENT["User-Agent"]), ("/paid/b", AGENT["User-Agent"])]


def test_markup_and_length_are_cleaned_in_the_402():
    gate = make(lambda r: {"title": "<b>Fish</b> &amp; chips" + "x" * 300, "description": "<p>d</p>"})[0]
    about = json.loads(body402(gate))["about"]
    assert about == {"title": "Fish & chips" + "x" * 188, "description": "d"}


def _raise(_r):
    raise RuntimeError("boom")


@pytest.mark.parametrize("fn", [
    _raise,
    lambda r: "Fish and chips",
    lambda r: [FISH],
    lambda r: {"title": 5},
    lambda r: None,
    lambda r: {"title": " <br> ", "description": ""},
], ids=["raises", "string", "list", "number_title", "none", "empty_text"])
def test_a_function_that_fails_leaves_the_402_as_it_was(fn):
    gate, events = make(fn)
    assert body402(gate) == golden("challenge.standard")
    assert [e["kind"] for e in events] == ["402"]


def test_the_quote_request_in_how_to_pay_never_carries_it():
    body = json.loads(body402(make(lambda r: FISH)[0]))
    assert body.pop("about") == FISH
    assert dumps(body) == golden("challenge.standard")
    assert "Fish" not in " ".join(body["how_to_pay"])


def test_the_402_event_is_the_same_with_and_without_it():
    a, a_events = make(lambda r: FISH)
    b, b_events = make()
    body402(a)
    body402(b)
    assert a_events == b_events


def test_an_exhausted_receipt_402_carries_it_and_the_meter_is_the_one_without_it():
    tok = token(aud=MERCHANT, resource="/paid/*", unit_quota=2, exp=NOW + 3600, iat=NOW)

    def run(about):
        calls = []

        def counted(r):
            calls.append(r.path)
            return about

        gate = make(counted if about else None)[0]
        answers = [gate.decide(g.SimpleRequest("/paid/a", {"AIFP-Receipt": tok}, "GET")) for _ in range(3)]
        return answers, calls

    with_it, calls = run(FISH)
    without, _ = run(None)
    assert [(a.status, a.headers, a.aifp) for a in with_it[:2]] == [(a.status, a.headers, a.aifp) for a in without[:2]]
    assert calls == ["/paid/a"]
    assert with_it[2].status == 402 and with_it[2].body.pop("about") == FISH
    assert with_it[2].body == without[2].body


def test_shadow_does_not_ask():
    calls = []
    gate = make(lambda r: calls.append(r) or FISH, mode="shadow")[0]
    assert gate.decide(g.SimpleRequest("/paid/a", AGENT, "GET")).status == 200
    assert calls == []


def test_a_reader_exempted_by_should_charge_is_not_asked():
    calls = []
    gate = make(lambda r: calls.append(r) or FISH, should_charge=lambda r: False)[0]
    assert gate.decide(g.SimpleRequest("/paid/a", AGENT, "GET")).status == 200
    assert calls == []


def test_a_lone_surrogate_cannot_break_the_utf8_body_the_adapters_send():
    gate = make(lambda r: {"title": "Caf&eacute; x\uD800y"})[0]
    body = gate.decide(g.SimpleRequest("/paid/a", AGENT, "GET")).body
    assert body["about"] == {"title": "Caf&eacute; xy"}
    assert dumps(body).encode("utf-8")
