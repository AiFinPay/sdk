"""What 0.7.0 changed: a path is compared as an origin could resolve it, a caller
naming someone else is refused by default, a receipt from another network does
not open the site, and shadow spends nothing. test_parity.py holds the same
answers to the Node gate; these cover what only exists here, the route list."""

import pytest

import aifinpay_gate as g
from test_gate import MID, gate, req, token

GPTBOT = {"User-Agent": "Mozilla/5.0 (compatible; GPTBot/1.2)"}
BROWSER = {"User-Agent": "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Safari/605.1.15"}
SECTIONS = [g.Route("/paid/*"), g.Route("/paid/premium/*", "premium"), g.Route("/report", "complex")]
PAYER = "0x00000000000000000000000000000000000000AA"


def routed(**kw):
    return gate(routes=SECTIONS, **kw)


@pytest.mark.parametrize("spelled", ["/PAID/PREMIUM/x", "/paid/premium/x/", "/%70aid/premium/x", "/paid;a=1/premium/x",
                                     "/;x/paid/premium/x"])
def test_a_spelling_does_not_buy_another_price(spelled):
    answer = routed().decide(req(path=spelled, **GPTBOT))
    assert answer.status == 402
    assert answer.body["resource"] == "/paid/premium/*" and answer.body["unit_weight"] == 10


def test_a_route_with_a_capital_or_a_slash_still_matches():
    gt = gate(routes=[g.Route("/Paid/*", "premium"), g.Route("/report/", "complex")])
    assert gt.decide(req(path="/paid/a")).body["unit_weight"] == 10
    assert gt.decide(req(path="/REPORT")).body["resource"] == "/report/"


def test_route_for_reads_a_raw_spelling_on_its_own():
    assert routed().route_for("/PAID/a").pattern == "/paid/*"


def test_case_sensitive_keeps_them_apart():
    gt = routed(case_sensitive=True)
    assert gt.decide(req(path="/PAID/a")) is None
    assert gt.decide(req(path="/paid/a")).status == 402


@pytest.mark.parametrize("path,claims", [
    ("/PAID/a", {"resource": "/paid/*"}),
    ("/paid/a/", {"resource": "/paid/*"}),
    ("/paid", {"resource": "/paid/", "scope": "prefix"}),
    ("/report/", {"resource": "/report"}),
    ("/report", {"resource": "/report/"}),
    ("/report", {"resource": "/Report"}),
])
def test_a_receipt_covers_the_page_however_it_is_spelled(path, claims):
    assert routed().decide(req(token(unit_quota=20, **claims), path)).status == 200


def test_another_page_is_still_refused():
    assert routed().decide(req(token(resource="/paid/a"), "/PAID/b")).status == 403


def test_an_ambiguous_path_is_refused_for_an_agent_only_and_reports_nothing():
    events = []
    gt = routed(should_charge=g.known_ai_agent, on_event=events.append)
    answer = gt.decide(req(path="/paid/..;/../a", **GPTBOT))
    assert (answer.status, answer.body["error"]) == (400, "noncanonical_path")
    assert answer.headers["Cache-Control"] == g.NO_STORE and events == []
    assert gt.decide(req(path="/paid/./a", **BROWSER)).status == 200


def test_an_ambiguous_path_outside_every_route_is_refused_too():
    assert routed().decide(req(path="/free/../a", **GPTBOT)).status == 400


def test_an_ambiguous_path_is_observed_in_shadow():
    answer = routed(mode="shadow").decide(req(path="/x/../paid/a", **GPTBOT))
    assert answer.status == 200 and answer.headers[g.HEADER_SHADOW_STATUS] == "402"


def test_a_mount_with_a_resource_charges_whatever_it_is_handed():
    assert gate().decide(req(path="/x/../y", **GPTBOT)).status == 402


def asked(agent, *, options=None, **claims):
    headers = {"AIFP-Agent-Id": agent} if agent else {}
    return gate(**(options or {})).decide(req(token(**claims), **headers))


def test_a_caller_naming_someone_else_is_refused_by_default():
    assert asked("0x00000000000000000000000000000000000000bb", sub=PAYER).status == 403


def test_a_caller_naming_nobody_is_served():
    assert asked(None, sub=PAYER).status == 200


def test_an_address_reads_in_any_spelling_its_chain_allows():
    assert asked(PAYER.lower(), sub=PAYER).status == 200
    assert asked("0x1", sub="0x" + "0" * 63 + "1", chain="aptos").status == 200


def test_the_payer_claim_comes_before_the_subject():
    assert asked(PAYER, sub="agt_other", payer=PAYER).status == 200
    assert asked("agt_other", sub="agt_other", payer=PAYER).status == 403


def test_binding_can_be_switched_off():
    assert asked("someone-else", sub=PAYER, options={"require_agent_match": False}).status == 200


def test_the_402_asks_for_the_header_it_will_compare():
    assert "AIFP-Agent-Id" in " ".join(gate().decide(req()).body["how_to_pay"])


@pytest.mark.parametrize("site,claims,status", [
    ("live", {"network_mode": "test"}, 403),
    ("test", {}, 403),
    ("test", {"network_mode": "test"}, 200),
    ("live", {}, 200),
    (None, {"network_mode": "test"}, 200),
    (lambda: "test", {}, 403),
])
def test_a_receipt_from_another_network(site, claims, status):
    assert gate(network_mode=site).decide(req(token(**claims))).status == status


def test_a_network_mode_the_gate_does_not_know_refuses_to_start():
    with pytest.raises(ValueError, match="network_mode"):
        g.Gate(MID, resource="/paid", network_mode="Live")


def test_shadow_never_reaches_the_store_and_reports_the_receipt_as_verified():
    class Untouched:
        def incr_by(self, *_a):
            raise AssertionError("shadow reached the store")

    events = []
    gt = gate(mode="shadow", store=Untouched(), on_event=events.append)
    single_use = token(unit_quota=1)
    for _ in range(3):
        answer = gt.decide(req(single_use))
        assert answer.status == 200 and g.HEADER_SHADOW_STATUS not in answer.headers
        assert g.HEADER_QUOTA_REMAINING not in answer.headers
        assert answer.aifp["mode"] == "shadow" and answer.aifp["used"] == 0
    assert [(e["kind"], e["verified"], e["ua_class"]) for e in events] == [("serve", True, "aifp_agent")] * 3


def test_shadow_still_reads_a_bad_receipt_as_a_would_be_refusal():
    assert gate(mode="shadow").decide(req(token(unit_quota=0))).headers[g.HEADER_SHADOW_STATUS] == "403"
