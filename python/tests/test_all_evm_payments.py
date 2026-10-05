"""Nine EVM quote/sign/approval/receipt/recovery paths; no live RPC or funds."""
import copy

import pytest
from eth_utils import keccak
from test_aifp1 import Harness, SHOP, assert_nothing_paid
from test_settlement_v14 import CODE, SIGNER, PAYER, FakeChain, context, signed_call, decode_tx

import aifinpay.aifp1 as a
import aifinpay.settlement_v14 as s
from aifinpay._v14_deployments import V14_DEPLOYMENTS
from aifinpay.payment_chains import PAYMENT_CHAINS, pinned_token_decimals


@pytest.fixture(autouse=True)
def no_network(monkeypatch):
    def unexpected(*_args, **_kwargs):
        raise AssertionError("offline acceptance must not contact a live network")
    monkeypatch.setattr(a.requests.Session, "request", unexpected)
    for chain in PAYMENT_CHAINS:
        dep = V14_DEPLOYMENTS[chain]
        monkeypatch.setitem(s.V14_DEPLOYMENTS, chain, dict(dep, runtimeCodeHash="0x" + keccak(CODE).hex(),
                           splitter=dict(dep["splitter"], signer=SIGNER.address)))


PAIRS = [(chain, descriptor["native"]) for chain, descriptor in PAYMENT_CHAINS.items()] + [
    (chain, asset["symbol"]) for chain in PAYMENT_CHAINS for asset in V14_DEPLOYMENTS[chain]["splitter"]["assets"]
]


@pytest.mark.parametrize("chain,asset", PAIRS)
def test_end_to_end_offline_quote_exact_approval_receipt_reuse_and_recovery(chain, asset):
    h = Harness(V14_DEPLOYMENTS[chain], asset=asset)
    assert h.fetch(f"{SHOP}/articles/1", chain=chain).status_code == 200
    assert h.server.last_quote_request["settlement_chain"] == chain
    native = asset == PAYMENT_CHAINS[chain]["native"]
    assert len(h.chain.sent) == (1 if native else 2)
    assert all(decode_tx(raw)["chainId"] == PAYMENT_CHAINS[chain]["chainId"] for raw in h.chain.sent)
    if not native:
        approval = decode_tx(h.chain.sent[0])
        from eth_abi import decode
        assert decode(["address", "uint256"], approval["data"][4:])[1] == int(h.server.call["args"]["quote"]["grossAmount"])
    assert bool(h.chain.oracle_calls) == (PAYMENT_CHAINS[chain]["gasModel"] == "op")
    saved = copy.deepcopy(h.journal[0]); saved["quote"]["expires_at"] = "1970-01-01T00:00:01.000Z"
    assert a.submit_payment(h.server, PAYER, saved)["chain"] == chain
    count = len(h.chain.sent)
    assert h.fetch(f"{SHOP}/articles/2", chain=chain).status_code == 200
    assert len(h.chain.sent) == count and h.server.quotes == 1


@pytest.mark.parametrize("chain,asset,receipt_asset", [("polygon", "USDC.e", "USDC.E"), ("robinhood", "USDe", "USDE")])
def test_backend_uppercase_receipt_preserves_exact_quote_symbols(chain, asset, receipt_asset):
    h = Harness(V14_DEPLOYMENTS[chain], asset=asset)
    assert h.fetch(chain=chain).status_code == 200
    assert h.server.call["asset"] == h.server.last_quote["token_settlement"]["asset"] == asset
    saved = h.journal[0]
    assert saved["asset"] == asset
    count = len(h.chain.sent)
    assert a.submit_payment(h.server, PAYER, saved)["asset"] == receipt_asset
    assert len(h.chain.sent) == count


def test_uppercase_receipt_still_requires_exact_response_jwt_consistency():
    h = Harness(V14_DEPLOYMENTS["robinhood"], asset="USDe")
    h.server.paid_override["asset"] = "USDe"
    with pytest.raises(a.Aifp1PayError):
        h.fetch(chain="robinhood")
    assert not any(h.receipts.values()) and len(h.chain.sent) == 2


@pytest.mark.parametrize("chain,asset", [("polygon", "USDC"), ("bnb", "USDC"), ("robinhood", "USDe")])
@pytest.mark.parametrize("field", ["asset", "token", "decimals", "total_units", "merchant_units", "protocol_fee_units", "creator_units", "settlement_semantics"])
def test_tampered_token_metadata_cannot_reserve_or_sign(chain, asset, field):
    h = Harness(V14_DEPLOYMENTS[chain], asset=asset)
    h.server.quote_mutator = lambda quote: quote["token_settlement"].update({field: 9 if field == "decimals" else "foreign"})
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch(chain=chain)
    assert_nothing_paid(h)


@pytest.mark.parametrize("chain,asset", [("bnb", "USDC"), ("robinhood", "USDe"), ("polygon", "USDC")])
def test_exact_nonmultiple100_units_and_legacy_metadata_rule(chain, asset):
    dep = V14_DEPLOYMENTS[chain]
    token = next(t["address"] for t in dep["splitter"]["assets"] if t["symbol"] == asset)
    decimals = pinned_token_decimals(chain, token)
    gross = 100001 * 10 ** (decimals - 6)
    call = signed_call(dep, token=token, gross=gross)
    quote = {"quote_id": "order-1", "amount": "0.100001", "settlement_call": call,
             "accepted_assets": [asset], "accepted_chains": [chain], "pay_to": {"evm": call["args"]["quote"]["merchant"]},
             "settlement": {"total_units": "100001"},
             "token_settlement": {"asset": asset, "token": token, "decimals": decimals, "total_units": str(gross),
                                  "merchant_units": str(gross-gross//100), "protocol_fee_units": str(gross//100),
                                  "creator_units": "0", "settlement_semantics": "gross-inclusive"}}
    expiry = int(call["args"]["quote"]["validUntil"])
    assert a.validate_stable_quote(quote, asset, PAYER.address, expiry, chain) == 100001
    metadata = quote.pop("token_settlement")
    if decimals == 6:
        assert a.validate_stable_quote(quote, asset, PAYER.address, expiry, chain) == 100001
    else:
        with pytest.raises(a.Aifp1QuoteError): a.validate_stable_quote(quote, asset, PAYER.address, expiry, chain)
        quote["token_settlement"] = dict(metadata, protocol_fee_units=str(1000*10**12), merchant_units=str(99001*10**12))
        with pytest.raises(a.Aifp1QuoteError): a.validate_stable_quote(quote, asset, PAYER.address, expiry, chain)


@pytest.mark.parametrize("chain", ["base", "optimism", "unichain"])
def test_missing_op_fee_oracle_refuses_before_signature(chain):
    call = signed_call(V14_DEPLOYMENTS[chain])
    fake = FakeChain(V14_DEPLOYMENTS[chain], call); fake.state["getOperatorFee(uint256)"] = -1
    with pytest.raises(s.V14SettlementError) as error:
        s.execute_v14_settlement(call, context(fake, call, [], expected_chain=chain))
    assert error.value.code == "V14_FEE_ESTIMATE_UNAVAILABLE" and not fake.sent


@pytest.mark.parametrize("chain,asset", [("bnb", "USDC"), ("robinhood", "USDe")])
def test_live_decimals_mismatch_cannot_approve(chain, asset):
    dep = V14_DEPLOYMENTS[chain]; token = next(t["address"] for t in dep["splitter"]["assets"] if t["symbol"] == asset)
    call = signed_call(dep, token=token, gross=10**17); fake = FakeChain(dep, call); fake.state["decimals()"] = 6
    with pytest.raises(s.V14SettlementError) as error:
        s.execute_v14_settlement(call, context(fake, call, [], expected_chain=chain))
    assert error.value.code == "V14_TOKEN_DECIMALS" and not fake.sent


@pytest.mark.parametrize("chain", list(PAYMENT_CHAINS))
def test_high_level_chain_selection_and_owner_rpc_do_not_fall_back_to_polygon(chain, monkeypatch, tmp_path):
    from aifinpay import AiFinPayAgent
    rpc = f"https://{chain}.owner.example"
    agent = AiFinPayAgent.from_seed("07"*32, evm_rpc_urls={chain: rpc})
    seen = {}
    def fake_fetch(_url, **kw):
        seen.update(kw)
        return "response"
    monkeypatch.setattr(a, "aifp1_fetch", fake_fetch)
    assert agent.fetch_paid(f"{SHOP}/x", allowed_origins=[SHOP], max_amount_usd=1, daily_amount_usd=2,
                           chain=chain, max_gas_wei=10**15, journal_dir=str(tmp_path)) == "response"
    assert seen["chain"] == chain and seen["polygon_rpc"] == rpc
    assert agent._web3(chain).provider.endpoint_uri == rpc
    if chain != "polygon":
        with pytest.raises(a.Aifp1QuoteError, match="explicit max_gas_wei"):
            agent.fetch_paid(f"{SHOP}/x", allowed_origins=[SHOP], max_amount_usd=1, daily_amount_usd=2,
                             chain=chain, journal_dir=str(tmp_path))


def test_legacy_omitted_chain_omits_request_selector_and_keeps_polygon():
    h = Harness(V14_DEPLOYMENTS["polygon"], asset="USDC")
    assert h.fetch().status_code == 200
    assert "settlement_chain" not in h.server.last_quote_request
    assert h.journal[0]["chain"] == "polygon"



def test_high_level_omitted_chain_preserves_selector_omission_and_polygon_override(monkeypatch, tmp_path):
    from aifinpay import AiFinPayAgent
    agent = AiFinPayAgent.from_seed("07"*32)
    seen = {}
    monkeypatch.setattr(a, "aifp1_fetch", lambda _url, **kw: seen.update(kw) or "response")
    assert agent.fetch_paid(f"{SHOP}/x", allowed_origins=[SHOP], max_amount_usd=1, daily_amount_usd=2,
                           max_gas_wei=10**15, journal_dir=str(tmp_path)) == "response"
    assert seen["chain"] is None and seen["polygon_rpc"] == agent.polygon_rpc
    override = object()
    agent._w3 = override
    assert agent._web3() is override
    assert agent._web3("base") is not override
