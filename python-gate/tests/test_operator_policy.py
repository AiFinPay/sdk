"""Per-operator access policy — allow / charge / block, decided by the merchant.

The recorded Node scenarios in test_parity.py hold the two ports to the same
answers; this file covers the contract on its own terms: a gate without rules
is the gate it was, the three actions and their events in enforce and shadow,
a verified_only rule decided after the receipt verified, and the pure
precedence with normalisation of what the control plane sent.
"""

import pytest

import aifinpay_gate as g
from aifinpay_gate.operator_policy import decide_operator, normalize_operator_policy
from test_gate import gate, req, token

GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2; +https://openai.com/gptbot)"
CLAUDEBOT_UA = "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)"
PERPLEXITY_UA = "Mozilla/5.0 (compatible; PerplexityBot/1.0)"
BROWSER_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Safari/605.1.15"


def policy(rules, default="charge"):
    return {"operator_rules": rules, "operator_default": default}


def recording(**kw):
    events = []
    return gate(on_event=events.append, **kw), events


def run(gt, events, **headers):
    events.clear()
    result = gt.decide(req(**headers))
    return result.as_dict(), [dict(e) for e in events]


@pytest.mark.parametrize("mode", ["enforce", "shadow"])
@pytest.mark.parametrize("should_charge", [None, g.known_ai_agent])
def test_a_gate_without_rules_is_the_gate_it_was(mode, should_charge):
    baseline, base_events = recording(mode=mode, should_charge=should_charge)
    requests = [
        {"User-Agent": GPTBOT_UA},
        {"User-Agent": BROWSER_UA},
        {"User-Agent": "ChatGPT-User/1.0", "AIFP-Agent-Id": "agt_claimed"},
        {},
        {"AIFP-Receipt": token(unit_quota=5)},
        {"AIFP-Receipt": token(aud="mrch_other")},
    ]
    expected = [run(baseline, base_events, **h) for h in requests]
    for label, extra in [
        ("none", {}),
        ("explicit None", {"operator_policy": None}),
        ("no rules", {"operator_policy": policy([])}),
        ("callable without rules", {"operator_policy": lambda: policy([])}),
        ("callable returning None", {"operator_policy": lambda: None}),
    ]:
        candidate, events = recording(mode=mode, should_charge=should_charge, **extra)
        for i, headers in enumerate(requests):
            assert run(candidate, events, **headers) == expected[i], f"{label}, request {i}"


RULES = policy([
    {"operator": "openai", "action": "allow"},
    {"operator": "anthropic", "action": "block"},
    {"ua_class": "unknown", "action": "block"},
])


def test_allow_serves_free_with_an_exempt_serve_event_naming_the_rule():
    gt, events = recording(operator_policy=RULES, should_charge=g.known_ai_agent)
    result, seen = run(gt, events, **{"User-Agent": GPTBOT_UA})
    assert (result["ok"], result["status"], result["headers"]) == (True, 200, {"AIFP-Paywall": "exempt"})
    assert result["aifp"]["mode"] == "exempt" and result["aifp"]["weight"] == 0
    assert seen == [{
        "kind": "serve", "resource": "/paid", "weight": 1, "agent": None, "exempt": True,
        "detail": "operator policy: allow (operator=openai)",
        "operator": "openai", "ua_class": "ai_crawler", "verified": False,
    }]


def test_charge_is_the_existing_402_path():
    gt, events = recording(operator_policy=RULES, should_charge=g.known_ai_agent)
    result, seen = run(gt, events, **{"User-Agent": PERPLEXITY_UA})
    assert (result["ok"], result["status"], result["body"]["error"]) == (False, 402, "AIFP-402")
    assert seen == [{"kind": "402", "resource": "/paid", "weight": 1, "detail": None,
                     "operator": "perplexity", "ua_class": "ai_crawler", "verified": False}]


def test_block_answers_403_with_the_aifp_403_body_and_a_403_event():
    gt, events = recording(operator_policy=RULES, should_charge=g.known_ai_agent)
    result, seen = run(gt, events, **{"User-Agent": CLAUDEBOT_UA})
    assert (result["ok"], result["status"], result["headers"]) == (False, 403, {"Content-Type": "application/json"})
    assert result["body"] == {"error": "AIFP-403", "detail": "blocked by merchant policy (operator rule)"}
    assert seen == [{"kind": "403", "resource": "/paid", "weight": 1,
                     "detail": "operator policy: block (operator=anthropic)",
                     "operator": "anthropic", "ua_class": "ai_crawler", "verified": False}]
    headless, seen = run(gt, events, **{"User-Agent": "Mozilla/5.0 HeadlessChrome/126.0"})
    assert headless["status"] == 403 and seen[0]["detail"] == "operator policy: block (ua_class=unknown)"


def test_the_operator_layer_sits_before_should_charge():
    gt, events = recording(operator_policy=RULES)
    assert run(gt, events, **{"User-Agent": GPTBOT_UA})[0]["status"] == 200
    assert run(gt, events, **{"User-Agent": BROWSER_UA})[0]["status"] == 402
    block_all, events = recording(operator_policy=policy([], "block"), should_charge=g.known_ai_agent)
    assert run(block_all, events, **{"User-Agent": BROWSER_UA})[0]["status"] == 200
    assert run(block_all, events, **{"User-Agent": GPTBOT_UA})[0]["status"] == 403
    assert run(block_all, events)[0]["status"] == 403


def test_an_allow_rule_still_yields_to_the_merchants_veto():
    gt, events = recording(operator_policy=RULES, allow=lambda ctx: False)
    result, _ = run(gt, events, **{"User-Agent": GPTBOT_UA})
    assert result["status"] == 403 and result["body"]["detail"] == "blocked by merchant policy"


def test_the_policy_is_read_per_request():
    current = {"value": None}
    gt, events = recording(operator_policy=lambda: current["value"], should_charge=g.known_ai_agent)
    assert run(gt, events, **{"User-Agent": CLAUDEBOT_UA})[0]["status"] == 402
    current["value"] = policy([{"operator": "anthropic", "action": "block"}])
    assert run(gt, events, **{"User-Agent": CLAUDEBOT_UA})[0]["status"] == 403
    current["value"] = policy([{"operator": "anthropic", "action": "allow"}])
    assert run(gt, events, **{"User-Agent": CLAUDEBOT_UA})[0]["status"] == 200


def test_shadow_records_the_same_events_and_serves_every_request():
    rules = policy([{"operator": "openai", "action": "allow"}, {"operator": "anthropic", "action": "block"}])
    enforce, e_events = recording(operator_policy=rules, should_charge=g.known_ai_agent)
    shadow, s_events = recording(operator_policy=rules, should_charge=g.known_ai_agent, mode="shadow")
    for ua in (GPTBOT_UA, CLAUDEBOT_UA, PERPLEXITY_UA, BROWSER_UA):
        _, expected = run(enforce, e_events, **{"User-Agent": ua})
        result, seen = run(shadow, s_events, **{"User-Agent": ua})
        assert seen == expected, ua
        assert result["ok"] and result["status"] == 200 and result["headers"][g.HEADER_MODE] == "shadow"
    blocked, seen = run(shadow, s_events, **{"User-Agent": CLAUDEBOT_UA})
    assert blocked["headers"][g.HEADER_SHADOW_STATUS] == "403"
    assert blocked["aifp"]["mode"] == "shadow"
    assert blocked["aifp"]["shadow"] == {"status": 403, "error": "AIFP-403",
                                         "detail": "blocked by merchant policy (operator rule)", "weight": 1}
    assert seen[0]["detail"] == "operator policy: block (operator=anthropic)"
    allowed, _ = run(shadow, s_events, **{"User-Agent": GPTBOT_UA})
    assert allowed["headers"] == {"AIFP-Paywall": "exempt", g.HEADER_MODE: "shadow"}
    assert allowed["aifp"]["mode"] == "exempt"


VERIFIED_RULES = policy([
    {"operator": "aifinpay", "action": "allow", "verified_only": True},
    {"ua_class": "aifp_agent", "action": "block"},
])


def test_verified_only_allows_a_verified_receipt_free_and_blocks_a_claim():
    gt, events = recording(operator_policy=VERIFIED_RULES)
    tok = token(unit_quota=1, receipt_id="rcpt_verified_only", sub="agt_payer")
    for _ in range(3):  # never spent: the merchant said this caller does not pay
        result, seen = run(gt, events, **{"AIFP-Receipt": tok})
        assert (result["ok"], result["status"], result["headers"]) == (True, 200, {"AIFP-Paywall": "exempt"})
        assert result["aifp"]["mode"] == "exempt" and result["aifp"]["agent"] == "agt_payer"
        assert seen == [{"kind": "serve", "resource": "/paid", "weight": 1, "agent": "agt_payer", "exempt": True,
                         "detail": "operator policy: allow (operator=aifinpay)",
                         "operator": "aifinpay", "ua_class": "aifp_agent", "verified": True}]
    claimed, seen = run(gt, events, **{"AIFP-Agent-Id": "agt_payer"})
    assert claimed["status"] == 403
    assert seen == [{"kind": "403", "resource": "/paid", "weight": 1,
                     "detail": "operator policy: block (ua_class=aifp_agent)",
                     "operator": "aifinpay", "ua_class": "aifp_agent", "verified": False}]
    forged, seen = run(gt, events, **{"AIFP-Receipt": token(aud="mrch_other")})
    assert forged["status"] == 403 and forged["body"]["detail"] == "blocked by merchant policy (operator rule)"
    assert seen[0]["verified"] is False and seen[0]["detail"] == "operator policy: block (ua_class=aifp_agent)"


def test_with_nothing_underneath_a_claim_lands_on_the_default():
    gt, events = recording(operator_policy=policy([{"operator": "aifinpay", "action": "block", "verified_only": True}]))
    assert run(gt, events, **{"AIFP-Agent-Id": "agt_x"})[0]["status"] == 402
    tok = token(unit_quota=5)
    blocked, seen = run(gt, events, **{"AIFP-Receipt": tok})
    assert blocked["status"] == 403 and seen[0]["verified"] is True
    assert seen[0]["detail"] == "operator policy: block (operator=aifinpay)"
    # The batch is untouched: a gate without the rule meters from 5.
    plain = gate()
    assert plain.decide(req(tok)).headers[g.HEADER_QUOTA_REMAINING] == "4"


def test_a_rule_without_the_flag_applies_to_claim_and_receipt_alike():
    gt, events = recording(operator_policy=policy([{"operator": "aifinpay", "action": "block"}]))
    assert run(gt, events, **{"AIFP-Agent-Id": "agt_x"})[0]["status"] == 403
    result, seen = run(gt, events, **{"AIFP-Receipt": token()})
    assert result["status"] == 403 and seen[0]["verified"] is False


def test_precedence_and_readers():
    pol = policy([{"ua_class": "ai_crawler", "action": "block"}, {"operator": "openai", "action": "charge"}], "allow")

    def d(**who):
        r = decide_operator(pol, who)
        return f"{r['action']}/{r['matched']}"

    assert d(operator="openai", ua_class="ai_crawler", verified=False) == "charge/operator"
    assert d(operator="bytedance", ua_class="ai_crawler", verified=False) == "block/ua_class"
    assert d(operator="anthropic", ua_class="ai_agent_browser", verified=False) == "allow/default"
    assert d(operator="unknown", ua_class="human", verified=False) == "charge/none"
    assert decide_operator(None, {"operator": "openai", "ua_class": "ai_crawler", "verified": False})["matched"] == "none"
    assert decide_operator(pol, {"operator": "anthropic", "ua_class": "ai_agent_browser", "verified": False})["detail"] \
        == "operator policy: allow (default)"
    assert g.OPERATOR_ACTIONS == ("allow", "charge", "block") and g.OPERATOR_DEFAULT == "charge"


def test_normalisation_drops_unknown_values_rather_than_guessing():
    assert normalize_operator_policy(None) is None
    assert normalize_operator_policy({"merchant_id": "mrch_old"}) is None
    assert normalize_operator_policy({"operator_rules": []}) == {"operator_rules": [], "operator_default": "charge"}
    assert normalize_operator_policy({
        "operator_rules": [
            {"operator": "openai", "action": "block", "note": "must not travel"},
            {"operator": "openai", "action": "allow"},
            {"operator": "newcomer", "action": "allow"},
            {"ua_class": "human", "action": "block"},
            {"ua_class": "ai_crawler", "action": "charge", "verified_only": "yes"},
            {"operator": "anthropic", "ua_class": "ai_crawler", "action": "allow"},
            {"operator": "aifinpay", "action": "ration"},
            {"operator": "aifinpay", "action": "allow", "verified_only": True},
            "openai",
        ],
        "operator_default": "maybe",
    }) == {
        "operator_rules": [
            {"operator": "openai", "action": "block", "verified_only": False},
            {"ua_class": "ai_crawler", "action": "charge", "verified_only": False},
            {"operator": "aifinpay", "action": "allow", "verified_only": True},
        ],
        "operator_default": "charge",
    }


def test_the_control_plane_view_is_normalised_at_the_door():
    view = {"merchant_id": "mrch_test", "operator_rules": [{"operator": "anthropic", "action": "block", "note": "x"},
                                                           {"operator": "nobody", "action": "allow"}],
            "operator_default": "charge"}
    gt, events = recording(operator_policy=view, should_charge=g.known_ai_agent)
    assert run(gt, events, **{"User-Agent": CLAUDEBOT_UA})[0]["status"] == 403
    assert run(gt, events, **{"User-Agent": GPTBOT_UA})[0]["status"] == 402
