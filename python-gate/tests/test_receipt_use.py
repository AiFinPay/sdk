"""Receipt use sent to /receipt-use: offline, bodies held to the shared vectors."""
import json
import pathlib
import time
from urllib.error import HTTPError, URLError

import pytest
from aifinpay_gate import Gate, GateReporter, MemoryStore

from test_gate import KEY, NOW, jwk, req, token

VECTORS = json.loads((pathlib.Path(__file__).resolve().parents[2] / "conformance" / "vectors"
                      / "receipt-use-v1.json").read_text("utf-8"))
MERCHANT = "mrch_0123456789abcdef"
USE_URL = f"https://api.aifinpay.io/v1/merchants/{MERCHANT}/receipt-use"
RECEIPT = "rcpt_00000000000000c4"


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
    """Answers events as accepted; /receipt-use by `use`, a status or an exception."""

    def __init__(self, use=200):
        self.use = use
        self.calls = []

    def open(self, request, timeout):
        self.calls.append(request)
        data = json.loads(request.data)
        if request.full_url != USE_URL:
            return Response(body=json.dumps({"accepted": len(data["events"]), "duplicates": 0}).encode())
        if isinstance(self.use, Exception):
            raise self.use
        if self.use != 200:
            raise HTTPError(request.full_url, self.use, "refused", {}, None)
        return Response(body=json.dumps({"applied": len(data["uses"]), "ignored": 0}).encode())

    def uses(self):
        return [r for r in self.calls if r.full_url == USE_URL]


@pytest.fixture
def reporter():
    instance = GateReporter(merchant_id=MERCHANT, merchant_secret="test-secret")
    instance._opener = Opener()
    yield instance
    instance.close(timeout=2)


def paid_gate(reporter, unit_quota=40):
    gate = Gate(MERCHANT, resource="/paid", store=MemoryStore(), jwks={"keys": [jwk(KEY)]},
                now=lambda: NOW, on_event=reporter.on_event)
    receipt = token(aud=MERCHANT, unit_quota=unit_quota, receipt_id=RECEIPT)
    return receipt, lambda: gate.decide(req(receipt))


def spend(reporter, receipt_id, remaining):
    reporter.on_event({"kind": "serve", "resource": "/api", "weight": 1,
                       "receipt_id": receipt_id, "remaining": remaining})


def test_a_paid_spend_holds_one_use_and_flush_sends_the_exact_body_with_auth(reporter):
    receipt, call = paid_gate(reporter)
    assert call().status == 200
    assert reporter.stats["uses"]["queued"] == 1
    reporter.flush(timeout=2)
    [sent] = reporter._opener.uses()
    assert sent.get_method() == "POST"
    assert sent.get_header("Aifp-merchant-secret") == "test-secret"
    assert sent.data == f'{{"uses":[{{"receipt_id":"{RECEIPT}","remaining":39}}]}}'.encode()
    assert receipt.encode() not in sent.data
    assert reporter.stats["uses"] == {"queued": 0, "delivered": 1, "dropped": 0, "last_error": None}


def test_two_spends_of_one_receipt_send_one_item_with_the_lowest_remaining(reporter):
    _receipt, call = paid_gate(reporter)
    call()
    call()
    spend(reporter, RECEIPT, 39)
    assert reporter.stats["uses"]["queued"] == 1
    reporter.flush(timeout=2)
    assert [r.data for r in reporter._opener.uses()] == [
        f'{{"uses":[{{"receipt_id":"{RECEIPT}","remaining":38}}]}}'.encode()]


@pytest.mark.parametrize("vector", VECTORS["vectors"], ids=[v["name"] for v in VECTORS["vectors"]])
def test_vector_bodies_byte_for_byte(reporter, vector):
    for item in vector["spends"]:
        spend(reporter, item["receipt_id"], item["remaining"])
    reporter.flush(timeout=5)
    sent = reporter._opener.uses()
    assert [r.data.decode() for r in sent] == vector["bodies"]
    path = VECTORS["path"].replace("{merchant_id}", MERCHANT)
    assert all(r.full_url == "https://api.aifinpay.io" + path for r in sent)
    assert all(r.get_header(VECTORS["auth_header"].capitalize()) == "test-secret" for r in sent)


def test_404_drops_what_is_held_without_raising_and_leaves_pages_and_events_alone(reporter):
    reporter._opener.use = 404
    _receipt, call = paid_gate(reporter)
    assert call().status == 200
    reporter.on_event({"kind": "402", "resource": "/api", "weight": 1})
    result = reporter.flush(timeout=2)
    assert result["uses"] == {"queued": 0, "delivered": 0, "dropped": 1, "last_error": "rejected"}
    assert result["stopped"] is False and result["delivered"] == 2 and result["last_error"] is None
    assert len(reporter._opener.uses()) == 1
    time.sleep(0.3)  # no retry loop
    assert len(reporter._opener.uses()) == 1
    again = call()
    assert again.status == 200 and again.aifp["remaining"] == 38
    reporter.flush(timeout=2)
    assert len(reporter._opener.uses()) == 2


def test_a_failed_send_is_caught_and_the_use_kept_for_bounded_retries(reporter):
    reporter._opener.use = URLError(ConnectionRefusedError("refused"))
    _receipt, call = paid_gate(reporter)
    assert call().status == 200
    assert reporter.flush(timeout=2)["uses"]["queued"] == 1
    assert reporter.stats["uses"]["last_error"] == "network"
    assert call().status == 200
    for _ in range(6):
        reporter.flush(timeout=2)
    assert reporter.stats["uses"] == {"queued": 0, "delivered": 0, "dropped": 1, "last_error": "retry_exhausted"}
    assert len(reporter._opener.uses()) == 5


def test_5xx_keeps_the_use_and_the_scheduled_retry_delivers_it(reporter):
    reporter.DELAY = 0.01
    reporter._opener.use = 503
    spend(reporter, RECEIPT, 7)
    deadline = time.monotonic() + 2
    while not reporter._opener.uses() and time.monotonic() < deadline:
        time.sleep(0.01)
    reporter._opener.use = 200
    while reporter.stats["uses"]["delivered"] == 0 and time.monotonic() < deadline:
        time.sleep(0.01)
    assert reporter.stats["uses"] == {"queued": 0, "delivered": 1, "dropped": 0, "last_error": None}
    assert len(reporter._opener.uses()) == 2


def test_no_merchant_secret_no_reporter_a_spend_sends_nothing():
    with pytest.raises(ValueError):
        GateReporter(merchant_id=MERCHANT, merchant_secret="")
    gate = Gate(MERCHANT, resource="/paid", store=MemoryStore(), jwks={"keys": [jwk(KEY)]}, now=lambda: NOW)
    assert gate.decide(req(token(aud=MERCHANT, unit_quota=3, receipt_id=RECEIPT))).status == 200


def test_shadow_exempt_and_token_shaped_ids_record_nothing(reporter):
    receipt = token(aud=MERCHANT, unit_quota=3, receipt_id=RECEIPT)
    shadow = Gate(MERCHANT, resource="/paid", store=MemoryStore(), jwks={"keys": [jwk(KEY)]},
                  now=lambda: NOW, mode="shadow", on_event=reporter.on_event)
    assert shadow.decide(req(receipt)).status == 200
    reporter.on_event({"kind": "serve", "resource": "/api", "weight": 1, "exempt": True})
    spend(reporter, receipt, 2)
    assert reporter.stats["uses"]["queued"] == 0


def test_close_drops_what_it_could_not_send_and_later_spends(reporter):
    reporter._opener.use = 503
    spend(reporter, RECEIPT, 3)
    reporter.close(timeout=2)
    spend(reporter, RECEIPT, 2)
    assert reporter.stats["uses"] == {"queued": 0, "delivered": 0, "dropped": 2, "last_error": "shutdown"}
