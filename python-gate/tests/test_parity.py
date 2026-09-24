"""The Python gate answers exactly what @aifinpay/gate answers.

tests/fixtures/parity.json is recorded from the Node package by
scripts/gen-parity-fixtures.mjs (CI re-runs it with --check). Every scenario
there is replayed here against a fresh Python gate, and the status, headers
and body — or the metering context — must be identical.
"""

import json
import pathlib

import pytest

import aifinpay_gate as g

FIXTURE = json.loads((pathlib.Path(__file__).parent / "fixtures" / "parity.json").read_text())
C = FIXTURE["constants"]


def test_constants_match_the_node_package():
    assert g.DETAIL_QUOTA_EXHAUSTED == C["DETAIL_QUOTA_EXHAUSTED"]
    assert g.DETAIL_RECEIPT_EXPIRED == C["DETAIL_RECEIPT_EXPIRED"]
    assert g.DETAIL_VERIFY_FAILED == C["DETAIL_VERIFY_FAILED"]
    assert g.HEADER_QUOTA_REMAINING == C["HEADER_QUOTA_REMAINING"]
    assert list(g.AI_AGENT_UA_MARKERS) == C["AI_AGENT_UA_MARKERS"]
    assert g.TIER_WEIGHTS == C["TIER_WEIGHTS"]
    assert g.UNIT_PRICE_USD == C["UNIT_PRICE_USD"]
    assert {t: g.min_requests_for_tier(t) for t in C["min_requests"]} == C["min_requests"]
    assert g.REDIS_INCRBY_SCRIPT == C["REDIS_INCRBY_SCRIPT"]


@pytest.mark.parametrize("case", FIXTURE["challenges"], ids=lambda c: f"{c['args']['tier']}-{c['args']['resource']}")
def test_the_402_body_is_byte_identical(case):
    body = g.build_challenge(**case["args"])
    assert body == case["body"]
    assert json.dumps(body) == json.dumps(case["body"]), "key order differs"


def test_the_discovery_document_is_identical():
    d = FIXTURE["discovery"]
    assert json.dumps(g.build_discovery_document(**d["args"])) == json.dumps(d["body"])


def test_scope_coverage_matches_on_every_case():
    wrong = [c for c in FIXTURE["scope_cases"] if g.scope_covers(c[0], c[1], c[2]) != c[3]]
    assert not wrong


@pytest.mark.parametrize("scenario", FIXTURE["scenarios"], ids=lambda s: s["name"])
def test_every_node_scenario_replays_identically(scenario):
    o = scenario["opts"]
    gate = g.Gate(
        FIXTURE["merchant_id"], jwks=FIXTURE["jwks"], resource=o.get("resource"), tier=o.get("tier") or "standard",
        weight=o.get("weight"), require_agent_match=bool(o.get("requireAgentMatch")), api_base=o.get("apiBase"),
        should_charge=g.known_ai_agent if o.get("shouldCharge") == "known" else None,
    )
    for i, r in enumerate(scenario["requests"]):
        got = gate.decide(g.SimpleRequest(r["path"], r["headers"])).as_dict()
        assert got == r["result"], f"request {i}"
