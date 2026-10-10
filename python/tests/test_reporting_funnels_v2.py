"""S06 optional header author tests: synthetic HTTP and local signing only."""
import json
from unittest.mock import Mock

import pytest
from test_aifp1 import API, SHOP, Harness, no_sleep, pinned

import aifinpay.aifp1 as a
import aifinpay.client as c
from aifinpay import Agent, AiFinPayAgent

CAP = "R" * 43


def test_quote_only_optional_header_preserves_one_payment_and_reuse(pinned):
    h = Harness(pinned)
    calls = []
    post = h.server.post
    get = h.server.get
    def spy_post(url, **kw):
        calls.append((url, kw))
        return post(url, **kw)
    def spy_get(url, **kw):
        calls.append((url, kw))
        return get(url, **kw)
    h.server.post, h.server.get = spy_post, spy_get
    assert h.fetch(reporting_token=CAP).status_code == 200
    assert h.fetch(reporting_token="S" * 43).status_code == 200
    assert h.server.quotes == 1 and len(h.server.pays) == 1 and len(h.chain.sent) == 1
    quotes = [(u, kw) for u, kw in calls if u == API + "/v1/quote"]
    assert len(quotes) == 1 and quotes[0][1]["headers"] == {"AIFP-Reporting-Token": CAP}
    for u, kw in calls:
        if u != API + "/v1/quote":
            assert "AIFP-Reporting-Token" not in kw.get("headers", {})
    assert CAP not in json.dumps(h.journal) + json.dumps(h.receipts) + json.dumps(h.ledger._memory)
    assert CAP not in json.dumps(h.server.last_quote_request) + json.dumps(h.server.pays)


@pytest.mark.parametrize("value", [None, "", "x.y.z", "x\r\nsecret", "x" * 42, "x" * 44, 42, {"token": CAP}])
def test_bad_option_does_not_alter_payment(pinned, value):
    h = Harness(pinned)
    assert h.fetch(reporting_token=value).status_code == 200
    assert len(h.chain.sent) == 1 and len(h.server.pays) == 1


@pytest.mark.parametrize("base,url", [
    ("https://foreign.invalid", "https://foreign.invalid/v1/quote"),
    (API, "https://foreign.invalid/v1/quote"),
    (API, API + "/v1/pay"), (API, API + "/v1/quote?q=secret"),
    (API, API + "/v1/quote#frag"), (API, "https://api.aifinpay.io:443/v1/quote"),
    ("https://api.aifinpay.io@foreign.invalid", "https://api.aifinpay.io@foreign.invalid/v1/quote"),
    (API, API + "/.well-known/jwks.json"),
])
def test_no_noncanonical_foreign_or_financial_targets(base, url):
    assert c._reporting_headers(CAP, url, base) == {}


def test_optional_header_failure_does_not_cause_payment_retry(pinned):
    h = Harness(pinned)
    original = h.server.post
    calls = []
    def unavailable(url, **kw):
        calls.append((url, kw))
        # Server may ignore optional reporting; original payment still succeeds.
        if url.endswith("/v1/quote"):
            kw.pop("headers", None)
        return original(url, **kw)
    h.server.post = unavailable
    assert h.fetch(reporting_token=CAP).status_code == 200
    assert len(h.chain.sent) == 1
    assert sum(u.endswith("/v1/quote") for u, _ in calls) == 1
    assert sum(u.endswith("/v1/pay") for u, _ in calls) == 1


@pytest.mark.parametrize("url,method,want", [(API + "/v1/quote", "POST", True),
    (API + "/v1/quote", "GET", False), (API + "/v1/pay", "POST", False),
    ("https://foreign.invalid/v1/quote", "POST", False)])
def test_lowlevel_client_initial_quote_only_and_no_redirect(url, method, want, monkeypatch):
    agent = Agent.new(base_url=API)
    session = Mock()
    session.request.return_value.status_code = 200
    agent._session = session
    agent.pay(url, method=method, reporting_token=CAP)
    kw = session.request.call_args.kwargs
    assert kw["allow_redirects"] is False
    assert kw["headers"].get("AIFP-Reporting-Token") == (CAP if want else None)
    assert session.request.call_count == 1


def test_lowlevel_auth_retry_never_receives_reporting(monkeypatch):
    agent = Agent.new(base_url=API)
    first, second = Mock(), Mock()
    first.status_code, first.request = 402, None
    second.status_code = 200
    agent._session = Mock()
    agent._session.request.side_effect = [first, second]
    facilitator = Mock(name="fake")
    facilitator.name = "test"
    facilitator.build_auth.return_value = {"headers": {"x-signature": "synthetic"}}
    monkeypatch.setattr(c, "detect_facilitator", lambda *_a, **_k: facilitator)
    assert agent.pay(API + "/v1/quote", method="POST", reporting_token=CAP).status_code == 200
    calls = agent._session.request.call_args_list
    assert calls[0].kwargs["headers"]["AIFP-Reporting-Token"] == CAP
    assert "AIFP-Reporting-Token" not in calls[1].kwargs["headers"]
    assert CAP not in str(facilitator.build_auth.call_args)


def test_unified_facade_token_not_in_journal_or_ledger(tmp_path, monkeypatch):
    seen = {}
    def fake_fetch(url, **kw):
        seen.update(kw)
        kw["on_prepared"]({"tx_ref": "0xsynthetic", "serialized_transaction": "0x02"})
        kw["ledger"].record(.1)
        return "ok"
    monkeypatch.setattr(a, "aifp1_fetch", fake_fetch)
    agent = AiFinPayAgent.new()
    assert agent.fetch_paid(SHOP + "/data", allowed_origins=[SHOP], max_amount_usd=1,
                            daily_amount_usd=2, journal_dir=str(tmp_path), reporting_token=CAP) == "ok"
    assert seen["reporting_token"] == CAP
    assert CAP not in "".join(p.read_text() for p in tmp_path.iterdir())


def test_legacy_quote_split_header_only_and_redirect_refusal():
    agent = Agent.new(base_url="https://aifinpay.io")
    agent._session = Mock()
    agent._session.get.return_value.json.return_value = {"total": "1"}
    assert agent.quote_split(chain="polygon", merchant_amount=1, reporting_token=CAP) == {"total": "1"}
    kw = agent._session.get.call_args.kwargs
    assert kw["headers"] == {"AIFP-Reporting-Token": CAP}
    assert kw["allow_redirects"] is False
    assert CAP not in str(kw["params"])
    agent.quote_split(chain="polygon", merchant_amount=1)
    assert "headers" not in agent._session.get.call_args.kwargs
