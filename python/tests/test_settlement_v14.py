"""v1.4 execution in Python: the same checks and codes as node/src/settlementV14.ts.

Real EIP-712 and transaction signing against a fake chain client, with the
pinned signer and runtime replaced in memory. Every refusal must happen before
anything is signed; only the settlement (never the approval) is journaled.
"""

import time

import pytest
from eth_abi import decode as abi_decode
from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import keccak

import aifinpay.settlement_v14 as s
from aifinpay._v14_deployments import V14_DEPLOYMENTS

SIGNER = Account.from_key("0x" + "01" * 32)
PAYER = Account.from_key("0x" + "02" * 32)
MERCHANT = "0x3333333333333333333333333333333333333333"
ZERO = s.ZERO
CODE = b"\x60\x01"
DEP = V14_DEPLOYMENTS["polygon"]
USDC = next(a for a in DEP["splitter"]["assets"] if a["symbol"] == "USDC")["address"]


@pytest.fixture(autouse=True)
def pinned(monkeypatch):
    dep = dict(DEP, runtimeCodeHash="0x" + keccak(CODE).hex(), splitter=dict(DEP["splitter"], signer=SIGNER.address))
    monkeypatch.setitem(s.V14_DEPLOYMENTS, "polygon", dep)
    return dep


def sel(signature):
    return keccak(text=signature)[:4]


def signed_call(dep, token=ZERO, gross=100000, order="order-1"):
    q = {
        "payer": PAYER.address, "merchant": MERCHANT, "token": token, "grossAmount": str(gross),
        "ipCreator": ZERO, "validUntil": str(int(time.time()) + 300),
        "orderIdHash": "0x" + keccak(text=order).hex(), "nonce": "0", "routeId": s.route_id_of("merchant-aifp1"),
    }
    typed = {
        "types": {
            "EIP712Domain": [{"name": "name", "type": "string"}, {"name": "version", "type": "string"},
                             {"name": "chainId", "type": "uint256"}, {"name": "verifyingContract", "type": "address"}],
            "Quote": [{"name": n, "type": t} for n, t in s.QUOTE_FIELDS],
        },
        "primaryType": "Quote",
        "domain": {"name": "B2BSplitterV14", "version": "1", "chainId": dep["chainId"],
                   "verifyingContract": dep["splitter"]["address"]},
        "message": {**q, "grossAmount": gross, "validUntil": int(q["validUntil"]), "nonce": 0},
    }
    sig = SIGNER.sign_message(encode_typed_data(full_message=typed)).signature.hex()
    stable = token != ZERO
    call = {
        "chain": "polygon", "contract": dep["splitter"]["address"], "splitter_version": "1.4",
        "route": "merchant-aifp1", "asset": "USDC" if stable else "POL",
        "function": s.STABLE_FUNCTION if stable else s.NATIVE_FUNCTION,
        "arg_encoding": "struct+signature", "field_order": [n for n, _ in s.QUOTE_FIELDS],
        "value_wei": "0" if stable else str(gross),
        "args": {"quote": q, "signature": sig if sig.startswith("0x") else "0x" + sig},
    }
    if stable:
        call["approval"] = {"token": token, "spender": dep["splitter"]["address"], "amount": str(gross)}
    return call


def decode_tx(raw):
    # EIP-1559: 0x02 || rlp([chainId, nonce, maxPriorityFee, maxFee, gas, to, value, data, accessList, v, r, s])
    import rlp

    assert raw[0] == 2
    fields = rlp.decode(bytes(raw[1:]))
    return {"to": fields[5], "value": int.from_bytes(fields[6], "big"), "data": fields[7]}


class FakeChain:
    def __init__(self, dep, call, event_token=None):
        self.dep = dep
        self.call_obj = call
        q = call["args"]["quote"]
        self.state = {
            "profiles()": dep["splitter"]["profiles"], "tokenList()": dep["splitter"]["tokenList"],
            "treasury()": dep["splitter"]["treasury"], "hasRole(bytes32,address)": True,
            "getProfile(bytes32)": (100, 0, True, 1, ZERO),
            "consumedNonce(address,uint256)": False, "payerNonce(address)": 0, "paused()": False,
            "isAllowed(address)": True, "decimals()": 6, "balanceOf(address)": 5_000_000,
            "allowance(address,address)": 0,
        }
        self.returns = {
            "profiles()": ["address"], "tokenList()": ["address"], "treasury()": ["address"],
            "hasRole(bytes32,address)": ["bool"], "getProfile(bytes32)": ["(uint16,uint16,bool,uint64,address)"],
            "consumedNonce(address,uint256)": ["bool"], "payerNonce(address)": ["uint256"], "paused()": ["bool"],
            "isAllowed(address)": ["bool"], "decimals()": ["uint8"], "balanceOf(address)": ["uint256"],
            "allowance(address,address)": ["uint256"],
        }
        self.by_selector = {sel(k): k for k in self.returns}
        self.sent = []
        self.approve_status = 1
        self.settle_status = 1
        self.native_balance = 10_000_000
        self.code = CODE
        self.event_token = event_token if event_token is not None else q["token"]

    def chain_id(self):
        return self.dep["chainId"]

    def get_code(self, address):
        return self.code

    def call(self, to, data, sender=None, value=0):
        name = self.by_selector.get(bytes(data[:4]))
        if name is None:
            return b""  # simulation of approve / settle
        return abi_encode(self.returns[name], [self.state[name]])

    def estimate_gas(self, sender, to, data, value=0):
        return 100000

    def fees(self):
        return 10, 1

    def pending_nonce(self, address):
        return 7 + len(self.sent)

    def pending_balance(self, address):
        return self.native_balance

    def is_approve(self, raw):
        tx = decode_tx(raw)
        return "0x" + bytes(tx["to"]).hex() == USDC.lower(), tx

    def send_raw_transaction(self, raw):
        self.sent.append(raw)
        approve, tx = self.is_approve(raw)
        if approve and self.approve_status == 1:
            self.state["allowance(address,address)"] = abi_decode(["address", "uint256"], bytes(tx["data"])[4:])[1]
        return "0x" + keccak(raw).hex()

    def wait_for_receipt(self, tx_hash):
        raw = next(r for r in self.sent if "0x" + keccak(r).hex() == tx_hash)
        approve, _ = self.is_approve(raw)
        if approve:
            return {"status": self.approve_status, "transactionHash": tx_hash, "logs": []}
        q = self.call_obj["args"]["quote"]
        gross = int(q["grossAmount"])
        log = {
            "address": self.call_obj["contract"],
            "topics": [s._PAYMENT_TOPIC, s._payment_id(q), "0x" + "00" * 12 + q["payer"][2:].lower(),
                       "0x" + "00" * 12 + q["merchant"][2:].lower()],
            "data": "0x" + abi_encode(
                ["address", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes32", "bytes32"],
                [self.event_token, gross, gross - gross // 100, gross // 100, 0, int(q["validUntil"]),
                 bytes.fromhex(q["routeId"][2:]), bytes.fromhex(q["orderIdHash"][2:])],
            ).hex(),
        }
        return {"status": self.settle_status, "transactionHash": tx_hash, "logs": [log]}


def context(chain, call, journal, **over):
    q = call["args"]["quote"]
    kw = dict(
        client=chain, account=PAYER, order_id="order-1", expected_merchant=MERCHANT,
        expected_gross_amount=int(q["grossAmount"]), max_gas_wei=10_000_000, on_prepared=journal.append,
        expected_token=None if q["token"] == ZERO else q["token"],
    )
    kw.update(over)
    return s.V14ExecutionContext(**kw)


def test_native_settlement_is_journaled_before_it_is_sent(pinned):
    call = signed_call(pinned)
    chain, journal = FakeChain(pinned, call), []
    result = s.execute_v14_settlement(call, context(chain, call, journal))
    assert len(chain.sent) == 1 and len(journal) == 1
    assert journal[0]["hash"] == result["hash"] == "0x" + keccak(chain.sent[0]).hex()
    assert decode_tx(chain.sent[0])["value"] == 100000
    assert result["route"] == "merchant-aifp1"


def test_usdc_approves_exactly_the_gross_then_settles_with_no_value(pinned):
    call = signed_call(pinned, token=USDC)
    chain, journal = FakeChain(pinned, call), []
    s.execute_v14_settlement(call, context(chain, call, journal))
    assert len(chain.sent) == 2, "expected an approval and a settlement"
    approve, tx = chain.is_approve(chain.sent[0])
    assert approve
    spender, amount = abi_decode(["address", "uint256"], bytes(tx["data"])[4:])
    assert spender.lower() == pinned["splitter"]["address"].lower() and amount == 100000
    assert decode_tx(chain.sent[1])["value"] == 0
    assert len(journal) == 1 and journal[0]["hash"] == "0x" + keccak(chain.sent[1]).hex()


def test_usdc_skips_the_approval_when_the_allowance_covers_the_gross(pinned):
    call = signed_call(pinned, token=USDC)
    chain, journal = FakeChain(pinned, call), []
    chain.state["allowance(address,address)"] = 100000
    s.execute_v14_settlement(call, context(chain, call, journal))
    assert len(chain.sent) == 1


REFUSALS = [
    ("approval larger than gross", lambda c, ch, k: c["approval"].update(amount="100000000"), "V14_APPROVAL_MISMATCH"),
    ("approval to another spender", lambda c, ch, k: c["approval"].update(spender=MERCHANT), "V14_APPROVAL_MISMATCH"),
    ("asset label not the pinned symbol", lambda c, ch, k: c.update(asset="USDT"), "V14_UNSUPPORTED_ASSET"),
    ("value on a token quote", lambda c, ch, k: c.update(value_wei="100000"), "V14_VALUE_MISMATCH"),
    ("purchase in another token", lambda c, ch, k: k.update(expected_token=None), "V14_PURCHASE_MISMATCH"),
    ("tokenList no longer allows it", lambda c, ch, k: ch.state.update({"isAllowed(address)": False}),
     "V14_TOKEN_NOT_ALLOWED"),
    ("token without 6 decimals", lambda c, ch, k: ch.state.update({"decimals()": 18}), "V14_TOKEN_DECIMALS"),
    ("too few tokens", lambda c, ch, k: ch.state.update({"balanceOf(address)": 99999}), "V14_INSUFFICIENT_BALANCE"),
    ("gas budget too small", lambda c, ch, k: k.update(max_gas_wei=1_000_000), "V14_GAS_BUDGET_EXCEEDED"),
    ("paused splitter", lambda c, ch, k: ch.state.update({"paused()": True}), "V14_PAUSED"),
    ("stale nonce", lambda c, ch, k: ch.state.update({"payerNonce(address)": 1}), "V14_STALE_NONCE"),
    ("changed profile", lambda c, ch, k: ch.state.update({"getProfile(bytes32)": (200, 0, True, 1, ZERO)}),
     "V14_PROFILE_MISMATCH"),
    ("unknown runtime", lambda c, ch, k: setattr(ch, "code", b"\x60\x02"), "V14_RUNTIME_MISMATCH"),
    ("other merchant", lambda c, ch, k: k.update(expected_merchant="0x" + "44" * 20), "V14_PURCHASE_MISMATCH"),
]


@pytest.mark.parametrize("name,mutate,code", REFUSALS, ids=[r[0] for r in REFUSALS])
def test_refusals_happen_before_anything_is_signed(pinned, name, mutate, code):
    call = signed_call(pinned, token=USDC)
    chain, journal = FakeChain(pinned, call), []
    kw = {}
    mutate(call, chain, kw)
    with pytest.raises(s.V14SettlementError) as err:
        s.execute_v14_settlement(call, context(chain, call, journal, **kw))
    assert err.value.code == code
    assert chain.sent == [] and journal == []


def test_a_quote_signed_by_someone_else_is_refused(pinned, monkeypatch):
    call = signed_call(pinned)
    monkeypatch.setitem(s.V14_DEPLOYMENTS, "polygon", dict(pinned, splitter=dict(pinned["splitter"], signer=MERCHANT)))
    chain, journal = FakeChain(pinned, call), []
    with pytest.raises(s.V14SettlementError) as err:
        s.execute_v14_settlement(call, context(chain, call, journal))
    assert err.value.code == "V14_UNTRUSTED_SIGNER" and chain.sent == []


def test_a_reverted_approval_stops_before_the_settlement(pinned):
    call = signed_call(pinned, token=USDC)
    chain, journal = FakeChain(pinned, call), []
    chain.approve_status = 0
    with pytest.raises(s.V14SettlementError) as err:
        s.execute_v14_settlement(call, context(chain, call, journal))
    assert err.value.code == "V14_APPROVAL_FAILED"
    assert len(chain.sent) == 1 and journal == []


def test_a_mined_payment_in_another_token_is_not_accepted_as_paid(pinned):
    call = signed_call(pinned, token=USDC)
    chain, journal = FakeChain(pinned, call, event_token=ZERO), []
    with pytest.raises(s.SettlementConfirmationPending):
        s.execute_v14_settlement(call, context(chain, call, journal))


def test_a_reverted_settlement_is_reported_not_retried(pinned):
    call = signed_call(pinned)
    chain, journal = FakeChain(pinned, call), []
    chain.settle_status = 0
    with pytest.raises(s.V14SettlementError) as err:
        s.execute_v14_settlement(call, context(chain, call, journal))
    assert err.value.code == "V14_TRANSACTION_REVERTED"
