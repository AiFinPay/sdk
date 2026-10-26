"""Arc: native gas is USDC, payment only through the 6-decimal USDC ERC-20.

Offline: a fake chain and quote server, no live RPC or funds. Also pins that
aifinpay-deployments 2.1.0 makes both Solana records resolvable.
"""
import pytest
from eth_abi import decode
from eth_utils import keccak
from test_aifp1 import SHOP, STABLE_GROSS, Harness, assert_nothing_paid
from test_settlement_v14 import CODE, SIGNER, FakeChain, context, decode_tx, signed_call

import aifinpay.aifp1 as a
import aifinpay.settlement_solana_v14 as sol
import aifinpay.settlement_v14 as s
from aifinpay._v14_deployments import V14_DEPLOYMENTS

ARC_USDC = "0x3600000000000000000000000000000000000000"


@pytest.fixture(autouse=True)
def pinned(monkeypatch):
    def unexpected(*_args, **_kwargs):
        raise AssertionError("offline test must not contact a live network")

    monkeypatch.setattr(a.requests.Session, "request", unexpected)
    for chain in ("arc", "arctestnet"):
        dep = V14_DEPLOYMENTS[chain]
        monkeypatch.setitem(s.V14_DEPLOYMENTS, chain, dict(dep, runtimeCodeHash="0x" + keccak(CODE).hex(),
                            splitter=dict(dep["splitter"], signer=SIGNER.address)))


@pytest.mark.parametrize("chain", ["arc", "arctestnet"])
def test_usdc_takes_the_token_path_with_exact_six_decimal_approval(chain):
    h = Harness(V14_DEPLOYMENTS[chain], asset="USDC")
    assert h.fetch(f"{SHOP}/a", chain=chain).status_code == 200
    assert h.server.last_quote_request["asset"] == "USDC"
    assert h.server.last_quote["network_mode"] == ("test" if chain == "arctestnet" else "live")
    approval, settlement = (decode_tx(raw) for raw in h.chain.sent)
    assert approval["to"].hex() == ARC_USDC[2:] and approval["value"] == 0
    spender, amount = decode(["address", "uint256"], approval["data"][4:])
    assert spender.lower() == V14_DEPLOYMENTS[chain]["splitter"]["address"].lower()
    assert amount == STABLE_GROSS  # 6 decimals, never 18
    assert settlement["value"] == 0
    assert h.journal[0]["asset"] == "USDC"


@pytest.mark.parametrize("asset,message", [(None, "no native payment"), ("EURC", "not a stablecoin pinned")])
def test_native_and_eurc_are_refused_before_quoting(asset, message):
    h = Harness(V14_DEPLOYMENTS["arc"], asset=asset)
    with pytest.raises(a.Aifp1QuoteError, match=message):
        h.fetch(chain="arc")
    assert h.server.quotes == 0
    assert_nothing_paid(h)


def test_a_native_shaped_quote_is_never_paid_as_usdc():
    h = Harness(V14_DEPLOYMENTS["arc"], asset="USDC")

    def native(quote):
        native_call = signed_call(V14_DEPLOYMENTS["arc"], gross=10**17, order=quote["quote_id"])
        quote.pop("token_settlement")
        quote["settlement_call"] = h.server.call = native_call
        quote["native_settlement"] = {"asset": "USDC", "decimals": 18, "total_wei": str(10**17)}

    h.server.quote_mutator = native
    with pytest.raises(a.Aifp1QuoteError):
        h.fetch(chain="arc")
    assert_nothing_paid(h)


@pytest.mark.parametrize("chain,mode", [("arctestnet", "live"), ("arc", "test")])
def test_testnet_and_mainnet_quotes_cannot_be_swapped(chain, mode):
    h = Harness(V14_DEPLOYMENTS[chain], asset="USDC")
    h.server.quote_mutator = lambda quote: quote.update(network_mode=mode)
    with pytest.raises(a.Aifp1QuoteError, match="live USD terms"):
        h.fetch(chain=chain)
    assert_nothing_paid(h)


def test_validate_native_quote_refuses_arc():
    with pytest.raises(a.Aifp1QuoteError, match="no native payment"):
        a.validate_native_quote({"quote_id": "q"}, "0x" + "11" * 20, 0, 1.0, "arc")


def test_executor_refuses_settle_native_on_arc():
    dep = s.V14_DEPLOYMENTS["arc"]
    call = signed_call(dep)  # token 0, asset "USDC", settleNative
    fake = FakeChain(dep, call)
    with pytest.raises(s.V14SettlementError) as error:
        s.execute_v14_settlement(call, context(fake, call, [], expected_chain="arc"))
    assert error.value.code == "V14_UNSUPPORTED_ASSET" and not fake.sent


def test_executor_counts_gas_against_the_same_usdc_balance():
    dep = s.V14_DEPLOYMENTS["arc"]
    call = signed_call(dep, token=ARC_USDC, gross=STABLE_GROSS)
    fake = FakeChain(dep, call)
    fake.native_balance = STABLE_GROSS * 10**12  # exactly the gross, nothing left for gas
    with pytest.raises(s.V14SettlementError) as error:
        s.execute_v14_settlement(call, context(fake, call, [], expected_chain="arc"))
    assert error.value.code == "V14_INSUFFICIENT_BALANCE" and not fake.sent
    fake.native_balance = STABLE_GROSS * 10**12 + 10_000_000
    s.execute_v14_settlement(call, context(fake, call, [], expected_chain="arc"))
    assert len(fake.sent) == 2


@pytest.mark.parametrize("environment,network,program", [
    ("prod", "mainnet", "724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD"),
    ("dev", "devnet", "8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y"),
])
def test_solana_records_resolve_enabled_from_deployments_2_1_0(environment, network, program):
    assert sol.authorized_inventory(environment, network)["programId"] == program


def test_a_native_quote_whose_signed_call_names_a_token_is_refused():
    h = Harness(V14_DEPLOYMENTS["polygon"], asset="POL")

    def token(quote):
        quote["settlement_call"]["args"]["quote"]["token"] = V14_DEPLOYMENTS["polygon"]["splitter"]["usdc"]
        quote["settlement_call"]["value_wei"] = "0"

    h.server.quote_mutator = token
    with pytest.raises(a.Aifp1QuoteError, match="signed v1.4 call disagrees"):
        h.fetch()
    assert_nothing_paid(h)
