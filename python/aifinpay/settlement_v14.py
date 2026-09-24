"""B2BSplitter v1.4 settlement — the client half, for Python.

A port of ``node/src/settlementV14.ts``: the same checks, in the same order,
with the same refusal codes, so an agent gets the same answer whichever SDK
it runs. v1.4 quotes arrive already signed by AiFinPay's quote signer; the
client's job is to CHECK them against independently pinned deployments and
submit them — never to construct one. Most of this module is refusals.

Two settlement paths:

* ``settleNative`` — the gross is sent as value in POL.
* ``settleStable`` — the token is pulled with ``transferFrom``, so an approval
  for exactly the gross is sent first when the allowance is short. The
  approval moves no funds and is safe to repeat, so it is not journaled; the
  settlement is, exactly like the native path.

The chain is reached through a small :class:`ChainClient` interface so the
checks can be exercised without a node; :class:`Web3ChainClient` adapts
web3.py for real use.
"""

from __future__ import annotations

import copy
import re
import time
from dataclasses import dataclass
from typing import Any, Callable, Dict, List, Optional, Protocol, Sequence, Tuple

from eth_abi import decode as abi_decode
from eth_abi import encode as abi_encode
from eth_account import Account
from eth_account.messages import encode_typed_data
from eth_utils import is_address, keccak

from ._v14_deployments import V14_DEPLOYMENTS

ZERO = "0x0000000000000000000000000000000000000000"
KNOWN_V14_ROUTES = ("merchant-aifp1", "agent-x402")
QUOTE_FIELDS: List[Tuple[str, str]] = [
    ("payer", "address"),
    ("merchant", "address"),
    ("token", "address"),
    ("grossAmount", "uint256"),
    ("ipCreator", "address"),
    ("validUntil", "uint256"),
    ("orderIdHash", "bytes32"),
    ("nonce", "uint256"),
    ("routeId", "bytes32"),
]
_QUOTE_TUPLE = "(address,address,address,uint256,address,uint256,bytes32,uint256,bytes32)"
NATIVE_FUNCTION = f"settleNative({_QUOTE_TUPLE},bytes)"
STABLE_FUNCTION = f"settleStable({_QUOTE_TUPLE},bytes)"
# Gas reserved for settleStable while it cannot be estimated yet (the estimate
# needs the allowance the approval is about to create). Measured at 161–179k
# on a Polygon fork; the real estimate replaces it before the settlement is signed.
STABLE_SETTLE_GAS_BOUND = 300_000
_PAYMENT_TOPIC = "0x" + keccak(
    text="Payment(bytes32,address,address,address,uint256,uint256,uint256,uint256,uint256,bytes32,bytes32)"
).hex()
_UINT = re.compile(r"^(0|[1-9][0-9]*)$")
_BYTES32 = re.compile(r"^0x[0-9a-fA-F]{64}$")
_SIG = re.compile(r"^0x[0-9a-fA-F]{130}$")


class V14SettlementError(Exception):
    """A refusal with a stable code; nothing was signed or sent unless noted."""

    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


class SettlementConfirmationPending(Exception):
    """A transaction was sent but its outcome is unknown. Recover THIS hash."""

    def __init__(self, tx_hash: str, stage: str = "settlement"):
        super().__init__(
            f"transaction {tx_hash} was broadcast but confirmation is unavailable; "
            "recover this transaction before retrying"
        )
        self.tx_hash = tx_hash
        self.stage = stage


def _lc(value: Any) -> str:
    return str(value or "").lower()


def _hex(b: bytes) -> str:
    return "0x" + b.hex()


def route_id_of(name: str) -> str:
    """Profiles.routeId(name) == keccak256(bytes(name))."""
    return _hex(keccak(text=name))


def known_route_ids(extra: Sequence[str] = ()) -> Dict[str, str]:
    return {route_id_of(n).lower(): n for n in (*KNOWN_V14_ROUTES, *extra)}


def _fail(code: str, message: str):
    raise V14SettlementError(code, message)


# ── Structural validation (no chain access) ──────────────────────────────────


def validate_v14_settlement_call(
    call: Dict[str, Any],
    order_id: Optional[str] = None,
    payer: Optional[str] = None,
    min_seconds_remaining: Optional[int] = None,
    now_ms: Optional[int] = None,
    allow_routes: Sequence[str] = (),
) -> Dict[str, Any]:
    """Read-only structural checks. Success authenticates nothing on its own."""
    if not isinstance(call, dict):
        _fail("V14_MALFORMED", "no settlement call")
    if call.get("splitter_version") != "1.4":
        _fail(
            "V14_WRONG_VERSION",
            f"expected a v1.4 settlement call, got {call.get('splitter_version')} — "
            "v1.2 and v1.3 settle through a different path",
        )
    args = call.get("args") or {}
    q = args.get("quote")
    sig = args.get("signature")
    if not q or not sig:
        _fail("V14_MALFORMED", "settlement call carries no quote or no signature")
    if not _SIG.match(str(sig)):
        _fail("V14_BAD_SIGNATURE", f"signature must be 65 bytes, got {(len(str(sig)) - 2) // 2}")
    route = known_route_ids(allow_routes).get(_lc(q.get("routeId")))
    if not route:
        _fail(
            "V14_UNKNOWN_ROUTE",
            f"routeId {q.get('routeId')} is not one this SDK understands — upgrade rather than force it",
        )
    if payer and _lc(payer) != _lc(q.get("payer")):
        _fail(
            "V14_WRONG_PAYER",
            f"this quote is signed for {q.get('payer')} and cannot be settled by {payer}",
        )
    if call.get("bound_to_payer") and _lc(call["bound_to_payer"]) != _lc(q.get("payer")):
        _fail("V14_MALFORMED", "bound_to_payer disagrees with the signed quote — do not submit this")
    order_checked = False
    if order_id is not None:
        if _lc(_hex(keccak(text=order_id))) != _lc(q.get("orderIdHash")):
            _fail("V14_ORDER_MISMATCH", f'this quote settles a different order than "{order_id}"')
        order_checked = True
    now = int((now_ms if now_ms is not None else time.time() * 1000) // 1000)
    expires_in = int(q.get("validUntil")) - now
    need = 30 if min_seconds_remaining is None else min_seconds_remaining
    if expires_in <= 0:
        _fail("V14_EXPIRED", f"quote expired {-expires_in}s ago — request a fresh one, do not submit this")
    if expires_in < need:
        _fail("V14_EXPIRING", f"quote expires in {expires_in}s, less than the {need}s of headroom required")
    token_is_native = _lc(q.get("token")) == ZERO
    if token_is_native and str(call.get("value_wei")) != str(q.get("grossAmount")):
        _fail("V14_VALUE_MISMATCH", "value_wei must equal the signed grossAmount")
    if not token_is_native and str(call.get("value_wei")) != "0":
        _fail("V14_VALUE_MISMATCH", f"value_wei must be 0 for a token quote, got {call.get('value_wei')}")
    return {"route": route, "expires_in_seconds": expires_in, "order_id_checked": order_checked}


# ── The chain, behind a small interface ──────────────────────────────────────


class ChainClient(Protocol):
    def chain_id(self) -> int: ...
    def get_code(self, address: str) -> bytes: ...
    def call(self, to: str, data: bytes, sender: Optional[str] = None, value: int = 0) -> bytes: ...
    def estimate_gas(self, sender: str, to: str, data: bytes, value: int = 0) -> int: ...
    def fees(self) -> Tuple[int, int]: ...
    def pending_nonce(self, address: str) -> int: ...
    def pending_balance(self, address: str) -> int: ...
    def send_raw_transaction(self, raw: bytes) -> str: ...
    def wait_for_receipt(self, tx_hash: str) -> Dict[str, Any]: ...


class Web3ChainClient:
    """:class:`ChainClient` over a web3.py ``Web3`` instance."""

    def __init__(self, w3: Any, receipt_timeout_s: int = 180):
        self.w3 = w3
        self.receipt_timeout_s = receipt_timeout_s

    def chain_id(self) -> int:
        return int(self.w3.eth.chain_id)

    def get_code(self, address: str) -> bytes:
        return bytes(self.w3.eth.get_code(self.w3.to_checksum_address(address)))

    def call(self, to: str, data: bytes, sender: Optional[str] = None, value: int = 0) -> bytes:
        tx: Dict[str, Any] = {"to": self.w3.to_checksum_address(to), "data": data, "value": value}
        if sender:
            tx["from"] = self.w3.to_checksum_address(sender)
        return bytes(self.w3.eth.call(tx))

    def estimate_gas(self, sender: str, to: str, data: bytes, value: int = 0) -> int:
        return int(
            self.w3.eth.estimate_gas(
                {
                    "from": self.w3.to_checksum_address(sender),
                    "to": self.w3.to_checksum_address(to),
                    "data": data,
                    "value": value,
                }
            )
        )

    def fees(self) -> Tuple[int, int]:
        priority = int(self.w3.eth.max_priority_fee)
        base = int(self.w3.eth.get_block("latest")["baseFeePerGas"])
        return base * 2 + priority, priority

    def pending_nonce(self, address: str) -> int:
        return int(self.w3.eth.get_transaction_count(self.w3.to_checksum_address(address), "pending"))

    def pending_balance(self, address: str) -> int:
        return int(self.w3.eth.get_balance(self.w3.to_checksum_address(address), "pending"))

    def send_raw_transaction(self, raw: bytes) -> str:
        return _hex(bytes(self.w3.eth.send_raw_transaction(raw)))

    def wait_for_receipt(self, tx_hash: str) -> Dict[str, Any]:
        r = self.w3.eth.wait_for_transaction_receipt(tx_hash, timeout=self.receipt_timeout_s)
        return {
            "status": int(r["status"]),
            "transactionHash": _hex(bytes(r["transactionHash"])),
            "logs": [
                {
                    "address": str(log["address"]),
                    "topics": [_hex(bytes(t)) for t in log["topics"]],
                    "data": _hex(bytes(log["data"])),
                }
                for log in r["logs"]
            ],
        }


def _selector(signature: str) -> bytes:
    return keccak(text=signature)[:4]


def _read(client: ChainClient, to: str, signature: str, arg_types: List[str], args: list, ret: List[str]):
    data = _selector(signature) + (abi_encode(arg_types, args) if arg_types else b"")
    out = abi_decode(ret, client.call(to, data))
    return out[0] if len(out) == 1 else out


def check_v14_submittable(client: ChainClient, call: Dict[str, Any]) -> Dict[str, Any]:
    """§8.6 — never re-broadcast a settled quote; refuse a stale nonce or a pause."""
    q = call["args"]["quote"]
    contract = call["contract"]
    spent = _read(
        client, contract, "consumedNonce(address,uint256)", ["address", "uint256"],
        [q["payer"], int(q["nonce"])], ["bool"],
    )
    expected = _read(client, contract, "payerNonce(address)", ["address"], [q["payer"]], ["uint256"])
    paused = _read(client, contract, "paused()", [], [], ["bool"])
    if paused:
        return {"submittable": False, "code": "V14_PAUSED",
                "reason": "the splitter is paused — every settlement reverts until it is unpaused"}
    if spent:
        return {"submittable": False, "code": "V14_ALREADY_SETTLED",
                "reason": f"nonce {q['nonce']} has already been spent — this quote is settled, do not pay twice"}
    if int(expected) != int(q["nonce"]):
        return {"submittable": False, "code": "V14_STALE_NONCE",
                "reason": f"this quote was signed at nonce {q['nonce']} but the contract now expects {expected}; "
                          "request a fresh quote"}
    return {"submittable": True}


# ── Execution ────────────────────────────────────────────────────────────────


@dataclass
class V14ExecutionContext:
    client: ChainClient
    account: Any  # eth_account LocalAccount: .address and .sign_transaction
    order_id: str
    expected_merchant: str
    expected_gross_amount: int
    max_gas_wei: int
    on_prepared: Callable[[Dict[str, str]], None]
    expected_token: Optional[str] = None  # None / address(0) = native POL
    min_seconds_remaining: Optional[int] = None


def _quote_args(q: Dict[str, Any]) -> tuple:
    return (
        q["payer"], q["merchant"], q["token"], int(q["grossAmount"]), q["ipCreator"],
        int(q["validUntil"]), bytes.fromhex(q["orderIdHash"][2:]), int(q["nonce"]),
        bytes.fromhex(q["routeId"][2:]),
    )


def _settle_data(function: str, q: Dict[str, Any], signature: str) -> bytes:
    return _selector(function) + abi_encode(
        [_QUOTE_TUPLE, "bytes"], [_quote_args(q), bytes.fromhex(signature[2:])]
    )


def _recover_quote_signer(deployment: Dict[str, Any], q: Dict[str, Any], signature: str) -> str:
    typed = {
        "types": {
            "EIP712Domain": [
                {"name": "name", "type": "string"},
                {"name": "version", "type": "string"},
                {"name": "chainId", "type": "uint256"},
                {"name": "verifyingContract", "type": "address"},
            ],
            "Quote": [{"name": n, "type": t} for n, t in QUOTE_FIELDS],
        },
        "primaryType": "Quote",
        "domain": {
            "name": "B2BSplitterV14",
            "version": "1",
            "chainId": deployment["chainId"],
            "verifyingContract": deployment["splitter"]["address"],
        },
        "message": {
            "payer": q["payer"], "merchant": q["merchant"], "token": q["token"],
            "grossAmount": int(q["grossAmount"]), "ipCreator": q["ipCreator"],
            "validUntil": int(q["validUntil"]), "orderIdHash": q["orderIdHash"],
            "nonce": int(q["nonce"]), "routeId": q["routeId"],
        },
    }
    return Account.recover_message(encode_typed_data(full_message=typed), signature=signature)


def _payment_id(q: Dict[str, Any]) -> str:
    return _hex(keccak(abi_encode([t for _, t in QUOTE_FIELDS], list(_quote_args(q)))))


def _payments_in(receipt: Dict[str, Any], contract: str) -> List[Dict[str, Any]]:
    out = []
    for log in receipt.get("logs") or []:
        topics = log.get("topics") or []
        if _lc(log.get("address")) != _lc(contract) or len(topics) != 4 or _lc(topics[0]) != _PAYMENT_TOPIC:
            continue
        try:
            fields = abi_decode(
                ["address", "uint256", "uint256", "uint256", "uint256", "uint256", "bytes32", "bytes32"],
                bytes.fromhex(str(log["data"])[2:]),
            )
        except Exception:
            continue
        out.append({
            "paymentId": _lc(topics[1]), "payer": "0x" + _lc(topics[2])[-40:], "merchant": "0x" + _lc(topics[3])[-40:],
            "token": _lc(fields[0]), "grossAmount": fields[1], "merchantAmount": fields[2],
            "treasuryAmount": fields[3], "ipCreatorAmount": fields[4], "validUntil": fields[5],
            "routeId": _hex(fields[6]), "orderIdHash": _hex(fields[7]),
        })
    return out


def _sign(account: Any, tx: Dict[str, Any]) -> bytes:
    signed = account.sign_transaction(tx)
    raw = getattr(signed, "raw_transaction", None) or getattr(signed, "rawTransaction")
    return bytes(raw)


def _gas_with_margin(estimate: int) -> int:
    return (estimate * 120 + 99) // 100


def _ensure_exact_approval(ctx: V14ExecutionContext, deployment: Dict[str, Any], token: str,
                           spender: str, gross: int) -> int:
    """Approve exactly ``gross`` when the allowance is short; return the gas cost committed."""
    c = ctx.client
    me = ctx.account.address
    allowed = _read(c, deployment["splitter"]["tokenList"], "isAllowed(address)", ["address"], [token], ["bool"])
    decimals = _read(c, token, "decimals()", [], [], ["uint8"])
    held = _read(c, token, "balanceOf(address)", ["address"], [me], ["uint256"])
    current = _read(c, token, "allowance(address,address)", ["address", "address"], [me, spender], ["uint256"])
    if not allowed:
        _fail("V14_TOKEN_NOT_ALLOWED", "the splitter's tokenList no longer allows this token")
    if int(decimals) != 6:
        _fail("V14_TOKEN_DECIMALS", "token decimals differ from the 6 the quote is priced in")
    if held < gross:
        _fail("V14_INSUFFICIENT_BALANCE", "token balance cannot cover the authorized gross")
    if current >= gross:
        return 0
    data = _selector("approve(address,uint256)") + abi_encode(["address", "uint256"], [spender, gross])
    c.call(token, data, sender=me)  # simulate
    estimate = c.estimate_gas(me, token, data)
    max_fee, priority = c.fees()
    nonce = c.pending_nonce(me)
    native = c.pending_balance(me)
    gas = _gas_with_margin(estimate)
    approval_cost = gas * max_fee
    worst_case = approval_cost + STABLE_SETTLE_GAS_BOUND * max_fee
    if gas <= 0 or max_fee <= 0 or worst_case > ctx.max_gas_wei:
        _fail("V14_GAS_BUDGET_EXCEEDED", "approval plus settlement gas exceeds the operator gas budget")
    if native < worst_case:
        _fail("V14_INSUFFICIENT_BALANCE", "native balance cannot cover approval and settlement gas")
    raw = _sign(ctx.account, {
        "type": 2, "chainId": deployment["chainId"], "to": token, "value": 0, "data": data,
        "gas": gas, "maxFeePerGas": max_fee, "maxPriorityFeePerGas": priority, "nonce": nonce,
    })
    try:
        tx_hash = c.send_raw_transaction(raw)
        receipt = c.wait_for_receipt(tx_hash)
    except Exception:
        # Nothing has been paid. Retrying reads the allowance and continues.
        _fail("V14_APPROVAL_PENDING", "token approval outcome unknown; no payment was made — retry the purchase")
    if int(receipt.get("status", 0)) != 1:
        _fail("V14_APPROVAL_FAILED", "token approval reverted; no payment was made")
    after = _read(c, token, "allowance(address,address)", ["address", "address"], [me, spender], ["uint256"])
    if after < gross:
        _fail("V14_APPROVAL_FAILED", "allowance is still below the authorized gross after approval")
    return approval_cost


def execute_v14_settlement(call: Dict[str, Any], ctx: V14ExecutionContext) -> Dict[str, str]:
    """Check a signed v1.4 call against independent pins, then settle it.

    The prepared settlement is handed to ``ctx.on_prepared`` BEFORE it is sent;
    if that raises, nothing is broadcast. Any unknown outcome after sending
    raises :class:`SettlementConfirmationPending` with the exact hash.
    """
    if (
        not ctx.order_id
        or not ctx.expected_merchant
        or not isinstance(ctx.expected_gross_amount, int)
        or ctx.expected_gross_amount <= 0
        or not isinstance(ctx.max_gas_wei, int)
        or ctx.max_gas_wei <= 0
        or not callable(ctx.on_prepared)
    ):
        _fail("V14_SETTLEMENT_DISABLED", "v1.4 execution requires an authorized order, merchant, exact gross, "
                                         "gas cap and durable prepared-transaction journal")
    call = copy.deepcopy(call)
    q = (call.get("args") or {}).get("quote")
    if not q:
        _fail("V14_MALFORMED", "missing quote")
    account_address = getattr(ctx.account, "address", None)
    for a in (call.get("contract"), q.get("payer"), q.get("merchant"), q.get("token"), q.get("ipCreator"),
              account_address, ctx.expected_merchant):
        if not a or not is_address(a):
            _fail("V14_MALFORMED", "invalid address")
    for v in (q.get("grossAmount"), q.get("validUntil"), q.get("nonce"), call.get("value_wei")):
        if not isinstance(v, str) or not _UINT.match(v) or int(v) >= 2**256:
            _fail("V14_MALFORMED", "invalid uint256")
    if not _BYTES32.match(str(q.get("orderIdHash"))) or not _BYTES32.match(str(q.get("routeId"))):
        _fail("V14_MALFORMED", "invalid bytes32")
    if ctx.min_seconds_remaining is not None and ctx.min_seconds_remaining < 30:
        _fail("V14_MALFORMED", "expiry headroom must be at least 30 seconds")
    validated = validate_v14_settlement_call(
        call, order_id=ctx.order_id, payer=account_address, min_seconds_remaining=ctx.min_seconds_remaining
    )
    stable = _lc(q["token"]) != ZERO
    if (
        call.get("route") != validated["route"]
        or call.get("arg_encoding") != "struct+signature"
        or call.get("function") != (STABLE_FUNCTION if stable else NATIVE_FUNCTION)
        or list(call.get("field_order") or []) != [n for n, _ in QUOTE_FIELDS]
    ):
        _fail("V14_CALL_MISMATCH", "route, method or quote field order disagrees with the supported ABI")
    if _lc(q["ipCreator"]) != ZERO or (not stable and call.get("asset") != "POL"):
        _fail("V14_UNSUPPORTED_ASSET", "This executor supports native POL or a pinned stablecoin, without creator payments")
    if _lc(ctx.expected_token or ZERO) != _lc(q["token"]):
        _fail("V14_PURCHASE_MISMATCH", "signed token does not match the authorized purchase")
    if (
        _lc(q["merchant"]) == ZERO
        or _lc(q["merchant"]) != _lc(ctx.expected_merchant)
        or int(q["grossAmount"]) != ctx.expected_gross_amount
    ):
        _fail("V14_PURCHASE_MISMATCH", "signed merchant or gross does not match the authorized purchase")
    if call.get("nonce_at_signing") is not None and str(call["nonce_at_signing"]) != q["nonce"]:
        _fail("V14_MALFORMED", "nonce metadata disagrees with signed quote")
    deployment = V14_DEPLOYMENTS.get(call.get("chain"))
    if (
        call.get("chain") not in ("polygon", "amoy")
        or not deployment
        or deployment["status"] != "enabled"
        or not deployment["settlementEnabled"]
        or _lc(call["contract"]) != _lc(deployment["splitter"]["address"])
    ):
        _fail("V14_UNTRUSTED_DEPLOYMENT", "settlement target is not an enabled pinned deployment")
    if stable:
        pinned = next((a for a in deployment["splitter"]["assets"] if _lc(a["address"]) == _lc(q["token"])), None)
        if not pinned or pinned["symbol"] != call.get("asset"):
            _fail("V14_UNSUPPORTED_ASSET", "token is not a pinned stablecoin for this deployment")
        approval = call.get("approval") or {}
        if (
            _lc(approval.get("token")) != _lc(q["token"])
            or _lc(approval.get("spender")) != _lc(deployment["splitter"]["address"])
            or str(approval.get("amount")) != q["grossAmount"]
        ):
            _fail("V14_APPROVAL_MISMATCH", "approval must be exactly the signed gross, to the pinned splitter")
    if not callable(getattr(ctx.account, "sign_transaction", None)):
        _fail("V14_LOCAL_SIGNER_REQUIRED", "A matching local signer is required for recoverable broadcast")

    c = ctx.client
    if c.chain_id() != deployment["chainId"]:
        _fail("V14_CHAIN_MISMATCH", "RPC chain differs from pinned deployment")
    code = c.get_code(call["contract"])
    if not code or _hex(keccak(code)) != _lc(deployment["runtimeCodeHash"]):
        _fail("V14_RUNTIME_MISMATCH", "splitter bytecode does not match independently pinned runtime")
    try:
        signer = _recover_quote_signer(deployment, q, call["args"]["signature"])
    except Exception:
        _fail("V14_BAD_SIGNATURE", "quote signature cannot be recovered")
    if _lc(signer) != _lc(deployment["splitter"]["signer"]):
        _fail("V14_UNTRUSTED_SIGNER", "quote signer does not match independent deployment pin")

    contract = call["contract"]
    profiles = _read(c, contract, "profiles()", [], [], ["address"])
    token_list = _read(c, contract, "tokenList()", [], [], ["address"])
    treasury = _read(c, contract, "treasury()", [], [], ["address"])
    signer_role = _read(
        c, contract, "hasRole(bytes32,address)", ["bytes32", "address"],
        [keccak(text="SIGN_OPERATOR_ROLE"), deployment["splitter"]["signer"]], ["bool"],
    )
    treasury_bps, creator_bps, enabled, _configured_at, route_treasury = _read(
        c, deployment["splitter"]["profiles"], "getProfile(bytes32)", ["bytes32"],
        [bytes.fromhex(q["routeId"][2:])], ["(uint16,uint16,bool,uint64,address)"],
    )
    preflight = check_v14_submittable(c, call)
    if (
        _lc(profiles) != _lc(deployment["splitter"]["profiles"])
        or _lc(token_list) != _lc(deployment["splitter"]["tokenList"])
        or _lc(treasury) != _lc(deployment["splitter"]["treasury"])
        or not signer_role
    ):
        _fail("V14_DEPLOYMENT_STATE_MISMATCH", "satellite, treasury or signer role differs from deployment pin")
    effective_treasury = treasury if _lc(route_treasury) == ZERO else route_treasury
    if (
        not enabled
        or treasury_bps != (100 if validated["route"] == "merchant-aifp1" else 0)
        or creator_bps != 0
        or _lc(effective_treasury) != _lc(deployment["splitter"]["treasury"])
    ):
        _fail("V14_PROFILE_MISMATCH", "current profile differs from accepted route economics")
    if not preflight["submittable"]:
        _fail(preflight["code"], preflight["reason"])

    me = ctx.account.address
    gross = int(q["grossAmount"])
    function = STABLE_FUNCTION if stable else NATIVE_FUNCTION
    value = 0 if stable else gross
    approval_cost = _ensure_exact_approval(ctx, deployment, q["token"], contract, gross) if stable else 0
    data = _settle_data(function, q, call["args"]["signature"])
    c.call(contract, data, sender=me, value=value)  # simulate
    estimate = c.estimate_gas(me, contract, data, value)
    max_fee, priority = c.fees()
    nonce = c.pending_nonce(me)
    balance = c.pending_balance(me)
    gas = _gas_with_margin(estimate)
    if gas <= 0 or max_fee <= 0 or priority < 0 or priority > max_fee or approval_cost + gas * max_fee > ctx.max_gas_wei:
        _fail("V14_GAS_BUDGET_EXCEEDED", "estimated maximum transaction fee exceeds the operator gas budget")
    if balance < value + gas * max_fee:
        _fail("V14_INSUFFICIENT_BALANCE", "balance cannot cover authorized gross and maximum gas")
    # Check the deadline again after slow RPCs, before signing or persisting anything.
    validate_v14_settlement_call(call, order_id=ctx.order_id, payer=me, min_seconds_remaining=ctx.min_seconds_remaining)
    raw = _sign(ctx.account, {
        "type": 2, "chainId": deployment["chainId"], "to": contract, "value": value, "data": data,
        "gas": gas, "maxFeePerGas": max_fee, "maxPriorityFeePerGas": priority, "nonce": nonce,
    })
    tx_hash = _hex(keccak(raw))
    ctx.on_prepared({"hash": tx_hash, "serialized_transaction": _hex(raw)})
    # From here every unknown result refers to this exact signed transaction.
    try:
        returned = c.send_raw_transaction(raw)
        if _lc(returned) != _lc(tx_hash):
            raise RuntimeError("RPC returned a different transaction hash")
    except Exception:
        raise SettlementConfirmationPending(tx_hash)
    try:
        receipt = c.wait_for_receipt(tx_hash)
    except Exception:
        raise SettlementConfirmationPending(tx_hash)
    if _lc(receipt.get("transactionHash")) != _lc(tx_hash) or receipt.get("status") not in (0, 1):
        raise SettlementConfirmationPending(tx_hash)
    if receipt["status"] == 0:
        _fail("V14_TRANSACTION_REVERTED", f"transaction {tx_hash} reverted; gas may have been charged")
    payments = _payments_in(receipt, contract)
    pid = _lc(_payment_id(q))
    ok = len(payments) == 1 and any(
        p["paymentId"] == pid
        and p["payer"] == _lc(q["payer"])
        and p["merchant"] == _lc(q["merchant"])
        and p["token"] == _lc(q["token"])
        and p["grossAmount"] == gross
        and p["validUntil"] == int(q["validUntil"])
        and _lc(p["routeId"]) == _lc(q["routeId"])
        and _lc(p["orderIdHash"]) == _lc(q["orderIdHash"])
        and p["merchantAmount"] + p["treasuryAmount"] + p["ipCreatorAmount"] == gross
        for p in payments
    )
    if not ok:
        # Mined, but the payment evidence is inconclusive: keep the hash, never pay again.
        raise SettlementConfirmationPending(tx_hash)
    return {"hash": tx_hash, "route": validated["route"]}
