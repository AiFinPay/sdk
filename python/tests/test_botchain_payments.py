"""BOT Chain: paid only in its 6-decimal Bridged USDT; BOT pays gas.

BOT has no USD price on our backend or the public price sources, so a native
quote has nothing to be checked against and is refused before quoting.
Offline: a fake chain and quote server, no live RPC or funds.
"""
import pytest
from eth_abi import decode
from eth_utils import keccak
from test_aifp1 import SHOP, STABLE_GROSS, Harness, assert_nothing_paid
from test_settlement_v14 import CODE, SIGNER, FakeChain, context, decode_tx, signed_call

import aifinpay.aifp1 as a
import aifinpay.settlement_v14 as s
from aifinpay._v14_deployments import V14_DEPLOYMENTS
from aifinpay.payment_chains import native_payable

BOT_USDT = "0xababc7ddc03e501d190c676bf3d92ef0e6e87a3c"


@pytest.fixture(autouse=True)
def pinned(monkeypatch):
    def unexpected(*_args, **_kwargs):
        raise AssertionError("offline test must not contact a live network")

    monkeypatch.setattr(a.requests.Session, "request", unexpected)
    dep = V14_DEPLOYMENTS["botchain"]
    monkeypatch.setitem(s.V14_DEPLOYMENTS, "botchain", dict(dep, runtimeCodeHash="0x" + keccak(CODE).hex(),
                        splitter=dict(dep["splitter"], signer=SIGNER.address)))


def test_usdt_takes_the_token_path_with_exact_six_decimal_approval():
    h = Harness(V14_DEPLOYMENTS["botchain"], asset="USDT")
    assert h.fetch(f"{SHOP}/a", chain="botchain").status_code == 200
    assert h.server.last_quote_request["asset"] == "USDT"
    approval, settlement = (decode_tx(raw) for raw in h.chain.sent)
    assert approval["to"].hex() == BOT_USDT[2:] and approval["value"] == 0
    spender, amount = decode(["address", "uint256"], approval["data"][4:])
    assert spender.lower() == V14_DEPLOYMENTS["botchain"]["splitter"]["address"].lower()
    assert amount == STABLE_GROSS
    assert settlement["value"] == 0
    assert h.journal[0]["asset"] == "USDT"


@pytest.mark.parametrize("asset,message", [
    (None, "no native payment"),
    ("BOT", "BOT has no USD price"),
    ("USDC", "not a stablecoin pinned"),
])
def test_native_and_unpinned_assets_are_refused_before_quoting(asset, message):
    h = Harness(V14_DEPLOYMENTS["botchain"], asset=asset)
    with pytest.raises(a.Aifp1QuoteError, match=message):
        h.fetch(chain="botchain")
    assert h.server.quotes == 0
    assert_nothing_paid(h)


def test_validate_native_quote_refuses_botchain():
    assert not native_payable("botchain")
    with pytest.raises(a.Aifp1QuoteError, match="no native payment"):
        a.validate_native_quote({"quote_id": "q"}, "0x" + "11" * 20, 0, 1.0, "botchain")


def test_executor_refuses_settle_native_on_botchain():
    dep = s.V14_DEPLOYMENTS["botchain"]
    call = dict(signed_call(dep), asset="BOT")  # token 0, settleNative
    fake = FakeChain(dep, call)
    with pytest.raises(s.V14SettlementError) as error:
        s.execute_v14_settlement(call, context(fake, call, [], expected_chain="botchain"))
    assert error.value.code == "V14_UNSUPPORTED_ASSET" and not fake.sent
