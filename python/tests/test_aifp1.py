"""AIFP-1 purchase flow in Python: 402 → quote → v1.4 settlement → receipt.

The merchant, /v1 and the issuer are faked over a ``requests``-shaped session,
the chain is the fake client from ``test_settlement_v14`` with real EIP-712 and
transaction signing. What matters here is what is NOT paid: every refusal must
happen before anything is signed, a receipt is reused while it covers the
resource, and an uncertain outcome is surfaced for recovery, never paid twice.
"""

import base64
import hashlib
import json
import os
import stat
import time

import nacl.signing
import pytest
from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_defunct
from eth_utils import keccak
from test_settlement_v14 import MERCHANT, PAYER, USDC, FakeChain, signed_call

import aifinpay.aifp1 as a
import aifinpay.settlement_v14 as s
from aifinpay._v14_deployments import V14_DEPLOYMENTS

SHOP = "https://shop.example"
API = "https://api.aifinpay.io"
RPC = "https://polygon-rpc.example"
ISSUER_KEY = nacl.signing.SigningKey(b"\x07" * 32)
POL_USD = 0.25
AMOUNT = "0.1"
NATIVE_GROSS = 400_000_000_000_000_000  # $0.10 at $0.25/POL
STABLE_GROSS = 100_000  # $0.10 in USDC micro-units


@pytest.fixture(autouse=True)
def pinned(monkeypatch):
    dep = V14_DEPLOYMENTS["polygon"]
    pinned = dict(dep, runtimeCodeHash="0x" + keccak(b"\x60\x01").hex(),
                  splitter=dict(dep["splitter"], signer=Account.from_key("0x" + "01" * 32).address))
    monkeypatch.setitem(s.V14_DEPLOYMENTS, "polygon", pinned)
    return pinned


@pytest.fixture(autouse=True)
def no_sleep(monkeypatch):
    monkeypatch.setattr(a.time, "sleep", lambda _s: None)


def b64url(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).rstrip(b"=").decode()


def iso(unix: int) -> str:
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(unix))


class Resp:
    def __init__(self, status, body=None):
        self.status_code = status
        self.ok = 200 <= status < 300
        self._body = body
        self.text = json.dumps(body) if body is not None else ""

    def json(self):
        if self._body is None:
            raise ValueError("no json")
        return self._body


class Server:
    """Merchant gate + /v1/quote + /v1/pay + JWKS + price sources, mirroring the real decisions."""

    def __init__(self, dep):
        self.dep = dep
        self.quotes = 0
        self.pays = []
        self.pay_statuses = []  # answered, in order, before a /v1/pay succeeds
        self.receipt_ids = set()
        self.claims_override = {}
        self.paid_override = {}
        self.sign_with = ISSUER_KEY
        self.quote_mutator = None
        self.chainlink_age_s = 60
        self.prices_down = False
        self.merchant_hits = []
        self.call = None
        self.last_quote = None

    def get(self, url, headers=None, timeout=None, allow_redirects=True):
        headers = headers or {}
        if url == f"{API}/.well-known/jwks.json":
            x = b64url(bytes(ISSUER_KEY.verify_key))
            return Resp(200, {"keys": [{"kty": "OKP", "crv": "Ed25519", "x": x, "kid": "k1", "alg": "EdDSA"}]})
        if url.startswith("https://api.coinbase.com/"):
            if self.prices_down:
                return Resp(500, {})
            return Resp(200, {"data": {"base": "POL", "currency": "USD", "amount": str(POL_USD)}})
        if url.startswith("https://api.coingecko.com/"):
            return Resp(500, {})
        if url.startswith(SHOP):
            receipt = headers.get("AIFP-Receipt")
            self.merchant_hits.append(receipt)
            if url == f"{SHOP}/plain":
                return Resp(402, {"x402Version": 1, "accepts": []})
            path = url[len(SHOP):]
            if receipt:
                claims = json.loads(base64.urlsafe_b64decode(receipt.split(".")[1] + "=="))
                if (claims["receipt_id"] in self.receipt_ids and claims["aud"] == "mrch_acme"
                        and a.scope_covers(claims["scope"], claims["resource"], path)):
                    return Resp(200, {"data": "paid content", "path": path})
            return Resp(402, {"protocol": "AIFP-1", "merchant_id": "mrch_acme", "resource": path,
                              "base_unit_price_usd": "0.0005"})
        raise AssertionError(f"unexpected GET {url}")

    def post(self, url, json=None, headers=None, timeout=None, allow_redirects=True):
        if url == RPC:
            now = int(time.time())
            answer = abi_encode(["uint80", "int256", "uint256", "uint256", "uint80"],
                                [1, int(POL_USD * 1e8), now, now - self.chainlink_age_s, 1])
            return Resp(200, {"jsonrpc": "2.0", "id": 1, "result": "0x" + answer.hex()})
        if url == f"{API}/v1/quote":
            return self.quote(json)
        if url == f"{API}/v1/pay":
            return self.pay(json, headers or {})
        raise AssertionError(f"unexpected POST {url}")

    def quote(self, body):
        self.quotes += 1
        stable = body.get("asset") not in (None, "POL")
        assert body["payer"] == PAYER.address and body["units"] == 200
        order = f"qt_{self.quotes:016d}"
        gross = STABLE_GROSS if stable else NATIVE_GROSS
        self.call = signed_call(self.dep, token=USDC if stable else s.ZERO, gross=gross, order=order)
        valid_until = int(self.call["args"]["quote"]["validUntil"])
        quote = {
            "quote_id": order, "nonce": "n-" + order, "payer": body["payer"], "merchant_id": body["merchant_id"],
            "resource": "*" if body["scope"] == "merchant" else body["resource"], "scope": body["scope"],
            "unit_quota": 200, "amount": AMOUNT,
            "currency": "USD", "network_mode": "live", "expires_at": iso(valid_until),
            "accepted_chains": ["polygon"], "pay_to": {"polygon": MERCHANT}, "settlement_call": self.call,
            "payment_authorization": {"scheme": "wallet-signature-v1", "domain": API},
        }
        if stable:
            quote["accepted_assets"] = ["USDC"]
            quote["settlement"] = {"total_units": str(gross)}
        else:
            quote["accepted_assets"] = ["POL"]
            quote["native_settlement"] = {
                "asset": "POL", "decimals": 18, "total_wei": str(gross), "settlement_semantics": "gross-inclusive",
                "creator_wei": "0", "treasury_wei": str(gross // 100), "merchant_wei": str(gross - gross // 100),
            }
        if self.quote_mutator:
            self.quote_mutator(quote)
        self.last_quote = quote
        return Resp(200, quote)

    def pay(self, body, headers):
        quote = self.last_quote
        auth = body["payment_authorization"]
        # The server's own derivation, written out independently of the SDK.
        idem = "aifp1-" + hashlib.sha256(
            f"aifp1|{body['quote_id']}|{body['asset']}|{body['chain']}|{body['tx_ref']}".encode()
        ).hexdigest()
        assert headers["Idempotency-Key"] == idem
        message = json.dumps(
            ["AiFinPay receipt authorization v1", API, quote["quote_id"], quote["nonce"], quote["merchant_id"], "live",
             body["chain"], body["tx_ref"], body["asset"], idem, auth["payer"], auth["expires_at"]],
            separators=(",", ":"),
        )
        signer = Account.recover_message(encode_defunct(text=message), signature=auth["signature"])
        assert signer == PAYER.address and auth["payer"] == PAYER.address.lower()
        self.pays.append({"idem": idem, "tx_ref": body["tx_ref"]})
        if self.pay_statuses:
            return Resp(self.pay_statuses.pop(0), {"error": "AIFP-425"})
        now = int(time.time())
        receipt_id = "rcpt_" + body["tx_ref"][2:10]
        claims = {
            "iss": API, "aud": quote["merchant_id"], "sub": auth["payer"], "tx_ref": body["tx_ref"],
            "scope": quote["scope"], "resource": quote["resource"], "chain": "polygon", "asset": body["asset"],
            "currency": "USD", "network_mode": "live", "amount": AMOUNT, "unit_quota": quote["unit_quota"],
            "iat": now, "exp": now + 3600, "receipt_id": receipt_id,
        }
        claims.update(self.claims_override)
        head = b64url(json.dumps({"alg": "EdDSA", "typ": "JWT", "kid": "k1"}).encode())
        payload = b64url(json.dumps(claims).encode())
        sig = b64url(self.sign_with.sign(f"{head}.{payload}".encode()).signature)
        self.receipt_ids.add(receipt_id)
        return Resp(200, {
            "receipt": f"{head}.{payload}.{sig}", "receipt_id": receipt_id, "merchant_id": quote["merchant_id"],
            "tx_ref": body["tx_ref"], "scope": quote["scope"], "resource": quote["resource"],
            "unit_quota": quote["unit_quota"], "chain": "polygon", "asset": body["asset"], "currency": "USD",
            "amount": AMOUNT, "expires_at": iso(now + 3600), **self.paid_override,
        })


class Harness:
    def __init__(self, dep, asset="POL", per_payment=1.0, daily=5.0):
        self.server = Server(dep)
        self.asset = asset
        self.journal = []
        self.receipts = {}
        self.ledger = a.SpendLedger(per_payment, daily)
        self.chain = None

    def fetch(self, url=f"{SHOP}/data", **over):
        harness = self

        class LazyChain:
            """Built on first use, once the quote (and its signed call) exists."""

            def __getattr__(self, name):
                if harness.chain is None:
                    harness.chain = FakeChain(harness.server.dep, harness.server.call)
                    harness.chain.native_balance = 10**19
                if harness.chain.call_obj is not harness.server.call:  # a later purchase
                    harness.chain.call_obj = harness.server.call
                    harness.chain.event_token = harness.server.call["args"]["quote"]["token"]
                return getattr(harness.chain, name)

        kw = dict(
            session=self.server, account=PAYER, client=LazyChain(), polygon_rpc=RPC, allowed_origins=[SHOP],
            ledger=self.ledger, max_gas_wei=10_000_000, on_prepared=self.journal.append, receipts=self.receipts,
            asset=self.asset,
        )
        kw.update(over)
        return a.aifp1_fetch(url, **kw)


def assert_nothing_paid(h):
    assert h.chain is None or not h.chain.sent
    assert not h.journal and not h.server.pays and h.ledger.spent_24h() == 0


# ── Wire formats ────────────────────────────────────────────────────────────


def test_idempotency_key_format():
    assert a.idempotency_key_for("qt_1", "polygon", "USDC", "0xabc") == (
        "aifp1-" + hashlib.sha256(b"aifp1|qt_1|USDC|polygon|0xabc").hexdigest()
    )


def test_authorization_message_is_a_compact_json_array():
    quote = {"quote_id": "qt_1", "nonce": "n1", "merchant_id": "mrch_é"}
    msg = a.payment_authorization_message(quote, API, "polygon", "0xabc", "POL", "aifp1-x", "0xpayer", 123)
    assert msg == ('["AiFinPay receipt authorization v1","https://api.aifinpay.io","qt_1","n1","mrch_é","live",'
                   '"polygon","0xabc","POL","aifp1-x","0xpayer",123]')


def test_default_units_buy_a_ten_cent_batch():
    assert a.default_units_for({"base_unit_price_usd": "0.0005"}) == 200
    assert a.default_units_for({"base_unit_price_usd": "0.03"}) == 4
    assert a.default_units_for({}) == a.FALLBACK_UNITS


# ── Happy paths ─────────────────────────────────────────────────────────────


def test_pol_purchase_settles_once_and_returns_the_paid_content(pinned):
    h = Harness(pinned)
    r = h.fetch()
    assert r.status_code == 200 and r.json()["data"] == "paid content"
    assert len(h.chain.sent) == 1 and len(h.journal) == 1
    assert h.journal[0]["serialized_transaction"] and h.journal[0]["tx_ref"] == h.server.pays[0]["tx_ref"]
    assert len(h.server.pays) == 1
    assert h.ledger.spent_24h() == pytest.approx(0.1)


def test_a_cached_receipt_is_reused_without_a_new_quote(pinned):
    h = Harness(pinned)
    h.fetch()
    assert h.fetch().status_code == 200
    assert h.server.quotes == 1 and len(h.chain.sent) == 1


def test_a_prefix_batch_covers_the_section_and_only_the_section(pinned):
    h = Harness(pinned)
    assert h.fetch(f"{SHOP}/articles/1").status_code == 200
    assert h.server.last_quote["scope"] == "prefix" and h.server.last_quote["resource"] == "/articles/"
    assert h.fetch(f"{SHOP}/articles/2").status_code == 200
    assert h.server.quotes == 1, "the second article rides on the first batch"
    assert h.fetch(f"{SHOP}/news/1").status_code == 200
    assert h.server.quotes == 2 and len(h.chain.sent) == 2


def test_exact_scope_buys_only_the_challenged_path(pinned):
    h = Harness(pinned)
    h.fetch(f"{SHOP}/articles/1", scope="exact")
    assert h.server.last_quote["resource"] == "/articles/1"
    h.fetch(f"{SHOP}/articles/2", scope="exact")
    assert h.server.quotes == 2


def test_merchant_scope_quotes_the_whole_merchant(pinned):
    h = Harness(pinned)
    h.fetch(f"{SHOP}/a/b", scope="merchant")
    h.fetch(f"{SHOP}/c/d", scope="merchant")
    assert h.server.last_quote["resource"] == "*" and h.server.quotes == 1


def test_scope_helpers_match_the_server():
    assert a.prefix_hint("/articles/2026/x") == "/articles/" and a.prefix_hint("/data") == "/"
    assert a.scope_covers("prefix", "/articles/", "/articles/9")
    assert not a.scope_covers("prefix", "/articles", "/articles-internal")
    assert a.scope_covers("exact", "/movies/*", "/movies/11/x") and not a.scope_covers("exact", "/a", "/b")
    assert a.scope_covers("merchant", "*", "/anything")


def test_usdc_purchase_approves_the_gross_and_settles(pinned):
    h = Harness(pinned, asset="USDC")
    assert h.fetch().status_code == 200
    assert len(h.chain.sent) == 2, "approval + settlement"
    assert len(h.journal) == 1, "only the settlement is journaled"
    assert h.ledger.spent_24h() == pytest.approx(0.1)


def test_a_non_aifp1_402_is_returned_untouched(pinned):
    h = Harness(pinned)
    assert h.fetch(f"{SHOP}/plain").status_code == 402
    assert h.server.quotes == 0


# ── Refusals before anything is signed ──────────────────────────────────────


def test_an_unlisted_origin_is_never_contacted(pinned):
    h = Harness(pinned)
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch(allowed_origins=["https://other.example"])
    assert not h.server.merchant_hits
    assert_nothing_paid(h)


def test_plain_http_is_refused(pinned):
    h = Harness(pinned)
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch("http://shop.example/data", allowed_origins=["http://shop.example"])
    assert_nothing_paid(h)


QUOTE_TAMPERING = [
    ("other merchant id", lambda q: q.update(merchant_id="mrch_other")),
    ("other resource", lambda q: q.update(resource="/other/")),
    ("wider scope than asked", lambda q: q.update(scope="merchant", resource="*")),
    ("same resource, other scope", lambda q: q.update(scope="exact")),
    ("other payer", lambda q: q.update(payer="0x" + "55" * 20)),
    ("test network", lambda q: q.update(network_mode="test")),
    ("non-USD", lambda q: q.update(currency="EUR")),
    ("pay_to differs from the signed merchant", lambda q: q.update(pay_to={"polygon": "0x" + "44" * 20})),
    ("expiry differs from the signed validUntil", lambda q: q.update(expires_at=iso(int(time.time()) + 900))),
    ("treasury is not 1%", lambda q: q["native_settlement"].update(treasury_wei="1")),
    ("wei debit disagrees with the signed gross",
     lambda q: q["native_settlement"].update(total_wei=str(NATIVE_GROSS * 2))),
    ("dollar amount understated vs the POL debit", lambda q: q.update(amount="0.05")),
    ("legacy splitter", lambda q: q["settlement_call"].update(splitter_version="1.3")),
]


@pytest.mark.parametrize("name,mutate", QUOTE_TAMPERING, ids=[t[0] for t in QUOTE_TAMPERING])
def test_a_pol_quote_that_disagrees_is_refused(pinned, name, mutate):
    h = Harness(pinned)
    h.server.quote_mutator = mutate
    with pytest.raises((a.Aifp1QuoteError, s.V14SettlementError)):
        h.fetch()
    assert_nothing_paid(h)


STABLE_TAMPERING = [
    ("approval above gross", lambda q: q["settlement_call"]["approval"].update(amount="100000000")),
    ("dollars differ from units", lambda q: q.update(amount="0.2")),
    ("several assets offered", lambda q: q.update(accepted_assets=["USDC", "POL"])),
    ("native debit alongside", lambda q: q.update(native_settlement={"asset": "POL"})),
]


@pytest.mark.parametrize("name,mutate", STABLE_TAMPERING, ids=[t[0] for t in STABLE_TAMPERING])
def test_a_stable_quote_that_disagrees_is_refused(pinned, name, mutate):
    h = Harness(pinned, asset="USDC")
    h.server.quote_mutator = mutate
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch()
    assert_nothing_paid(h)


def test_an_unpinned_asset_is_refused_before_quoting(pinned):
    h = Harness(pinned, asset="DAI")
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch()
    assert h.server.quotes == 0
    assert_nothing_paid(h)


def test_the_per_payment_limit_is_checked_before_signing(pinned):
    h = Harness(pinned, per_payment=0.05)
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch()
    assert_nothing_paid(h)


def test_the_daily_limit_is_checked_before_signing(pinned):
    h = Harness(pinned, daily=0.15)
    h.ledger.record(0.1)
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch()
    assert h.chain is None and not h.server.pays


def test_no_independent_price_means_no_pol_payment(pinned):
    h = Harness(pinned)
    h.server.chainlink_age_s = 7200
    h.server.prices_down = True
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch()
    assert_nothing_paid(h)


def test_a_stale_chainlink_answer_falls_back_to_coinbase(pinned):
    server = Server(pinned)
    server.chainlink_age_s = 7200
    assert a.independent_pol_usd(server, RPC) == (POL_USD, "coinbase")


def test_a_fresh_chainlink_answer_is_used_first(pinned):
    assert a.independent_pol_usd(Server(pinned), RPC) == (POL_USD, "chainlink-polygon")


# ── After money moved ───────────────────────────────────────────────────────


def test_pay_retries_while_unconfirmed_with_one_idempotency_key(pinned):
    h = Harness(pinned)
    h.server.pay_statuses = [425, 503]
    assert h.fetch().status_code == 200
    assert len(h.server.pays) == 3 and len({p["idem"] for p in h.server.pays}) == 1
    assert len(h.chain.sent) == 1


def test_a_pay_failure_surfaces_recovery_and_is_counted_as_spent(pinned):
    h = Harness(pinned)
    h.server.pay_statuses = [500]
    with pytest.raises(a.Aifp1PayError) as e:
        h.fetch()
    assert e.value.tx_ref == h.journal[0]["tx_ref"]
    assert e.value.recovery["quote"]["quote_id"] == e.value.quote_id
    assert len(h.chain.sent) == 1 and h.ledger.spent_24h() == pytest.approx(0.1)
    assert not any(h.receipts.values())


def test_recovery_resubmits_the_same_payment_without_paying_again(pinned):
    h = Harness(pinned)
    h.server.pay_statuses = [500]
    with pytest.raises(a.Aifp1PayError) as e:
        h.fetch()
    paid = a.submit_payment(h.server, PAYER, e.value.recovery)
    assert paid["tx_ref"] == e.value.tx_ref and len(h.chain.sent) == 1
    assert len({p["idem"] for p in h.server.pays}) == 1


RECEIPT_TAMPERING = [
    ("other audience", {"aud": "mrch_other"}),
    ("other payer", {"sub": "0x" + "55" * 20}),
    ("other transaction", {"tx_ref": "0x" + "ab" * 32}),
    ("other issuer", {"iss": "https://evil.example"}),
    ("other resource", {"resource": "/other"}),
    ("other asset", {"asset": "USDC"}),
    ("other amount", {"amount": "0.2"}),
    ("expired", {"exp": 1}),
]


@pytest.mark.parametrize("name,claims", RECEIPT_TAMPERING, ids=[t[0] for t in RECEIPT_TAMPERING])
def test_a_receipt_not_bound_to_this_purchase_is_rejected(pinned, name, claims):
    h = Harness(pinned)
    h.server.claims_override = claims
    with pytest.raises(a.Aifp1PayError):
        h.fetch()
    assert not any(h.receipts.values()) and len(h.chain.sent) == 1


def test_a_receipt_consistently_issued_for_another_merchant_is_rejected(pinned):
    h = Harness(pinned)
    h.server.claims_override = {"aud": "mrch_other"}
    h.server.paid_override = {"merchant_id": "mrch_other"}
    with pytest.raises(a.Aifp1PayError):
        h.fetch()
    assert not any(h.receipts.values())


def test_a_receipt_signed_by_an_unknown_key_is_rejected(pinned):
    h = Harness(pinned)
    h.server.sign_with = nacl.signing.SigningKey(b"\x09" * 32)
    with pytest.raises(a.Aifp1PayError):
        h.fetch()
    assert not any(h.receipts.values())


# ── Ledger ──────────────────────────────────────────────────────────────────


def test_the_ledger_persists_owner_only_and_survives_a_restart(tmp_path):
    path = str(tmp_path / "spend.json")
    a.SpendLedger(1.0, 1.0, path).record(0.7)
    assert stat.S_IMODE(os.stat(path).st_mode) == 0o600
    with pytest.raises(a.Aifp1QuoteError):
        a.SpendLedger(1.0, 1.0, path).check(0.4)
