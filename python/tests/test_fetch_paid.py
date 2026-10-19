"""AiFinPayAgent.fetch_paid wires the AIFP-1 flow to this agent's own key, chain
client, durable journal and persisted ledger — and recover_paid resumes from
that journal without paying again. The flow itself is covered in test_aifp1.
"""

import json
import os
import stat

import pytest
import requests

import aifinpay
import aifinpay.aifp1 as a
from aifinpay import AiFinPayAgent


@pytest.fixture
def agent():
    return AiFinPayAgent.new()


def test_fetch_paid_passes_its_own_key_limits_and_journal(agent, tmp_path, monkeypatch):
    seen = {}

    def fake_fetch(url, **kw):
        seen.update(kw, url=url)
        kw["on_prepared"]({"tx_ref": "0x" + "ab" * 32, "quote": {"quote_id": "qt_1"},
                           "serialized_transaction": "0x02"})
        kw["ledger"].record(0.1)
        return "response"

    monkeypatch.setattr(a, "aifp1_fetch", fake_fetch)
    out = agent.fetch_paid("https://shop.example/x", allowed_origins=["https://shop.example"],
                           max_amount_usd=0.5, daily_amount_usd=2, max_gas_pol=0.02,
                           journal_dir=str(tmp_path), asset="USDC")
    assert out == "response"
    assert seen["account"].address == agent.evm_address == seen["agent_id"]
    assert seen["max_gas_wei"] == 2 * 10**16 and seen["asset"] == "USDC" and seen["scope"] == "prefix"
    assert seen["ledger"].per_payment_usd == 0.5 and seen["ledger"].daily_usd == 2

    entry = tmp_path / ("0x" + "ab" * 32 + ".json")
    assert stat.S_IMODE(os.stat(entry).st_mode) == 0o600
    assert json.loads(entry.read_text())["journal_path"] == str(entry)
    assert stat.S_IMODE(os.stat(tmp_path / "spend.json").st_mode) == 0o600


def test_the_daily_limit_survives_a_new_agent_process(agent, tmp_path, monkeypatch):
    def spend(url, **kw):
        kw["ledger"].check(0.3)
        kw["ledger"].record(0.3)
        return "ok"

    monkeypatch.setattr(a, "aifp1_fetch", spend)
    kw = dict(allowed_origins=["https://shop.example"], max_amount_usd=1, daily_amount_usd=0.5,
              journal_dir=str(tmp_path))
    agent.fetch_paid("https://shop.example/x", **kw)
    with pytest.raises(a.Aifp1QuoteError):
        AiFinPayAgent.new().fetch_paid("https://shop.example/x", **kw)


def test_a_pay_error_points_at_its_journal_and_recovery_resumes_it(agent, tmp_path, monkeypatch):
    tx = "0x" + "cd" * 32

    def fails_after_settling(url, **kw):
        recovery = {"api_base": "https://api.aifinpay.io", "issuer": "https://api.aifinpay.io",
                    "quote": {"quote_id": "qt_9"}, "tx_ref": tx, "asset": "POL"}
        kw["on_prepared"]({**recovery, "serialized_transaction": "0x02"})
        raise a.Aifp1PayError("unconfirmed", tx, "qt_9", recovery)

    monkeypatch.setattr(a, "aifp1_fetch", fails_after_settling)
    with pytest.raises(a.Aifp1PayError) as e:
        agent.fetch_paid("https://shop.example/x", allowed_origins=["https://shop.example"],
                         max_amount_usd=1, daily_amount_usd=1, journal_dir=str(tmp_path))
    path = e.value.recovery["journal_path"]

    submitted = {}

    def submit(session, account, recovery, agent_id=None):
        submitted.update(recovery=recovery, account=account)
        return {"receipt": "h.p.s", "expires_at": "2099-01-01T00:00:00.000Z", "scope": "prefix",
                "resource": "/", "receipt_id": "rcpt_1", "unit_quota": 200, "merchant_id": "mrch_acme"}

    monkeypatch.setattr(a, "submit_payment", submit)
    paid = agent.recover_paid(path)
    assert submitted["recovery"]["tx_ref"] == tx and submitted["account"] is agent.evm_account
    assert paid["receipt_id"] == "rcpt_1"
    assert agent._aifp1_receipts["mrch_acme"][0]["jwt"] == "h.p.s"


def test_the_default_gas_cap_covers_a_usdc_purchase_at_a_250_gwei_base_fee(agent, tmp_path, monkeypatch):
    from aifinpay.settlement_v14 import STABLE_SETTLE_GAS_BOUND

    seen = {}
    monkeypatch.setattr(a, "aifp1_fetch", lambda url, **kw: seen.update(kw) or "ok")
    agent.fetch_paid("https://shop.example/x", allowed_origins=["https://shop.example"],
                     max_amount_usd=1, daily_amount_usd=1, journal_dir=str(tmp_path))
    worst_fee = 2 * 250 * 10**9 + 30 * 10**9  # 2 x base fee + tip, in wei per gas
    approval_bound = 70_000
    assert seen["max_gas_wei"] >= (approval_bound + STABLE_SETTLE_GAS_BOUND) * worst_fee


def test_base_selects_its_rpc_and_explicit_native_wei_budget(tmp_path, monkeypatch):
    agent = AiFinPayAgent.new(polygon_rpc="https://polygon-rpc.example", base_rpc="https://base-rpc.example")
    seen = {}
    monkeypatch.setattr(a, "aifp1_fetch", lambda url, **kw: seen.update(kw) or "ok")
    agent.fetch_paid("https://shop.example/x", allowed_origins=["https://shop.example"],
                     max_amount_usd=1, daily_amount_usd=1, journal_dir=str(tmp_path),
                     chain="base", max_gas_wei=10**15)
    assert seen["chain"] == "base" and seen["max_gas_wei"] == 10**15
    assert seen["polygon_rpc"] == "https://base-rpc.example"
    assert agent._web3("base").provider.endpoint_uri == "https://base-rpc.example"
    assert agent._web3().provider.endpoint_uri == "https://polygon-rpc.example"
    assert agent._web3("base") is not agent._web3()


@pytest.mark.parametrize("gas", [None, 0, -1, True, 0.01, float("nan")])
def test_base_cannot_reuse_the_legacy_pol_gas_default(agent, tmp_path, monkeypatch, gas):
    monkeypatch.setattr(a, "aifp1_fetch", lambda *_a, **_kw: pytest.fail("must refuse before any request"))
    with pytest.raises(a.Aifp1QuoteError):
        agent.fetch_paid("https://shop.example/x", allowed_origins=["https://shop.example"],
                         max_amount_usd=1, daily_amount_usd=1, journal_dir=str(tmp_path),
                         chain="base", max_gas_wei=gas)
    assert list(tmp_path.iterdir()) == []


def test_fetch_paid_keeps_merchant_pins_beside_its_journal(agent, tmp_path, monkeypatch):
    seen = {}
    monkeypatch.setattr(a, "aifp1_fetch", lambda url, **kw: seen.update(kw) or "ok")
    agent.fetch_paid("https://gateway.aifinpay.io/acme/x", allowed_origins=["https://gateway.aifinpay.io"],
                     max_amount_usd=1, daily_amount_usd=1, journal_dir=str(tmp_path),
                     expected_merchant_id="mrch_acme", allow_merchant_change=True)
    assert isinstance(seen["merchant_pins"], a.MerchantPins)
    assert seen["merchant_pins"].directory == str(tmp_path / "merchant-pins")
    assert seen["expected_merchant_id"] == "mrch_acme" and seen["allow_merchant_change"] is True

    agent.fetch_paid("https://gateway.aifinpay.io/acme/x", allowed_origins=["https://gateway.aifinpay.io"],
                     max_amount_usd=1, daily_amount_usd=1, journal_dir=str(tmp_path))
    assert seen["expected_merchant_id"] is None and seen["allow_merchant_change"] is False


# ── Who is asking ─────────────────────────────────────────────────────────────
#
# A content site's gate (gate/src/agents.ts, knownAiAgent) decides from the
# request alone whether to answer 402 or serve the page as it would to a human:
# an AIFP-Agent-Id header, or a User-Agent naming one of our own clients, is the
# declaration. Until 2.6.1 the first GET of fetch_paid carried neither — it went
# out as "python-requests/x.y" — so such a gate served the content free and the
# agent never met the paywall. Node's aifp1Fetch sets AIFP-Agent-Id (the agent's
# EVM address) on first and paid requests alike; these pin the same for Python.

FAR_FUTURE = 4102444800  # 2100-01-01T00:00:00Z


class RecordingSession(requests.Session):
    """A real Session whose transport is replaced: records every prepared
    request (session defaults merged in, exactly what would hit the wire) and
    answers from a scripted list."""

    def __init__(self, scripted):
        super().__init__()
        self.scripted = list(scripted)
        self.sent = []

    def send(self, request, **kwargs):
        self.sent.append(request)
        status, body = self.scripted.pop(0)
        resp = requests.Response()
        resp.status_code = status
        resp._content = json.dumps(body).encode() if body is not None else b"ok"
        resp.headers["content-type"] = "application/json" if body is not None else "text/html"
        resp.url = request.url
        resp.request = request
        return resp


def _identifying(req):
    return {k: v for k, v in req.headers.items() if k.lower() in ("user-agent", "aifp-agent-id", "aifp-receipt")}


def test_the_first_request_declares_the_agent_like_node_does(agent, tmp_path):
    session = RecordingSession([(200, None)])
    agent._aifp1_session = session

    out = agent.fetch_paid("https://shop.example/x", allowed_origins=["https://shop.example"],
                           max_amount_usd=1, daily_amount_usd=1, journal_dir=str(tmp_path))

    assert out.status_code == 200 and len(session.sent) == 1
    assert _identifying(session.sent[0]) == {
        "User-Agent": f"aifinpay-agent-py/{aifinpay.__version__}",
        "AIFP-Agent-Id": agent.evm_address,
    }
    # The version comes from the package, not a literal: it is the one pyproject
    # publishes, so `pip show` and the header a merchant logs agree.
    assert not aifinpay.__version__.startswith("0+"), "run the tests against an installed checkout"
    assert "python-requests" not in session.sent[0].headers["User-Agent"]


def test_the_paid_retry_keeps_the_declaration_next_to_the_receipt(agent, tmp_path):
    challenge = {"protocol": "AIFP-1", "merchant_id": "mrch_acme", "resource": "/x", "how_to_pay": []}
    session = RecordingSession([(402, challenge), (200, None)])
    agent._aifp1_session = session
    agent._aifp1_receipts = {"mrch_acme": [{"jwt": "h.p.s", "expires_at": FAR_FUTURE, "scope": "prefix",
                                            "resource": "/", "receipt_id": "rcpt_1", "unit_quota": 10}]}

    out = agent.fetch_paid("https://shop.example/x", allowed_origins=["https://shop.example"],
                           max_amount_usd=1, daily_amount_usd=1, journal_dir=str(tmp_path))

    assert out.status_code == 200 and len(session.sent) == 2
    assert _identifying(session.sent[1]) == {
        "User-Agent": f"aifinpay-agent-py/{aifinpay.__version__}",
        "AIFP-Agent-Id": agent.evm_address,
        "AIFP-Receipt": "h.p.s",
    }


def test_the_legacy_agent_session_carries_the_same_user_agent():
    from aifinpay import Agent

    assert Agent.new()._session.headers["User-Agent"] == f"aifinpay-agent-py/{aifinpay.__version__}"
