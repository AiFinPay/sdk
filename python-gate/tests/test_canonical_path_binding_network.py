"""What 0.7.0 changed: a path is compared as an origin could resolve it, a caller
naming someone else is refused by default, a receipt from another network does
not open the site, and shadow spends nothing. test_parity.py holds the same
answers to the Node gate; these cover what only exists here, the route list."""

import pytest

import aifinpay_gate as g
from test_adapters import app, call_asgi, call_wsgi, wsgi_app
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


@pytest.mark.parametrize("decoded", ["/x?/../paid/a", "/x#/../paid/a"])
def test_a_decoded_query_mark_is_part_of_the_path_on_both_adapters(decoded):
    # What a server hands over for /x%3F/../paid/a: the gate must not stop reading at the "?".
    gt = routed()
    status, _, _ = call_asgi(g.AifpGateMiddleware(app, gt), decoded, GPTBOT)
    assert status == 400
    assert call_wsgi(g.AifpGateWSGI(wsgi_app, gt), decoded, GPTBOT)[0].startswith("400")


def test_a_real_query_on_a_raw_request_is_still_cut():
    assert routed().decide(req(path="/paid/a?x=1", **GPTBOT)).status == 402


@pytest.mark.parametrize("spelled,read", [
    ("/Paid/*", "/paid/*"), ("/*", "/*"), ("/report/", "/report"), ("/my%20report", "/my report"),
    ("/%64ata/two", "/data/two"), ("/a;b=1/c", "/a/c"), ("/", "/"), ("*", "*"),
])
def test_spelled_as_path(spelled, read):
    assert g.spelled_as_path(spelled) == read


def test_a_route_registered_with_an_escape_still_prices_its_page():
    gt = gate(routes=[g.Route("/paid/*"), g.Route("/paid/my%20report", "premium")])
    assert gt.decide(req(path="/paid/my%20report")).body["unit_weight"] == 10


@pytest.mark.parametrize("path,bought", [
    ("/data/my%20report", "/data/my%20report"), ("/%64ata/two", "/%64ata/two"),
    ("/data/a;b=1", "/data/a;b=1"), ("/data/two", "/%64ata/two"),
])
def test_a_receipt_with_an_escape_opens_its_page(path, bought):
    assert gate(routes=[g.Route("/data/*")]).decide(req(token(resource=bought), path)).status == 200


def test_an_unregistered_path_is_quoted_as_the_agent_asked_for_it():
    answer = gate(resource=None).decide(req(path="/Articles/My%20Report?x=1", **GPTBOT))
    assert answer.body["resource"] == "/Articles/My%20Report"
    assert gate(resource=None).decide(req(token(resource="/Articles/My%20Report"), "/Articles/My%20Report")).status == 200


@pytest.mark.parametrize("path,covers", [("/x", True), ("/x/a", True), ("/xy", False)])
def test_a_prefix_receipt_for_a_section_as_discovery_lists_it(path, covers):
    assert g.scope_covers("prefix", "/x/*", path) is covers


def test_a_callable_network_mode_is_called():
    assert gate(network_mode=lambda: "live").decide(req(token())).status == 200
    assert gate(network_mode=lambda: "test").decide(req(token(network_mode="test"))).status == 200


def test_shadow_still_reads_a_single_use_receipt_with_no_nonce_as_a_would_be_refusal():
    answer = gate(mode="shadow").decide(req(token(unit_quota=1, nonce=None)))
    assert answer.headers[g.HEADER_SHADOW_STATUS] == "403"


def test_a_mount_with_no_resource_observes_nothing_for_reporting_v2():
    reporter = g.GateReporterV2(merchant_id="mrch_0123456789abcdef", merchant_secret="synthetic", supported=["access_admitted"])
    gt = gate(resource=None, reporting=reporter)
    assert gt.reporting_for(req(path="/private/customer-42"), gt.decide(req(path="/private/customer-42"))) is None


CDN_HEADERS = [("CDN-Cache-Control", "max-age=600"), ("Surrogate-Control", "max-age=600"), ("Edge-Control", "max-age=600"), ("Akamai-Cache-Control", "max-age=600"), ("X-Accel-Expires", "600"), ("X-Own", "1")]


def test_wsgi_drops_a_cdns_own_cache_header_on_a_paid_response():
    def own(environ, start_response):
        start_response("200 OK", list(CDN_HEADERS))
        return [b"page"]

    environ = {"REQUEST_METHOD": "GET", "PATH_INFO": "/paid", "HTTP_AIFP_RECEIPT": token()}
    seen = {}
    list(g.AifpGateWSGI(own, gate(routes=[g.Route("/paid")]))(
        environ, lambda status, headers, exc_info=None: seen.update(headers=[k.lower() for k, _ in headers])))
    for name in ("cdn-cache-control", "surrogate-control", "edge-control", "akamai-cache-control", "x-accel-expires"):
        assert name not in seen["headers"]
    assert "x-own" in seen["headers"]


def test_asgi_drops_a_cdns_own_cache_header_on_a_paid_response():
    import asyncio

    async def own(scope, receive, send):
        await send({"type": "http.response.start", "status": 200,
                    "headers": [(k.lower().encode(), v.encode()) for k, v in CDN_HEADERS]})
        await send({"type": "http.response.body", "body": b"page"})

    sent = []

    async def send(message):
        sent.append(message)

    async def receive():
        return {"type": "http.request", "body": b""}

    scope = {"type": "http", "method": "GET", "path": "/paid", "headers": [(b"aifp-receipt", token().encode())]}
    asyncio.run(g.AifpGateMiddleware(own, gate=gate(routes=[g.Route("/paid")]))(scope, receive, send))
    names = [k for k, _ in sent[0]["headers"]]
    for name in (b"cdn-cache-control", b"surrogate-control", b"edge-control", b"akamai-cache-control", b"x-accel-expires"):
        assert name not in names
    assert b"x-own" in names


@pytest.mark.parametrize("raw", ["/paid/%2525252e%2525252e/x", "/paid/%252525252e%252525252e/x", "/z#/..;/paid/a",
                                 "/report;a%3Fb/c", "/report%3Ba%3Fb/c", "/report;%3F/c"])
def test_a_spelling_that_cannot_be_read_one_way_is_refused(raw):
    assert g.inspect_path(raw).ambiguous
    assert routed().decide(req(path=raw, **GPTBOT)).status == 400


def test_an_escape_is_lower_case_even_when_case_counts():
    assert g.inspect_path("/Caf%C3%A9", case_sensitive=True).path == "/Caf%c3%a9"


def test_a_path_read_again_reads_the_same():
    pieces = ["paid", "A", "%2e", "%252e", "%2e%2e", "..", ".", ";x=1", "%3F", "%253F", "%23", "%25", "%2525", "%2f",
              "%252f", "\\", "caf\u00e9", "%C3%A9", "%", "%4", "%41", "%2541", "%3B", "%5C", ""]
    for a in pieces:
        for b in pieces:
            for c in pieces:
                raw = f"/{a}/{b}{c}/x"
                for case_sensitive in (False, True):
                    once = g.inspect_path(raw, case_sensitive=case_sensitive)
                    if not once.ambiguous:
                        assert g.inspect_path(once.path, case_sensitive=case_sensitive) == once, raw


def test_an_exact_route_beats_a_wildcard_and_a_tie_goes_to_the_paid_one():
    wild, exact = g.Route("/x/*"), g.Route("/x/y", "premium")
    assert gate(routes=[wild, exact]).route_for("/x/y") is exact
    assert gate(routes=[exact, wild]).route_for("/x/y") is exact
    section, page = g.Route("/report/*"), g.Route("/report", "complex")
    assert gate(routes=[section, page]).route_for("/report") is page
    closed = g.Route("/docs/*", "premium")
    opened = g.Route("/Docs/*", paywall=False)
    assert gate(routes=[opened, closed]).route_for("/docs/x") is closed


@pytest.mark.parametrize("pattern,path", [
    ("/caf%C3%A9/*", "/caf\u00e9/x"), ("/caf\u00e9/*", "/caf\u00e9/x"), ("/caf\u00e9/*", "/caf%C3%A9/x"), ("/wiki/C%23", "/wiki/C%23"),
])
def test_a_route_with_an_escape_or_a_character_is_the_page_it_names(pattern, path):
    assert gate(routes=[g.Route(pattern, "premium")]).decide(req(path=path, **GPTBOT)).body["unit_weight"] == 10


def test_the_wsgi_adapter_reads_pep_3333_bytes():
    from aifinpay_gate.wsgi import _WsgiRequest
    assert _WsgiRequest({"PATH_INFO": "/caf\u00c3\u00a9/x"}).path == "/caf%c3%a9/x"
    assert g.inspect_path(_WsgiRequest({"PATH_INFO": "/wiki/C#"}).path).path == "/wiki/c%23"


def test_the_asgi_adapter_reads_an_escape_that_is_not_utf8():
    from aifinpay_gate.asgi import _AsgiRequest
    request = _AsgiRequest({"path": "/lat\ufffd/x", "raw_path": b"/lat%E9/x"})
    answer = gate(routes=[g.Route("/lat%E9/*", "premium")]).decide(req(path=request.path, **GPTBOT))
    assert answer.status == 402 and answer.body["unit_weight"] == 10
    assert _AsgiRequest({"path": "/caf\u00e9/x", "raw_path": b"/caf%C3%A9/x"}).path == "/caf%C3%A9/x"
    assert _AsgiRequest({"path": "/plain/x", "raw_path": b"/%70lain/x"}).path == "/plain/x"


@pytest.mark.parametrize("spelled", ["/report%3Fx", "/report%23x", "/REPORT%3Fx"])
def test_an_escaped_mark_costs_the_page_before_it_and_a_receipt_for_that_page_opens_it(spelled):
    gt = routed()
    asked = gt.decide(req(path=spelled, **GPTBOT))
    assert (asked.status, asked.body["resource"], asked.body["unit_weight"]) == (402, "/report", 4)
    opened = gt.decide(req(path=spelled, **{**GPTBOT, "AIFP-Receipt": token(resource="/report", scope="exact", sub=PAYER)}))
    assert opened.status == 200


def test_a_page_with_a_mark_keeps_its_own_price_and_receipt():
    gt = gate(routes=[g.Route("/wiki/C%23", "premium"), g.Route("/wiki/C"), g.Route("/x%3Fy"), g.Route("/x", "premium")])
    own = gt.decide(req(path="/wiki/C%23", **GPTBOT))
    assert (own.body["resource"], own.body["unit_weight"]) == ("/wiki/C%23", 10)
    assert gt.decide(req(path="/wiki/C%23", **{**GPTBOT, "AIFP-Receipt": token(resource="/wiki/C%23", unit_quota=50)})).status == 200
    assert gt.decide(req(path="/wiki/C%23", **{**GPTBOT, "AIFP-Receipt": token(resource="/wiki/C", unit_quota=50, receipt_id="r2", nonce="n2")})).status == 403
    dearer = gt.decide(req(path="/x%3Fy", **GPTBOT))
    assert (dearer.body["resource"], dearer.body["unit_weight"]) == ("/x", 10)
    assert gate(routes=[g.Route("/open", paywall=False)]).route_for("/open%3Fx") is None
    assert gate(routes=[g.Route("/paid")]).route_for("/free%3F/paid") is None


def test_on_a_mount_with_no_routes_a_page_with_a_mark_is_its_own_page():
    gt = gate(routes=None)
    asked = gt.decide(req(path="/docs/what%3F", **GPTBOT))
    assert asked.status == 402 and asked.body["resource"] == "/docs/what%3F"
    assert gt.decide(req(path="/docs/what%3F", **{**GPTBOT, "AIFP-Receipt": token(resource="/docs/what%3F")})).status == 200
    assert gt.decide(req(path="/docs/what%3F", **{**GPTBOT, "AIFP-Receipt": token(resource="/docs/what", receipt_id="r2", nonce="n2")})).status == 403
