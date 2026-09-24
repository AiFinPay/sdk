"""AiFinPayAgent.fetch_paid wires the AIFP-1 flow to this agent's own key, chain
client, durable journal and persisted ledger — and recover_paid resumes from
that journal without paying again. The flow itself is covered in test_aifp1.
"""

import json
import os
import stat

import pytest

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
