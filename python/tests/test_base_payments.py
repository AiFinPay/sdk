"""Base AIFP-1: real local signing, independent chain/asset selection, no live RPC.

The HTTP and chain fixtures exercise the same flow as Polygon while asserting
Base's ETH price, USDC address, chain ID, receipt and additional fee components.
"""

import copy
import time

import pytest
from eth_abi import decode as abi_decode
from eth_utils import keccak
from test_aifp1 import AMOUNT, NATIVE_GROSS, RPC, SHOP, Harness, Resp, Server, assert_nothing_paid
from test_settlement_v14 import (
    CODE,
    MERCHANT,
    PAYER,
    REFUSALS,
    SIGNER,
    FakeChain,
    context,
    decode_tx,
    signed_call,
)

import aifinpay.aifp1 as a
import aifinpay.settlement_v14 as s
from aifinpay._v14_deployments import V14_DEPLOYMENTS


@pytest.fixture
def base(monkeypatch):
    dep = V14_DEPLOYMENTS["base"]
    pinned = dict(dep, runtimeCodeHash="0x" + keccak(CODE).hex(),
                  splitter=dict(dep["splitter"], signer=SIGNER.address))
    monkeypatch.setitem(s.V14_DEPLOYMENTS, "base", pinned)
    return pinned


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def unexpected(*_args, **_kwargs):
        raise AssertionError("unit tests must not contact a real network")

    monkeypatch.setattr(a.requests.Session, "request", unexpected)


@pytest.mark.parametrize("asset,transactions", [("ETH", 1), ("USDC", 2)])
def test_base_purchase_and_receipt_reuse(base, asset, transactions):
    h = Harness(base, asset=asset)
    assert h.fetch(f"{SHOP}/articles/1", chain="base").status_code == 200
    assert len(h.chain.sent) == transactions
    assert all(decode_tx(raw)["chainId"] == 8453 for raw in h.chain.sent)
    assert h.journal[0]["chain"] == "base" and h.journal[0]["asset"] == asset
    assert h.server.pays[0]["chain"] == "base" and h.server.pays[0]["asset"] == asset
    assert h.ledger.spent_24h() == pytest.approx(float(AMOUNT))
    if asset == "ETH":
        assert decode_tx(h.chain.sent[0])["value"] == 40_000_000_000_000  # $0.10 at $2500/ETH
    else:
        token = next(t["address"] for t in base["splitter"]["assets"] if t["symbol"] == "USDC")
        approval = decode_tx(h.chain.sent[0])
        assert "0x" + approval["to"].hex() == token.lower()
        spender, amount = abi_decode(["address", "uint256"], approval["data"][4:])
        assert spender.lower() == base["splitter"]["address"].lower() and amount == 100_000
        assert decode_tx(h.chain.sent[1])["value"] == 0
    assert h.fetch(f"{SHOP}/articles/2", chain="base").status_code == 200
    assert h.server.quotes == 1 and len(h.chain.sent) == transactions


def test_native_asset_defaults_to_eth_only_when_base_is_explicit(base):
    h = Harness(base, asset=None)
    assert h.fetch(chain="base").status_code == 200
    assert h.server.last_quote["accepted_assets"] == ["ETH"]
    assert h.journal[0]["asset"] == "ETH"


def test_server_cannot_choose_base_for_a_default_polygon_purchase(base):
    h = Harness(base, asset="USDC")
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch()
    assert_nothing_paid(h)


@pytest.mark.parametrize("chain,asset", [("base", "POL"), ("base", "USDT"), ("ethereum", "ETH"), ("amoy", "POL")])
def test_other_chains_or_assets_are_refused_before_contacting_merchant(base, chain, asset):
    h = Harness(base, asset=asset)
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch(chain=chain)
    assert h.server.quotes == 0 and not h.server.merchant_hits
    assert_nothing_paid(h)


BASE_QUOTE_TAMPERING = [
    ("call chain", lambda q: q["settlement_call"].update(chain="polygon")),
    ("accepted chain", lambda q: q.update(accepted_chains=["polygon"])),
    ("ambiguous chains", lambda q: q.update(accepted_chains=["base", "polygon"])),
    ("native label", lambda q: q["native_settlement"].update(asset="POL")),
    ("call asset", lambda q: q["settlement_call"].update(asset="POL")),
    ("accepted asset", lambda q: q.update(accepted_assets=["POL"])),
    ("payout", lambda q: q.update(pay_to={"evm": "0x" + "44" * 20})),
    ("conflicting payout", lambda q: q["pay_to"].update(base="0x" + "44" * 20)),
    ("polygon alias only", lambda q: q.update(pay_to={"polygon": MERCHANT})),
    ("authorization domain", lambda q: q["payment_authorization"].update(domain="https://evil.example")),
]


@pytest.mark.parametrize("name,mutate", BASE_QUOTE_TAMPERING, ids=[t[0] for t in BASE_QUOTE_TAMPERING])
def test_base_native_quote_is_bound_to_the_caller_selection(base, name, mutate):
    h = Harness(base, asset="ETH")
    h.server.quote_mutator = mutate
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch(chain="base")
    assert_nothing_paid(h)


def test_base_native_quote_cannot_use_the_pol_dollar_rate(base):
    h = Harness(base, asset="ETH")

    def mispriced(q):
        q["settlement_call"] = signed_call(base, gross=NATIVE_GROSS, order=q["quote_id"])
        q["native_settlement"].update(total_wei=str(NATIVE_GROSS), treasury_wei=str(NATIVE_GROSS // 100),
                                      merchant_wei=str(NATIVE_GROSS - NATIVE_GROSS // 100))

    h.server.quote_mutator = mispriced
    with pytest.raises(a.Aifp1QuoteError, match="independent USD price"):
        h.fetch(chain="base")
    assert_nothing_paid(h)


def test_base_usdc_cannot_be_substituted_with_polygon_usdc(base):
    h = Harness(base, asset="USDC")
    polygon_usdc = V14_DEPLOYMENTS["polygon"]["splitter"]["usdc"]

    def wrong_token(q):
        q["settlement_call"]["args"]["quote"]["token"] = polygon_usdc
        q["settlement_call"]["approval"]["token"] = polygon_usdc

    h.server.quote_mutator = wrong_token
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch(chain="base")
    assert_nothing_paid(h)


def test_base_independent_price_never_uses_pol_or_polygon_chainlink(base):
    server = Server(base)
    calls = []
    original_get = server.get

    def get(url, **kwargs):
        calls.append(url)
        return original_get(url, **kwargs)

    server.get = get
    assert a.independent_native_usd(server, RPC, "base") == (2500, "coinbase")
    assert calls == ["https://api.coinbase.com/v2/prices/ETH-USD/spot"]
    server.native_asset = "POL"
    with pytest.raises(a.Aifp1QuoteError, match="ETH/USD"):
        a.independent_native_usd(server, RPC, "base")


def test_base_independent_eth_price_can_fall_back_but_rejects_stale_or_future_data(base):
    server = Server(base)
    timestamp = int(time.time())

    def get(url, **_kwargs):
        if "coinbase" in url:
            return Resp(503, {})
        assert "ids=ethereum&" in url
        return Resp(200, {"ethereum": {"usd": 2500, "last_updated_at": timestamp}})

    server.get = get
    assert a.independent_native_usd(server, RPC, "base") == (2500, "coingecko")
    for offset in (-7200, 7200):
        timestamp = int(time.time()) + offset
        with pytest.raises(a.Aifp1QuoteError, match="ETH/USD"):
            a.independent_native_usd(server, RPC, "base")


def test_missing_independent_eth_price_does_not_pay(base):
    h = Harness(base, asset="ETH")
    h.server.prices_down = True
    with pytest.raises(a.Aifp1QuoteError, match="ETH/USD"):
        h.fetch(chain="base")
    assert_nothing_paid(h)


@pytest.mark.parametrize("asset", ["ETH", "USDC"])
def test_base_recovery_reuses_chain_hash_and_expired_purchase_without_payment(base, asset):
    h = Harness(base, asset=asset)
    h.server.pay_statuses = [500]
    with pytest.raises(a.Aifp1PayError) as failure:
        h.fetch(chain="base")
    recovery = failure.value.recovery
    assert recovery["chain"] == "base"
    recovery["quote"]["expires_at"] = "2000-01-01T00:00:00.000Z"
    recovery["quote"]["settlement_call"]["args"]["quote"]["validUntil"] = "946684800"
    before = len(h.chain.sent)
    paid = a.submit_payment(h.server, PAYER, recovery)
    assert paid["chain"] == "base" and paid["tx_ref"] == recovery["tx_ref"]
    assert len(h.chain.sent) == before and len({p["idem"] for p in h.server.pays}) == 1
    for mutate in (lambda r: r.pop("chain"), lambda r: r.update(chain="polygon"), lambda r: r.update(asset="POL")):
        changed = copy.deepcopy(recovery)
        mutate(changed)
        requests_before = len(h.server.pays)
        with pytest.raises(a.Aifp1QuoteError):
            a.submit_payment(h.server, PAYER, changed)
        assert len(h.server.pays) == requests_before


@pytest.mark.parametrize("asset", ["ETH", "USDC"])
def test_even_a_signed_polygon_receipt_cannot_confirm_base(base, asset):
    h = Harness(base, asset=asset)
    h.server.claims_override = {"chain": "polygon"}
    h.server.paid_override = {"chain": "polygon"}
    with pytest.raises(a.Aifp1PayError):
        h.fetch(chain="base")
    assert not any(h.receipts.values())
    assert len(h.chain.sent) == (1 if asset == "ETH" else 2)


@pytest.mark.parametrize("name,mutate,code", REFUSALS, ids=[r[0] for r in REFUSALS])
def test_base_preserves_existing_executor_guards(base, name, mutate, code):
    call = signed_call(base, token=base["splitter"]["usdc"])
    client, journal = FakeChain(base, call), []
    kw = {"expected_chain": "base"}
    mutate(call, client, kw)
    with pytest.raises(s.V14SettlementError) as err:
        s.execute_v14_settlement(call, context(client, call, journal, **kw))
    assert err.value.code == code and not client.sent and not journal


@pytest.mark.parametrize("mutation,code", [
    ("implicit", "V14_CHAIN_MISMATCH"), ("rpc", "V14_CHAIN_MISMATCH"),
    ("domain", "V14_UNTRUSTED_SIGNER"), ("asset", "V14_UNSUPPORTED_ASSET"),
])
def test_base_executor_binds_authorized_chain_rpc_eip712_domain_and_native_asset(base, mutation, code):
    signing_dep = dict(base, chainId=137) if mutation == "domain" else base
    call = signed_call(signing_dep)
    client, journal = FakeChain(base, call), []
    if mutation == "rpc":
        client.chain_id = lambda: 137
    if mutation == "asset":
        call["asset"] = "POL"
    kw = {} if mutation == "implicit" else {"expected_chain": "base"}
    with pytest.raises(s.V14SettlementError) as err:
        s.execute_v14_settlement(call, context(client, call, journal, **kw))
    assert err.value.code == code and not client.sent and not journal


@pytest.mark.parametrize("stable", [False, True])
@pytest.mark.parametrize("failure", ["l1", "operator", "fee_budget", "balance"])
def test_base_additional_fees_fail_closed_before_approval_or_settlement(base, stable, failure):
    call = signed_call(base, token=base["splitter"]["usdc"] if stable else s.ZERO)
    client, journal = FakeChain(base, call), []
    original_call = client.call

    def oracle_failure(to, data, **kwargs):
        name = client.by_selector.get(bytes(data[:4]))
        if name == ("getL1FeeUpperBound(uint256)" if failure == "l1" else "getOperatorFee(uint256)"):
            raise OSError("fee oracle unavailable")
        return original_call(to, data, **kwargs)

    if failure in ("l1", "operator"):
        client.call = oracle_failure
        code = "V14_FEE_ESTIMATE_UNAVAILABLE"
    else:
        client.state["getL1FeeUpperBound(uint256)"] = 10_000_000
        code = "V14_GAS_BUDGET_EXCEEDED" if failure == "fee_budget" else "V14_INSUFFICIENT_BALANCE"
    kw = {"max_gas_wei": 100_000_000} if failure == "balance" else {}
    with pytest.raises(s.V14SettlementError) as err:
        s.execute_v14_settlement(call, context(client, call, journal, expected_chain="base", **kw))
    assert err.value.code == code and not client.sent and not journal


def test_base_usdc_budget_includes_both_additional_fees_before_approval(base):
    call = signed_call(base, token=base["splitter"]["usdc"])
    client, journal = FakeChain(base, call), []
    # L2-only is 4.2m; each transaction adds1.2m for L1/operator estimates.
    client.state["getL1FeeUpperBound(uint256)"] = 900_000
    client.state["getOperatorFee(uint256)"] = 100_000
    with pytest.raises(s.V14SettlementError) as err:
        s.execute_v14_settlement(call, context(client, call, journal, expected_chain="base", max_gas_wei=6_000_000))
    assert err.value.code == "V14_GAS_BUDGET_EXCEEDED" and not client.sent and not journal
    assert [n for n, _ in client.oracle_calls].count("getL1FeeUpperBound(uint256)") == 2
    assert ("getOperatorFee(uint256)", 300_000) in client.oracle_calls


def test_base_fee_estimate_is_checked_again_after_approval(base):
    call = signed_call(base, token=base["splitter"]["usdc"])
    client, journal = FakeChain(base, call), []
    original_wait = client.wait_for_receipt

    def confirm_and_raise_fee(tx):
        receipt = original_wait(tx)
        client.state["getL1FeeUpperBound(uint256)"] = 10_000_000
        return receipt

    client.wait_for_receipt = confirm_and_raise_fee
    with pytest.raises(s.V14SettlementError) as err:
        s.execute_v14_settlement(call, context(client, call, journal, expected_chain="base"))
    assert err.value.code == "V14_GAS_BUDGET_EXCEEDED"
    assert len(client.sent) == 1 and client.is_approve(client.sent[0])[0] and not journal
