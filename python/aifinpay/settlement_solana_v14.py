"""Owner-selected Solana v1.4, classic SPL, exact wire and same-signature recovery.

Inventory does not authorize public settlement. The canonical records remain
disabled. No legacy program, replacement transaction or custody fallback.
"""

import base64
import hashlib
import struct
import time
from dataclasses import dataclass

from eth_keys.datatypes import Signature
from eth_utils import keccak
from solders.compute_budget import set_compute_unit_limit
from solders.hash import Hash
from solders.instruction import AccountMeta, Instruction
from solders.message import Message
from solders.pubkey import Pubkey
from solders.transaction import Transaction

from ._solana_v14_deployments import SOLANA_V14_DEPLOYMENTS

ZERO = "11111111111111111111111111111111"
TOKEN = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA"
ATA = "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"
LOADER = "BPFLoaderUpgradeab1e11111111111111111111111"
GENESIS = {
    "mainnet": "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d",
    "devnet": "EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG",
}
# Official Circle addresses/Tether WDK pins; runtime mint and whitelist checks
# are still required. No invented devnet USDT.
STABLES = {
    "mainnet": {
        "USDC": "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
        "USDT": "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    },
    "devnet": {"USDC": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU"},
}
FIELDS = ["payer", "merchant", "token", "grossAmount", "ipCreator", "validUntil", "orderIdHash", "nonce", "routeId"]
DISCS = {
    "config": bytes([155, 12, 170, 224, 30, 250, 204, 130]),
    "payerNonce": bytes([239, 33, 176, 46, 128, 49, 65, 40]),
    "consumedNonce": bytes([203, 122, 100, 36, 241, 214, 161, 246]),
    "profiles": bytes([226, 221, 186, 252, 104, 74, 245, 98]),
    "tokenList": bytes([145, 167, 153, 173, 5, 187, 157, 150]),
}
NATIVE_DISC = bytes([117, 220, 69, 41, 231, 241, 119, 57])
STABLE_DISC = bytes([122, 84, 19, 134, 147, 115, 154, 207])


class SolanaV14Error(Exception):
    def __init__(self, message, code="SOLANA_V14_INVALID", prepared=None, actual_fee_lamports=None):
        super().__init__(message)
        self.code, self.prepared = code, prepared
        self.actual_fee_lamports = actual_fee_lamports


def lamport_cost_usd(lamports, rate):
    import re

    if (
        type(lamports) is not int
        or lamports < 0
        or not isinstance(rate, str)
        or not re.fullmatch(r"(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?", rate)
    ):
        raise SolanaV14Error("invalid exact SOL/USD admission rate")
    whole, _, fraction = rate.partition(".")
    numerator, denominator = int(whole + fraction), 10 ** len(fraction) * 10**9
    if not 0 < float(rate) < 100000 or numerator <= 0:
        raise SolanaV14Error("invalid independently sourced SOL/USD rate")
    micros = (lamports * numerator * 10**6 + denominator - 1) // denominator
    if micros > 2**53 - 1:
        raise SolanaV14Error("unsafe USD fee accounting")
    return micros / 10**6


def _key(value):
    try:
        k = Pubkey.from_string(value)
        if str(k) != value:
            raise ValueError()
        return k
    except (ValueError, TypeError):
        raise SolanaV14Error("invalid canonical Solana key") from None


def _integer(value, bits=64):
    import re

    if not isinstance(value, str) or not re.fullmatch(r"0|[1-9][0-9]*", value) or int(value) >= 2**bits:
        raise SolanaV14Error("invalid exact integer")
    return int(value)


def _hex32(value):
    import re

    if not isinstance(value, str) or not re.fullmatch(r"0x[0-9a-f]{64}", value):
        raise SolanaV14Error("invalid canonical bytes32")
    return bytes.fromhex(value[2:])


def encode_quote(q):
    return b"".join(
        [
            bytes(_key(q["payer"])),
            bytes(_key(q["merchant"])),
            bytes(_key(q["token"])),
            struct.pack("<Q", _integer(q["grossAmount"])),
            bytes(_key(q["ipCreator"])),
            struct.pack("<q", _integer(q["validUntil"], 63)),
            _hex32(q["orderIdHash"]),
            struct.pack("<Q", _integer(q["nonce"])),
            _hex32(q["routeId"]),
        ]
    )


def quote_digest(program_id, q):
    return hashlib.sha256(b"AiFinPay-Solana-v1.4" + bytes(_key(program_id)) + encode_quote(q)).digest()


def payment_id(q):
    return "0x" + hashlib.sha256(encode_quote(q)).hexdigest()


def creator_placeholder(program_id, payer):
    return str(
        Pubkey.from_bytes(
            hashlib.sha256(
                b"AiFinPay Solana creator placeholder v1" + bytes(_key(program_id)) + bytes(_key(payer))
            ).digest()
        )
    )


def inventory(environment, network):
    d = SOLANA_V14_DEPLOYMENTS.get(network)
    if not d or environment not in ("prod", "dev") or d["environment"] != environment:
        raise SolanaV14Error("Solana environment/network mismatch")
    return d


def authorized_inventory(environment, network):
    d = inventory(environment, network)
    if not d["settlementEnabled"] or d["status"] != "enabled":
        raise SolanaV14Error("Solana settlement disabled: " + d.get("disabledReason", "not accepted"))
    return d


def stable_mint(network, asset):
    mint = STABLES.get(network, {}).get(asset)
    if not mint:
        raise SolanaV14Error("asset is not independently pinned for this Solana network")
    return mint


def pdas(program_id, payer, nonce):
    program, p = _key(program_id), bytes(_key(payer))
    return {
        name: Pubkey.find_program_address(seeds, program)[0]
        for name, seeds in {
            "config": [b"config"],
            "profiles": [b"profiles-index"],
            "tokenList": [b"token-list"],
            "payerNonce": [b"payer-nonce", p],
            "consumedNonce": [b"consumed-nonce", p, struct.pack("<Q", _integer(nonce))],
        }.items()
    }


def associated_token(owner, mint):
    return Pubkey.find_program_address([bytes(_key(owner)), bytes(_key(TOKEN)), bytes(_key(mint))], _key(ATA))[0]


def validate_call(call, d, payer, order_id, historical=False):
    q = call.get("args", {}).get("quote") or {}
    native = call.get("asset") == "SOL"
    try:
        sig = bytes.fromhex(call["args"]["signature"][2:])
        sig_ok = (
            len(sig) == 65
            and sig[64] in (27, 28)
            and 0
            < int.from_bytes(sig[32:64], "big")
            <= 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0
        )
        if (
            call.get("chain") != "solana"
            or call.get("network") != d["network"]
            or call.get("contract") != d["programId"]
            or call.get("idl_sha256") != d["idl"]["sha256"]
            or call.get("splitter_version") != "1.4"
            or call.get("route") != "merchant-aifp1"
            or call.get("arg_encoding") != "borsh-quote+signature"
            or call.get("bound_to_payer") is not True
            or call.get("field_order") != FIELDS
            or q["payer"] != payer
            or q["ipCreator"] != ZERO
            or q["merchant"] in (ZERO, payer)
            or q["orderIdHash"] != "0x" + keccak(text=order_id).hex()
            or q["routeId"] != "0x" + keccak(text="merchant-aifp1").hex()
            or _integer(q["grossAmount"]) < 100
            or not sig_ok
            or not call["args"]["signature"].startswith("0x")
            or call.get("function") != ("settle_native" if native else "settle_stable")
            or q["token"] != (ZERO if native else stable_mint(d["network"], call["asset"]))
            or (call.get("value_lamports") != q["grossAmount"] if native else "value_lamports" in call)
            or "approval" in call
        ):
            raise SolanaV14Error("Solana signed-call binding mismatch")
        encode_quote(q)
        if not historical and not time.time() < _integer(q["validUntil"], 63) <= time.time() + 3600:
            raise SolanaV14Error("Solana quote expired or exceeds lifetime")
    except (KeyError, ValueError, TypeError):
        raise SolanaV14Error("invalid Solana call") from None


def settle_instruction(call, treasury):
    q, native = call["args"]["quote"], call["asset"] == "SOL"
    p = {k: str(v) for k, v in pdas(call["contract"], q["payer"], q["nonce"]).items()}
    a = (
        {
            "config": p["config"],
            "payerNonce": p["payerNonce"],
            "consumedNonce": p["consumedNonce"],
            "payer": q["payer"],
            "merchant": q["merchant"],
            "treasury": treasury,
            "ipCreator": creator_placeholder(call["contract"], q["payer"]),
            "profiles": p["profiles"],
            "systemProgram": ZERO,
        }
        if native
        else {
            "config": p["config"],
            "payerNonce": p["payerNonce"],
            "consumedNonce": p["consumedNonce"],
            "payer": q["payer"],
            "tokenList": p["tokenList"],
            "mint": q["token"],
            "profiles": p["profiles"],
            "tokenProgram": TOKEN,
            "systemProgram": ZERO,
        }
    )
    remaining = (
        [] if native else [str(associated_token(owner, q["token"])) for owner in (q["payer"], q["merchant"], treasury)]
    )
    if (
        call.get("accounts") != a
        or call.get("treasury_owner") != treasury
        or call.get("remaining_accounts", []) != remaining
    ):
        raise SolanaV14Error("Solana account metas/remaining order mismatch")
    writable = [True] * 8 + [False] if native else [False, True, True, True, False, False, True, False, False]
    metas = [AccountMeta(_key(address), i == 3, writable[i]) for i, address in enumerate(a.values())]
    metas += [AccountMeta(_key(address), False, True) for address in remaining]
    return Instruction(
        _key(call["contract"]),
        (NATIVE_DISC if native else STABLE_DISC)
        + struct.pack("<Q", _integer(q["nonce"]))
        + encode_quote(q)
        + bytes.fromhex(call["args"]["signature"][2:]),
        metas,
    )


def _create_ata(payer, owner, mint):
    return Instruction(
        _key(ATA),
        b"\x01",
        [
            AccountMeta(_key(payer), True, True),
            AccountMeta(associated_token(owner, mint), False, True),
            AccountMeta(_key(owner), False, False),
            AccountMeta(_key(mint), False, False),
            AccountMeta(_key(ZERO), False, False),
            AccountMeta(_key(TOKEN), False, False),
        ],
    )


class SolanaRpc:
    def __init__(self, url, session):
        self.url, self.session = url, session

    def request(self, method, params):
        r = self.session.post(
            self.url,
            json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params},
            timeout=15,
            allow_redirects=False,
        )
        data = r.json()
        if not r.ok or data.get("error") or "result" not in data:
            raise SolanaV14Error("Solana RPC evidence unavailable")
        return data["result"]


class SolanaPaymentAccount:
    """Local existing Ed25519 key; neither RPC nor quote can select a signer."""

    def __init__(self, keypair):
        self.keypair = keypair
        self.address = str(keypair.pubkey())

    def sign_authorization(self, message):
        return str(self.keypair.sign_message(message.encode("utf-8")))


def _rpc_int(n):
    if type(n) is not int or not 0 <= n <= 2**53 - 1:
        raise SolanaV14Error("unsafe Solana RPC integer")
    return n


def _bytes(a, owner, disc=None, size=None):
    if (
        not isinstance(a, dict)
        or a.get("owner") != owner
        or a.get("executable") is not False
        or not isinstance(a.get("data"), list)
        or len(a["data"]) != 2
        or not isinstance(a["data"][0], str)
        or a["data"][1] != "base64"
    ):
        raise SolanaV14Error("Solana account owner/encoding mismatch")
    _rpc_int(a["lamports"])
    try:
        b = base64.b64decode(a["data"][0], validate=True)
    except (ValueError, TypeError):
        raise SolanaV14Error("invalid account data") from None
    if (
        base64.b64encode(b).decode() != a["data"][0]
        or (disc and b[:8] != disc)
        or (size is not None and len(b) != size)
    ):
        raise SolanaV14Error("Solana account layout mismatch")
    return b


def _pub(b, offset):
    return str(Pubkey.from_bytes(b[offset : offset + 32]))


def _accounts(rpc, addresses):
    v = rpc.request("getMultipleAccounts", [addresses, {"encoding": "base64", "commitment": "finalized"}]).get("value")
    if not isinstance(v, list) or len(v) != len(addresses):
        raise SolanaV14Error("missing Solana accounts")
    return v


@dataclass
class SolanaPlan:
    call: dict
    deployment: dict
    payer: str
    order_id: str
    instructions: list
    blockhash: str
    last_valid_block_height: int
    transaction_fee_lamports: int
    fee_rent_lamports: int
    max_fee_lamports: int
    created_at: float


def _assert_config_signer(call, config):
    sig = bytes.fromhex(call["args"]["signature"][2:])
    recovered = Signature(signature_bytes=sig[:64] + bytes([sig[64] - 27])).recover_public_key_from_msg_hash(
        quote_digest(call["contract"], call["args"]["quote"])
    )
    if recovered.to_bytes() != config[40:104]:
        raise SolanaV14Error("quote signer does not match independently read Config")


def verify_historical_quote(call, *, rpc, deployment, payer, order_id):
    """Read-only expired unsent admission validation; not proof of payment."""
    d = deployment
    validate_call(call, d, payer, order_id, historical=True)
    settle_instruction(call, call["treasury_owner"])
    if rpc.request("getGenesisHash", []) != GENESIS[d["network"]]:
        raise SolanaV14Error("Solana RPC network mismatch")
    p = pdas(d["programId"], payer, call["args"]["quote"]["nonce"])
    program, config = _accounts(rpc, [d["programId"], str(p["config"])])
    if not program or program.get("executable") is not True or program.get("owner") != LOADER:
        raise SolanaV14Error("Solana program runtime mismatch")
    c = _bytes(config, d["programId"], DISCS["config"], 234)
    if (
        c[232] != Pubkey.find_program_address([b"config"], _key(d["programId"]))[1]
        or _pub(c, 168) != str(p["tokenList"])
        or _pub(c, 200) != str(p["profiles"])
    ):
        raise SolanaV14Error("inconsistent Solana Config")
    _assert_config_signer(call, c)


def prepare_settlement(call, *, rpc, deployment, payer, order_id, max_fee_lamports):
    d, q = deployment, call["args"]["quote"]
    validate_call(call, d, payer, order_id)
    if type(max_fee_lamports) is not int or max_fee_lamports <= 0:
        raise SolanaV14Error("explicit Solana fee plus rent budget required")
    if rpc.request("getGenesisHash", []) != GENESIS[d["network"]]:
        raise SolanaV14Error("Solana RPC network mismatch")
    p = pdas(d["programId"], payer, q["nonce"])
    placeholder = creator_placeholder(d["programId"], payer)
    program, config, profiles, pn, cn, payer_account, placeholder_account = _accounts(
        rpc,
        [
            d["programId"],
            str(p["config"]),
            str(p["profiles"]),
            str(p["payerNonce"]),
            str(p["consumedNonce"]),
            payer,
            placeholder,
        ],
    )
    if (
        not program
        or program.get("executable") is not True
        or program.get("owner") != LOADER
        or not payer_account
        or payer_account.get("owner") != ZERO
        or payer_account.get("executable") is not False
        or (placeholder_account and placeholder_account.get("executable") is not False)
    ):
        raise SolanaV14Error("Solana program/payer/creator runtime mismatch")
    _rpc_int(program["lamports"])
    # Reserved sysvars/programs cannot satisfy the unused writable creator slot.
    if call["asset"] == "SOL" and placeholder_account:
        _bytes(placeholder_account, ZERO, size=0)

    def bump(*seeds):
        return Pubkey.find_program_address(list(seeds), _key(d["programId"]))[1]

    c = _bytes(config, d["programId"], DISCS["config"], 234)
    if (
        c[232] != bump(b"config")
        or c[233] != 0
        or _pub(c, 168) != str(p["tokenList"])
        or _pub(c, 200) != str(p["profiles"])
    ):
        raise SolanaV14Error("paused/inconsistent Solana Config")
    _assert_config_signer(call, c)
    r = _bytes(profiles, d["programId"], DISCS["profiles"])
    if len(r) < 14:
        raise SolanaV14Error("truncated ProfilesIndex")
    n = struct.unpack_from("<I", r, 8)[0]
    if n > 32 or len(r) < 12 + n * 77 + 2 or r[12 + n * 77] != n or r[13 + n * 77] != bump(b"profiles-index"):
        raise SolanaV14Error("invalid ProfilesIndex bounds")
    routes = [
        r[12 + i * 77 : 12 + (i + 1) * 77] for i in range(n) if r[12 + i * 77 : 44 + i * 77] == _hex32(q["routeId"])
    ]
    if len(routes) != 1 or struct.unpack_from("<HH", routes[0], 32) != (100, 0) or routes[0][36] != 1:
        raise SolanaV14Error("Solana merchant profile mismatch")
    treasury = _pub(routes[0], 45)
    treasury = _pub(c, 136) if treasury == ZERO else treasury
    if treasury in (ZERO, payer, q["merchant"]) or any(str(a) in (treasury, q["merchant"]) for a in p.values()):
        raise SolanaV14Error("invalid Solana recipients/profile")
    if pn:
        b = _bytes(pn, d["programId"], DISCS["payerNonce"], 49)
        if (
            _pub(b, 8) != payer
            or struct.unpack_from("<Q", b, 40)[0] != _integer(q["nonce"])
            or b[48] != bump(b"payer-nonce", bytes(_key(payer)))
        ):
            raise SolanaV14Error("Solana payer nonce mismatch")
    elif q["nonce"] != "0":
        raise SolanaV14Error("Solana nonce account missing")
    if cn:
        raise SolanaV14Error("Solana nonce marker exists; recover original purchase")

    def rent(size):
        return _rpc_int(rpc.request("getMinimumBalanceForRentExemption", [size, {"commitment": "finalized"}]))

    rent_total = (0 if pn else rent(49)) + rent(50)
    instructions = []
    if call["asset"] != "SOL":
        tl, mint, *tokens = _accounts(
            rpc,
            [str(p["tokenList"]), q["token"]]
            + [str(associated_token(owner, q["token"])) for owner in (payer, q["merchant"], treasury)],
        )
        b = _bytes(tl, d["programId"], DISCS["tokenList"])
        if len(b) < 45:
            raise SolanaV14Error("truncated TokenList")
        n = struct.unpack_from("<I", b, 40)[0]
        if (
            n > 16
            or len(b) < 44 + n * 32 + 1
            or b[44 + n * 32] != bump(b"token-list")
            or q["token"] not in [_pub(b, 44 + i * 32) for i in range(n)]
        ):
            raise SolanaV14Error("mint is not allowed by current TokenList")
        m = _bytes(mint, TOKEN, size=82)
        if m[44:46] != bytes([6, 1]):
            raise SolanaV14Error("mint decimals/state mismatch")
        for i, owner in enumerate((payer, q["merchant"], treasury)):
            if not tokens[i]:
                if i == 0:
                    raise SolanaV14Error("payer SPL account missing")
                instructions.append(_create_ata(payer, owner, q["token"]))
                rent_total += rent(165)
            else:
                t = _bytes(tokens[i], TOKEN, size=165)
                if (
                    _pub(t, 0) != q["token"]
                    or _pub(t, 32) != owner
                    or t[108] != 1
                    or (i == 0 and struct.unpack_from("<Q", t, 64)[0] < _integer(q["grossAmount"]))
                ):
                    raise SolanaV14Error("SPL owner/mint/state/balance mismatch")
    latest = rpc.request("getLatestBlockhash", [{"commitment": "finalized"}])["value"]
    blockhash, height = latest["blockhash"], _rpc_int(latest["lastValidBlockHeight"])
    if placeholder in (ZERO, payer, q["merchant"], treasury, d["programId"]) or placeholder in map(str, p.values()):
        raise SolanaV14Error("Solana creator placeholder collision")
    settle = settle_instruction(call, treasury)
    instructions += [set_compute_unit_limit(1_400_000), settle]
    message = Message.new_with_blockhash(instructions, _key(payer), Hash.from_string(blockhash))
    raw = base64.b64encode(bytes(Transaction.new_unsigned(message))).decode()
    sim = rpc.request(
        "simulateTransaction", [raw, {"encoding": "base64", "sigVerify": False, "commitment": "finalized"}]
    )["value"]
    if not isinstance(sim, dict) or "err" not in sim or sim["err"] is not None:
        raise SolanaV14Error("Solana simulation failed")
    units = _rpc_int(sim.get("unitsConsumed"))
    if not 0 < units <= 1_272_727:
        raise SolanaV14Error("missing/unsafe compute estimate")
    instructions[-2] = set_compute_unit_limit((units * 110 + 99) // 100)
    message = Message.new_with_blockhash(instructions, _key(payer), Hash.from_string(blockhash))
    raw = base64.b64encode(bytes(Transaction.new_unsigned(message))).decode()
    exact = rpc.request(
        "simulateTransaction", [raw, {"encoding": "base64", "sigVerify": False, "commitment": "finalized"}]
    )["value"]
    if (
        not isinstance(exact, dict)
        or "err" not in exact
        or exact["err"] is not None
        or not 0 < _rpc_int(exact.get("unitsConsumed")) <= (units * 110 + 99) // 100
    ):
        raise SolanaV14Error("Exact final Solana message simulation failed")
    fee = _rpc_int(
        rpc.request("getFeeForMessage", [base64.b64encode(bytes(message)).decode(), {"commitment": "finalized"}])[
            "value"
        ]
    )
    cost = fee + rent_total
    if cost > max_fee_lamports or _rpc_int(payer_account["lamports"]) < cost + (
        _integer(q["grossAmount"]) if call["asset"] == "SOL" else 0
    ):
        raise SolanaV14Error("Solana fee/rent cap or native balance exceeded")
    return SolanaPlan(
        call, d, payer, order_id, instructions, blockhash, height, fee, cost, max_fee_lamports, time.time()
    )


def execute_settlement(plan, *, rpc, keypair, on_prepared):
    if (
        str(keypair.pubkey()) != plan.payer
        or time.time() - plan.created_at > 15
        or plan.fee_rent_lamports > plan.max_fee_lamports
    ):
        raise SolanaV14Error("stale/unauthorized Solana preparation")
    tx = Transaction.new_signed_with_payer(
        plan.instructions, _key(plan.payer), [keypair], Hash.from_string(plan.blockhash)
    )
    prepared = {
        "family": "solana",
        "hash": str(tx.signatures[0]),
        "serialized_transaction_base64": base64.b64encode(bytes(tx)).decode(),
        "network": plan.deployment["network"],
        "program_id": plan.deployment["programId"],
        "idl_sha256": plan.deployment["idl"]["sha256"],
        "recent_blockhash": plan.blockhash,
        "last_valid_block_height": plan.last_valid_block_height,
        "settlement_nonce": plan.call["args"]["quote"]["nonce"],
    }
    assert_prepared_recovery(plan.call, prepared, plan.deployment, plan.payer, plan.order_id)
    on_prepared(prepared)
    try:
        sig = rpc.request(
            "sendTransaction",
            [
                prepared["serialized_transaction_base64"],
                {"encoding": "base64", "skipPreflight": False, "preflightCommitment": "finalized", "maxRetries": 0},
            ],
        )
        if sig != prepared["hash"]:
            raise SolanaV14Error("RPC returned different signature")
        status = rpc.request("getSignatureStatuses", [[sig], {"searchTransactionHistory": True}])["value"][0]
        if status and status.get("confirmationStatus") == "finalized" and status.get("err") is not None:
            fee = _finalized_failure_fee(
                rpc, prepared, len(plan.instructions), plan.transaction_fee_lamports, plan.max_fee_lamports, status
            )
            raise SolanaV14Error(
                "Original Solana transaction finalized with failure; fee retained",
                "SOLANA_V14_TRANSACTION_REVERTED",
                prepared,
                fee,
            )
        if not status or status.get("confirmationStatus") != "finalized":
            raise SolanaV14Error("confirmation pending")
        return prepared
    except Exception as e:
        if isinstance(e, SolanaV14Error) and e.code == "SOLANA_V14_TRANSACTION_REVERTED":
            raise
        raise SolanaV14Error(
            "Unknown outcome; recover original signature without resending", "SOLANA_V14_PENDING", prepared
        ) from e


def _valid_failure(error, instruction_count):
    if not isinstance(error, dict) or set(error) != {"InstructionError"}:
        return False
    value = error["InstructionError"]
    if (
        not isinstance(value, list)
        or len(value) != 2
        or type(value[0]) is not int
        or not 0 <= value[0] < instruction_count
    ):
        return False
    if isinstance(value[1], str):
        return value[1] in {
            "InvalidArgument",
            "InvalidInstructionData",
            "InvalidAccountData",
            "AccountDataTooSmall",
            "InsufficientFunds",
            "IncorrectProgramId",
            "MissingRequiredSignature",
            "AccountAlreadyInitialized",
            "UninitializedAccount",
            "NotEnoughAccountKeys",
            "AccountBorrowFailed",
            "MaxSeedLengthExceeded",
            "InvalidSeeds",
            "ComputationalBudgetExceeded",
            "ProgramFailedToComplete",
            "PrivilegeEscalation",
            "InvalidAccountOwner",
        }
    return (
        isinstance(value[1], dict)
        and set(value[1]) == {"Custom"}
        and type(value[1]["Custom"]) is int
        and 0 <= value[1]["Custom"] <= 0xFFFFFFFF
    )


def _finalized_failure_fee(rpc, prepared, instruction_count, transaction_fee_lamports, max_fee_lamports, status):
    if rpc.request("getGenesisHash", []) != GENESIS[prepared["network"]]:
        raise SolanaV14Error("failure proof changed Solana genesis")
    result = rpc.request(
        "getTransaction",
        [prepared["hash"], {"encoding": "base64", "commitment": "finalized", "maxSupportedTransactionVersion": 0}],
    )
    if (
        not isinstance(result, dict)
        or result.get("version") != "legacy"
        or _rpc_int(result.get("slot")) != _rpc_int(status.get("slot"))
        or result.get("transaction") != [prepared["serialized_transaction_base64"], "base64"]
        or not isinstance(result.get("meta"), dict)
        or not _valid_failure(result["meta"].get("err"), instruction_count)
        or result["meta"]["err"] != status.get("err")
    ):
        raise SolanaV14Error("missing exact finalized Solana failure transaction")
    fee = _rpc_int(result["meta"].get("fee"))
    if fee > transaction_fee_lamports or fee > max_fee_lamports:
        raise SolanaV14Error("failure fee exceeds original preflight cap")
    block = rpc.request(
        "getBlock",
        [
            result["slot"],
            {
                "encoding": "base64",
                "commitment": "finalized",
                "transactionDetails": "full",
                "rewards": False,
                "maxSupportedTransactionVersion": 0,
            },
        ],
    )
    if (
        not isinstance(block, dict)
        or _rpc_int(block.get("parentSlot")) >= result["slot"]
        or _rpc_int(block.get("blockHeight")) == 0
        or not isinstance(block.get("transactions"), list)
    ):
        raise SolanaV14Error("missing canonical finalized Solana failure block")
    _key(block.get("blockhash"))
    _key(block.get("previousBlockhash"))
    matches = [
        t for t in block["transactions"] if isinstance(t, dict) and t.get("transaction") == result["transaction"]
    ]
    if (
        len(matches) != 1
        or not isinstance(matches[0].get("meta"), dict)
        or matches[0]["meta"].get("fee") != fee
        or matches[0]["meta"].get("err") != result["meta"]["err"]
    ):
        raise SolanaV14Error("failed signature is not included in canonical block")
    return fee


def read_finalized_failure(
    call, prepared, *, rpc, deployment, payer, order_id, transaction_fee_lamports, max_fee_lamports
):
    """Read-only exact original signature reconciliation, without a new payer signature."""
    assert_prepared_recovery(call, prepared, deployment, payer, order_id)
    if (
        type(transaction_fee_lamports) is not int
        or type(max_fee_lamports) is not int
        or not 0 <= transaction_fee_lamports <= max_fee_lamports
        or max_fee_lamports <= 0
    ):
        raise SolanaV14Error("invalid persisted Solana fee caps")
    status = rpc.request("getSignatureStatuses", [[prepared["hash"]], {"searchTransactionHistory": True}])["value"][0]
    if not status or status.get("confirmationStatus") != "finalized" or status.get("err") is None:
        return None
    tx = Transaction.from_bytes(base64.b64decode(prepared["serialized_transaction_base64"]))
    return _finalized_failure_fee(
        rpc, prepared, len(tx.message.instructions), transaction_fee_lamports, max_fee_lamports, status
    )


def assert_prepared_recovery(call, p, d, payer, order_id):
    validate_call(call, d, payer, order_id, historical=True)
    if (
        p.get("family") != "solana"
        or p.get("network") != d["network"]
        or p.get("program_id") != d["programId"]
        or p.get("idl_sha256") != d["idl"]["sha256"]
        or p.get("settlement_nonce") != call["args"]["quote"]["nonce"]
        or type(p.get("last_valid_block_height")) is not int
        or p["last_valid_block_height"] < 0
    ):
        raise SolanaV14Error("Solana recovery identity mismatch")
    try:
        raw = base64.b64decode(p["serialized_transaction_base64"], validate=True)
        if len(raw) > 1232 or base64.b64encode(raw).decode() != p["serialized_transaction_base64"]:
            raise ValueError()
        tx = Transaction.from_bytes(raw)
        tx.verify()
        msg = tx.message
        if (
            len(tx.signatures) != 1
            or str(tx.signatures[0]) != p["hash"]
            or str(msg.account_keys[0]) != payer
            or str(msg.recent_blockhash) != p["recent_blockhash"]
        ):
            raise ValueError()
        expected = settle_instruction(call, call["treasury_owner"])
        last = msg.instructions[-1]
        if last != msg.compile_instruction(expected):
            raise ValueError()
        compute = 0
        for ix in msg.instructions[:-1]:
            program = str(msg.account_keys[ix.program_id_index])
            if program == "ComputeBudget111111111111111111111111111111":
                compute += 1
                if (
                    compute != 1
                    or len(ix.data) != 5
                    or ix.data[0] != 2
                    or not 0 < struct.unpack_from("<I", ix.data, 1)[0] <= 1_400_000
                ):
                    raise ValueError()
            elif call["asset"] == "SOL" or not any(
                ix == msg.compile_instruction(_create_ata(payer, owner, call["args"]["quote"]["token"]))
                for owner in (call["args"]["quote"]["merchant"], call["treasury_owner"])
            ):
                raise ValueError()
        if compute != 1 or len(msg.instructions) > 4 or msg.header.num_required_signatures != 1:
            raise ValueError()
        canonical = []
        for ix in msg.instructions[:-1]:
            if str(msg.account_keys[ix.program_id_index]) == "ComputeBudget111111111111111111111111111111":
                canonical.append(set_compute_unit_limit(struct.unpack_from("<I", ix.data, 1)[0]))
            else:
                canonical.append(
                    next(
                        _create_ata(payer, owner, call["args"]["quote"]["token"])
                        for owner in (call["args"]["quote"]["merchant"], call["treasury_owner"])
                        if ix == msg.compile_instruction(_create_ata(payer, owner, call["args"]["quote"]["token"]))
                    )
                )
        canonical.append(expected)
        if bytes(Message.new_with_blockhash(canonical, _key(payer), msg.recent_blockhash)) != bytes(msg):
            raise ValueError("message privileges/order mismatch")
        if bytes(tx) != raw:
            raise ValueError()
    except Exception as e:
        raise SolanaV14Error("Solana signed-message recovery mismatch") from e
