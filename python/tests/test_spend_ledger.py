"""Shared-journal budget admission and uncertain-payment recovery; no live RPC."""
import copy
import json
import multiprocessing
import os
import stat
import threading
import time
from concurrent.futures import ThreadPoolExecutor

import pytest
from eth_utils import keccak
from test_aifp1 import Harness, SHOP, API, PAYER
from test_settlement_v14 import CODE, SIGNER, FakeChain

import aifinpay.aifp1 as a
import aifinpay.settlement_v14 as s
from aifinpay import AiFinPayAgent
from aifinpay._v14_deployments import V14_DEPLOYMENTS
from aifinpay.payment_chains import PAYMENT_CHAINS


@pytest.fixture(autouse=True)
def offline_pins(monkeypatch):
    for chain in PAYMENT_CHAINS:
        dep = V14_DEPLOYMENTS[chain]
        monkeypatch.setitem(s.V14_DEPLOYMENTS, chain, dict(dep, runtimeCodeHash="0x" + keccak(CODE).hex(),
                           splitter=dict(dep["splitter"], signer=SIGNER.address)))
    monkeypatch.setattr(a.requests.Session, "request", lambda *_a, **_kw: pytest.fail("no live network"))


def binding(resource="/one", chain="polygon"):
    return {"api_base": API, "issuer": API, "payer": PAYER.address.lower(), "merchant_id": "mrch_acme",
            "scope": "exact", "resource": resource, "network_mode": "live", "chain": chain,
            "asset": "USDC", "token": "0x" + "11" * 20, "gross_amount": "600000", "quote_id": "qt_budget"}


def reserve_in_process(path, barrier, outcomes, resource):
    ledger = a.SpendLedger(1, 1, path)
    barrier.wait(timeout=10)
    try:
        ledger.reserve(0.6, binding(resource))
        outcomes.put("reserved")
    except a.Aifp1QuoteError:
        outcomes.put("refused")


def test_two_processes_share_one_atomic_daily_reservation(tmp_path):
    context = multiprocessing.get_context("spawn")
    barrier, outcomes = context.Barrier(2), context.Queue()
    path = str(tmp_path / "spend.json")
    workers = [context.Process(target=reserve_in_process, args=(path, barrier, outcomes, resource))
               for resource in ("/one", "/two")]
    for worker in workers:
        worker.start()
    try:
        results = [outcomes.get(timeout=15) for _ in workers]
        assert sorted(results) == ["refused", "reserved"]
    finally:
        for worker in workers:
            worker.join(timeout=10)
            if worker.is_alive():
                worker.terminate()
            assert worker.exitcode == 0
    assert a.SpendLedger(1, 1, path).spent_24h() == pytest.approx(0.6)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    assert stat.S_IMODE(os.stat(path + ".lock").st_mode) == 0o600


@pytest.mark.parametrize("second_chain", ["polygon", "bnb"])
def test_two_payment_instances_cannot_both_sign_60c_under_one_dollar_daily_cap(tmp_path, monkeypatch, second_chain):
    import test_aifp1
    monkeypatch.setattr(test_aifp1, "AMOUNT", "0.6")
    monkeypatch.setattr(test_aifp1, "STABLE_GROSS", 600000)
    path = str(tmp_path / "spend.json")
    harnesses = [Harness(V14_DEPLOYMENTS[chain], asset="USDC") for chain in ("polygon", second_chain)]
    quote_barrier = threading.Barrier(2)
    other_finished, execution_lock = threading.Event(), threading.Lock()
    executions = []
    real_execute = a.execute_v14_settlement

    def blocked_execute(call, ctx):
        with execution_lock:
            executions.append(call["chain"])
            first = len(executions) == 1
        if first:
            assert other_finished.wait(timeout=5), "the other call must finish its budget decision"
        else:
            other_finished.set()
        return real_execute(call, ctx)

    monkeypatch.setattr(a, "execute_v14_settlement", blocked_execute)
    for h in harnesses:
        # Both instances read an initially empty state before either request runs.
        h.ledger = a.SpendLedger(1, 1, path)
        original_quote = h.server.quote
        def quote(body, original=original_quote):
            response = original(body)
            quote_barrier.wait(timeout=5)
            return response
        h.server.quote = quote

    def purchase(index):
        try:
            return harnesses[index].fetch(f"{SHOP}/resource-{index}", scope="exact",
                                          chain=("polygon", second_chain)[index]).status_code
        except a.Aifp1QuoteError as error:
            assert "24-hour spending limit" in str(error)
            return "refused"
        finally:
            other_finished.set()

    with ThreadPoolExecutor(max_workers=2) as executor:
        futures = [executor.submit(purchase, index) for index in (0, 1)]
        results = [future.result(timeout=10) for future in futures]
    assert results.count(200) == results.count("refused") == 1
    assert len(executions) == 1, "daily admission must happen before approval or settlement signing"
    assert sorted(len(h.chain.sent) if h.chain else 0 for h in harnesses) == [0, 2]
    state = json.loads((tmp_path / "spend.json").read_text())
    assert len(state["spend"]) == 1 and not state["reservations"]
    assert a.SpendLedger(1, 1, path).spent_24h() == pytest.approx(0.6)


def test_legacy_state_is_migrated_exactly_without_truncating_active_debits(tmp_path):
    path = tmp_path / "spend.json"
    old = [{"at": time.time(), "usd": 0.001} for _ in range(1001)]
    path.write_text(json.dumps({"spend": old}))
    ledger = a.SpendLedger(2, 2, str(path))
    ledger.record(0.2)
    state = json.loads(path.read_text())
    assert state["version"] == 2 and state["spend"][:-1] == old
    assert ledger.spent_24h() == pytest.approx(1.201)
    with pytest.raises(a.Aifp1QuoteError, match="24-hour"):
        a.SpendLedger(2, 2, str(path)).reserve(0.8, binding())


@pytest.mark.parametrize("data", ["", "{}", '{"spend":null}', '{"version":99,"spend":[]}',
                                 '{"version":2,"spend":[]}', '{"spend":[{"at":1,"usd":-1}]}',
                                 '{"spend":[{"at":1,"usd":NaN}]}'])
def test_malformed_or_unknown_ledger_fails_closed_without_overwrite(tmp_path, data):
    path = tmp_path / "spend.json"
    path.write_text(data)
    with pytest.raises(a.Aifp1QuoteError, match="malformed or unsupported"):
        a.SpendLedger(1, 1, str(path))
    assert path.read_text() == data


def test_unknown_broadcast_reservation_does_not_expire_and_recovery_is_idempotent(tmp_path, monkeypatch):
    path = str(tmp_path / "spend.json")
    ledger = a.SpendLedger(1, 1, path)
    purchase, tx = binding(), "0x" + "ab" * 32
    reservation = ledger.reserve(0.6, purchase)
    ledger.prepared(reservation, tx, purchase)
    now = time.time()
    monkeypatch.setattr(a.time, "time", lambda: now + 2 * 86400)
    restarted = a.SpendLedger(1, 1, path)
    assert restarted.spent_24h() == pytest.approx(0.6)
    with pytest.raises(a.Aifp1QuoteError, match="24-hour"):
        restarted.reserve(0.6, binding("/other"))
    # Recovery records the already paid debit once; HTTP/receipt failure cannot release it.
    restarted.confirm(reservation, tx, purchase)
    restarted.confirm(reservation, tx, purchase)
    with pytest.raises(a.Aifp1QuoteError, match="confirmed payment"):
        restarted.release(reservation)
    assert restarted.spent_24h() == pytest.approx(0.6)
    # Even after its confirmed debit ages out, unresolved access cannot be repurchased on another rail.
    monkeypatch.setattr(a.time, "time", lambda: now + 4 * 86400)
    assert restarted.spent_24h() == 0
    with pytest.raises(a.Aifp1QuoteError, match="unresolved"):
        restarted.reserve(0.6, binding(chain="bnb"))
    restarted.confirm(reservation, tx, purchase, complete=True)
    restarted.confirm(reservation, tx, purchase, complete=True)
    assert len(json.loads((tmp_path / "spend.json").read_text())["spend"]) == 1
    restarted.reserve(0.6, binding(chain="bnb"))


def test_reconciliation_view_cannot_authorize_a_new_payment(tmp_path):
    ledger = a.SpendLedger(None, None, str(tmp_path / "spend.json"))
    with pytest.raises(a.Aifp1QuoteError, match="owner spending limits"):
        ledger.reserve(0.1, binding())
    with pytest.raises(a.Aifp1QuoteError, match="owner spending limits"):
        ledger.check(0.1)


@pytest.mark.parametrize("failure", ["runtime", "journal", "revert"])
def test_proven_prebroadcast_or_reverted_payment_releases_only_gross_reservation(tmp_path, monkeypatch, failure):
    h = Harness(V14_DEPLOYMENTS["polygon"])
    h.ledger = a.SpendLedger(1, 1, str(tmp_path / "spend.json"))
    if failure == "runtime":
        monkeypatch.setattr(FakeChain, "get_code", lambda *_args: b"bad runtime")
    elif failure == "revert":
        original = FakeChain.wait_for_receipt
        monkeypatch.setattr(FakeChain, "wait_for_receipt", lambda self, tx: dict(original(self, tx), status=0))
    def journal(entry):
        if failure == "journal":
            raise OSError("journal cannot be made durable")
        h.journal.append(entry)
    with pytest.raises((s.V14SettlementError, OSError)):
        h.fetch(on_prepared=journal)
    assert h.ledger.spent_24h() == 0
    assert json.loads((tmp_path / "spend.json").read_text())["reservations"] == []
    assert len(h.chain.sent) == (1 if failure == "revert" else 0)


@pytest.mark.parametrize("unknown_broadcast", [True, False])
def test_high_level_recovery_keeps_budget_and_purchase_guard_then_commits_once(tmp_path, monkeypatch, unknown_broadcast):
    h = Harness(V14_DEPLOYMENTS["polygon"])
    h.ledger = a.SpendLedger(1, 1, str(tmp_path / "spend.json"))
    if unknown_broadcast:
        monkeypatch.setattr(FakeChain, "wait_for_receipt", lambda *_args: (_ for _ in ()).throw(TimeoutError()))
    else:
        h.server.pay_statuses = [500]
    def journal(entry):
        h.journal.append(entry)
        a._write_private_json(str(tmp_path / f"{entry['tx_ref']}.json"), entry)
    with pytest.raises(a.Aifp1PayError) as failure:
        h.fetch(on_prepared=journal)
    saved = copy.deepcopy(h.journal[0])
    path = str(tmp_path / f"{saved['tx_ref']}.json")
    assert a.SpendLedger(1, 1, str(tmp_path / "spend.json")).spent_24h() == pytest.approx(0.1)
    with pytest.raises(a.Aifp1QuoteError, match="unresolved"):
        h.fetch()
    assert len(h.chain.sent) == 1
    # Fake issuer stores one quote; recovery refers to its original persisted quote.
    h.server.last_quote = saved["quote"]
    agent = AiFinPayAgent.new()
    agent.evm_account = PAYER
    monkeypatch.setattr(a.requests, "Session", lambda: h.server)
    assert agent.recover_paid(path)["tx_ref"] == failure.value.tx_ref
    assert agent.recover_paid(path)["tx_ref"] == failure.value.tx_ref
    state = json.loads((tmp_path / "spend.json").read_text())
    assert len(state["spend"]) == 1 and not state["reservations"]
    assert len(h.chain.sent) == 1 and agent._aifp1_receipts["mrch_acme"]


@pytest.mark.parametrize("tamper", ["serialized_transaction", "payer", "chain", "quote_id", "asset", "gross"])
def test_recovery_rejects_budget_or_signed_hash_mismatch_before_receipt_authorization(tmp_path, monkeypatch, tamper):
    h = Harness(V14_DEPLOYMENTS["polygon"])
    h.ledger = a.SpendLedger(1, 1, str(tmp_path / "spend.json"))
    h.server.pay_statuses = [500]
    def journal(entry):
        h.journal.append(entry)
        a._write_private_json(str(tmp_path / f"{entry['tx_ref']}.json"), entry)
    with pytest.raises(a.Aifp1PayError):
        h.fetch(on_prepared=journal)
    saved = copy.deepcopy(h.journal[0])
    agent = AiFinPayAgent.new()
    agent.evm_account = PAYER
    if tamper == "serialized_transaction": saved[tamper] = "0x02"
    elif tamper == "payer": agent.evm_account = SIGNER
    elif tamper == "gross": saved["quote"]["settlement_call"]["args"]["quote"]["grossAmount"] = "123"
    elif tamper == "quote_id": saved["quote"]["quote_id"] = "qt_other"
    else: saved[tamper] = "bnb" if tamper == "chain" else "BNB"
    path = str(tmp_path / f"{saved['tx_ref']}.json")
    a._write_private_json(path, saved)
    monkeypatch.setattr(a, "submit_payment", lambda *_a, **_kw: pytest.fail("must refuse before wallet proof"))
    with pytest.raises(a.Aifp1QuoteError):
        agent.recover_paid(path)
    assert h.ledger.spent_24h() == pytest.approx(0.1)


def test_new_ledger_directories_are_private_and_parent_entries_fsynced(tmp_path, monkeypatch):
    nested = tmp_path / "new-agent" / "journal"
    synced = set()
    real_fsync = a.os.fsync
    def fsync(fd):
        stat_result = os.fstat(fd)
        if stat.S_ISDIR(stat_result.st_mode):
            synced.add((stat_result.st_dev, stat_result.st_ino))
        real_fsync(fd)
    monkeypatch.setattr(a.os, "fsync", fsync)
    h = Harness(V14_DEPLOYMENTS["polygon"])
    h.ledger = a.SpendLedger(1, 1, str(nested / "spend.json"))
    assert h.fetch().status_code == 200
    for directory in (tmp_path, nested.parent, nested):
        current = directory.stat()
        assert (current.st_dev, current.st_ino) in synced
        assert stat.S_IMODE(current.st_mode) == 0o700
    assert stat.S_IMODE((nested / "spend.json").stat().st_mode) == 0o600


def test_directory_fsync_failure_prevents_payment_signing(tmp_path, monkeypatch):
    h = Harness(V14_DEPLOYMENTS["polygon"])
    h.ledger = a.SpendLedger(1, 1, str(tmp_path / "new-agent" / "spend.json"))
    def failed_sync(_fd):
        raise OSError("directory durability unavailable")
    monkeypatch.setattr(a.os, "fsync", failed_sync)
    with pytest.raises(OSError, match="durability unavailable"):
        h.fetch()
    # A retry must not trust the directories left by the failed first attempt.
    with pytest.raises(OSError, match="durability unavailable"):
        h.fetch()
    assert h.chain is None and not h.journal
