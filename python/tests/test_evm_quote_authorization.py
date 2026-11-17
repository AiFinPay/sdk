"""EVM /v1/quote authorization against vectors generated and verified by the backend's own payment-auth.js."""

import json
import pathlib
from json import dumps, loads
import time

import pytest
import requests
from eth_account import Account
from eth_account.messages import encode_defunct
from test_aifp1 import API, Harness, Resp, Server, no_sleep, pinned  # noqa: F401
from test_settlement_v14 import PAYER

import aifinpay.aifp1 as a

V = json.loads((pathlib.Path(__file__).parent / "fixtures" / "evm-quote-authorization-backend.json").read_text())
KEY = Account.from_key(V["key"])


def backend_message(issuer, body, payer, nonce, expires_at):
    """Test-local mirror of the backend's evmQuoteMessageFor; pinned to the vectors below."""
    d = lambda k, default: default if body.get(k) is None else body[k]  # noqa: E731
    return json.dumps(
        ["AiFinPay EVM quote authorization v1", issuer, body.get("merchant_id"), body.get("resource"),
         d("tier", "standard"), body.get("requests"), body.get("units"), d("currency", "USD"), d("scope", "exact"),
         body.get("settlement_chain"), body.get("settlement_version"), body.get("asset"), d("force", False),
         payer, nonce, expires_at],
        separators=(",", ":"),
        ensure_ascii=False,
    )


@pytest.mark.parametrize("v", V["vectors"], ids=[v["name"] for v in V["vectors"]])
def test_backend_vectors(v):
    auth = {"payer": v["payer"], "nonce": v["nonce"], "expires_at": v["expires_at"]}
    assert a.evm_quote_authorization_message(v["body"], auth, v["issuer"]) == v["message"]
    assert backend_message(v["issuer"], v["body"], v["payer"], v["nonce"], v["expires_at"]) == v["message"]
    assert KEY.address == V["address"] and v["payer"] == V["address"].lower()
    assert Account.recover_message(encode_defunct(text=v["message"]), signature=v["signature"]) == V["address"]
    signature = KEY.sign_message(encode_defunct(text=v["message"])).signature.hex()
    assert (signature if signature.startswith("0x") else "0x" + signature) == v["signature"]


def test_an_explicit_null_takes_the_backend_default():
    body = {"merchant_id": "m", "tier": None, "currency": None, "scope": None, "force": None}
    msg = json.loads(a.evm_quote_authorization_message(body, {"payer": "0x", "nonce": "n", "expires_at": 1}, API))
    assert msg[4] == "standard" and msg[7] == "USD" and msg[8] == "exact" and msg[12] is False


class QuoteServer(Server):
    """Verifies every quote_authorization as the backend does, then answers from a script."""

    def __init__(self, dep, answers):
        super().__init__(dep)
        self.answers = list(answers)
        self.raw = []
        self.verified = []

    def post(self, url, json=None, headers=None, timeout=None, allow_redirects=True):
        if url != f"{API}/v1/quote":
            return super().post(url, json=json, headers=headers, timeout=timeout, allow_redirects=allow_redirects)
        self.raw.append(dumps(json, separators=(",", ":"), ensure_ascii=False))
        auth = json["quote_authorization"]
        now = int(time.time())
        message = backend_message(API, json, auth["payer"], auth["nonce"], auth["expires_at"])
        self.verified.append(
            auth["payer"] == json["payer"].lower()
            and len(auth["nonce"]) == 64
            and now < auth["expires_at"] <= now + 300
            and Account.recover_message(encode_defunct(text=message), signature=auth["signature"]).lower()
            == auth["payer"]
        )
        answer = self.answers.pop(0) if self.answers else "quote"
        if answer == "transport":
            raise requests.ConnectionError("connection reset")
        if answer == "garbage":
            r = Resp(200)
            r.text = "<html>bad gateway</html>"
            return r
        if answer == 503:
            return Resp(503, {"error": "AIFP-503-EVM", "reason": "evm_policy_state_unavailable"})
        if answer == 409:
            return Resp(409, {"error": "AIFP-409-EVM", "reason": "evm_quote_authorization_replayed"})
        if answer == 401:
            return Resp(401, {"error": "AIFP-401-QUOTE-PAYER"})
        if answer == 410:
            return Resp(410, {"error": "AIFP-410-EVM", "reason": "evm_quote_authorization_expired"})
        body = {k: v for k, v in json.items() if k != "quote_authorization"}
        return self.quote(body)

    def nonces(self):
        return [loads(r)["quote_authorization"]["nonce"] for r in self.raw]


def harness(dep, answers):
    h = Harness(dep)
    h.server = QuoteServer(dep, answers)
    return h


def test_a_purchase_sends_a_valid_quote_authorization(pinned):  # noqa: F811
    h = harness(pinned, [])
    assert h.fetch().status_code == 200
    assert h.server.verified == [True]
    sent = json.loads(h.server.raw[0])
    assert sent["payer"] == PAYER.address and sent["quote_authorization"]["payer"] == PAYER.address.lower()
    assert len(h.server.pays) == 1


@pytest.mark.parametrize("first", ["transport", 503, "garbage"])
def test_an_uncertain_answer_resends_the_same_body(pinned, first):  # noqa: F811
    h = harness(pinned, [first, "quote"])
    assert h.fetch().status_code == 200
    assert len(h.server.raw) == 2 and h.server.raw[1] == h.server.raw[0]
    assert h.server.verified == [True, True]
    assert len(h.server.pays) == 1


def test_an_expired_authorization_is_re_signed_once(pinned):  # noqa: F811
    h = harness(pinned, [410, "quote"])
    assert h.fetch().status_code == 200
    assert len(h.server.raw) == 2 and h.server.nonces()[0] != h.server.nonces()[1]
    assert h.server.verified == [True, True]


def test_a_second_expiry_stops_instead_of_looping(pinned):  # noqa: F811
    h = harness(pinned, [410, 410, "quote"])
    with pytest.raises(a.Aifp1QuoteError, match="410"):
        h.fetch()
    assert len(h.server.raw) == 2 and not h.server.pays


@pytest.mark.parametrize("status", [409, 401])
def test_a_refusal_is_not_retried(pinned, status):  # noqa: F811
    h = harness(pinned, [status, "quote"])
    with pytest.raises(a.Aifp1QuoteError, match=str(status)):
        h.fetch()
    assert len(h.server.raw) == 1 and not h.server.pays


def test_three_transport_failures_give_up_with_one_body(pinned):  # noqa: F811
    h = harness(pinned, ["transport"] * 3 + ["quote"])
    with pytest.raises(a.Aifp1QuoteError, match="connection reset"):
        h.fetch()
    assert len(h.server.raw) == 3 and len(set(h.server.raw)) == 1 and not h.server.pays
