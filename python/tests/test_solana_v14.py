"""Actual local Solana signing, public paid-access dispatch and durable recovery.

RPC/account bytes are synthetic, never live. Quote and receipt signatures are
real local test signatures; this does not attest production program execution.
"""

import base64
import copy
import hashlib
import json
import struct
import subprocess
import sys
import time
from pathlib import Path

import base58
import nacl.signing
import pytest
from eth_keys import keys
from eth_utils import keccak
from solders.keypair import Keypair
from solders.pubkey import Pubkey
from solders.transaction import Transaction

from aifinpay import AiFinPayAgent
from aifinpay import aifp1 as a
from aifinpay import settlement_solana_v14 as s

API = "https://api.aifinpay.io"
SHOP = "https://merchant.example"
RPC = "https://solana.example"
PAYER = Keypair.from_seed(bytes([0x42]) * 32)
MERCHANT = str(Keypair.from_seed(bytes([2]) * 32).pubkey())
TREASURY = str(Keypair.from_seed(bytes([3]) * 32).pubkey())
QUOTE_SIGNER = keys.PrivateKey(bytes([7]) * 32)  # Synthetic and never funded.
ISSUER = nacl.signing.SigningKey(bytes([9]) * 32)


def iso(unix):
    return time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime(unix))


def b64url(raw):
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode()


class Response:
    def __init__(self, body, status=200):
        self.body, self.status_code, self.ok = body, status, 200 <= status < 300
        self.text = json.dumps(body)

    def json(self):
        return self.body


class Fixture:
    def __init__(self, asset="SOL"):
        self.asset = asset
        self.headers = {}
        self.d = copy.deepcopy(s.inventory("prod", "mainnet"))
        payer = str(PAYER.pubkey())
        expiry = int(time.time()) + 600
        q = {
            "payer": payer,
            "merchant": MERCHANT,
            "token": s.ZERO if asset == "SOL" else s.stable_mint("mainnet", asset),
            "grossAmount": "1000000" if asset == "SOL" else "100000",
            "ipCreator": s.ZERO,
            "validUntil": str(expiry),
            "orderIdHash": "0x" + keccak(text="qt_solana").hex(),
            "nonce": "0",
            "routeId": "0x" + keccak(text="merchant-aifp1").hex(),
        }
        sig = QUOTE_SIGNER.sign_msg_hash(s.quote_digest(self.d["programId"], q)).to_bytes()
        self.pdas = s.pdas(self.d["programId"], payer, "0")
        p = {k: str(v) for k, v in self.pdas.items()}
        accounts = {
            "config": p["config"],
            "payerNonce": p["payerNonce"],
            "consumedNonce": p["consumedNonce"],
            "payer": payer,
            **(
                {
                    "merchant": MERCHANT,
                    "treasury": TREASURY,
                    "ipCreator": s.creator_placeholder(self.d["programId"], payer),
                    "profiles": p["profiles"],
                    "systemProgram": s.ZERO,
                }
                if asset == "SOL"
                else {
                    "tokenList": p["tokenList"],
                    "mint": q["token"],
                    "profiles": p["profiles"],
                    "tokenProgram": s.TOKEN,
                    "systemProgram": s.ZERO,
                }
            ),
        }
        self.call = {
            "chain": "solana",
            "network": "mainnet",
            "contract": self.d["programId"],
            "idl_sha256": self.d["idl"]["sha256"],
            "splitter_version": "1.4",
            "route": "merchant-aifp1",
            "asset": asset,
            "function": "settle_native" if asset == "SOL" else "settle_stable",
            "arg_encoding": "borsh-quote+signature",
            "field_order": s.FIELDS[:],
            "bound_to_payer": True,
            "treasury_owner": TREASURY,
            "args": {"quote": q, "signature": "0x" + (sig[:64] + bytes([sig[64] + 27])).hex()},
            "accounts": accounts,
            "remaining_accounts": (
                []
                if asset == "SOL"
                else [str(s.associated_token(owner, q["token"])) for owner in (payer, MERCHANT, TREASURY)]
            ),
            **({"value_lamports": q["grossAmount"]} if asset == "SOL" else {}),
        }
        self.quote = {
            "quote_id": "qt_solana",
            "nonce": "n_sol",
            "merchant_id": "mrch_sol",
            "payer": payer,
            "resource": "/api/items",
            "scope": "exact",
            "unit_quota": 200,
            "amount": "0.1",
            "currency": "USD",
            "network_mode": "live",
            "expires_at": iso(expiry),
            "accepted_chains": ["solana"],
            "accepted_assets": [asset],
            "pay_to": {"solana": MERCHANT},
            "settlement_call": self.call,
            "payment_authorization": {"scheme": "wallet-signature-v1", "domain": API},
            "settlement": {
                "gross_units": "100000",
                "payer_total_units": "100000",
                "total_units": "100000",
                "merchant_units": "99000",
                "protocol_fee_units": "1000",
                "creator_units": "0",
                "fee_on_top": False,
                "settlement_semantics": "gross-inclusive",
            },
            **(
                {
                    "native_settlement": {
                        "asset": "SOL",
                        "decimals": 9,
                        "rate_usd": "100",
                        "total_lamports": "1000000",
                        "merchant_lamports": "990000",
                        "treasury_lamports": "10000",
                        "creator_lamports": "0",
                        "settlement_semantics": "gross-inclusive",
                    }
                }
                if asset == "SOL"
                else {
                    "token_settlement": {
                        "asset": asset,
                        "token": q["token"],
                        "decimals": 6,
                        "total_units": "100000",
                        "merchant_units": "99000",
                        "protocol_fee_units": "1000",
                        "creator_units": "0",
                        "settlement_semantics": "gross-inclusive",
                    }
                }
            ),
        }
        config = bytearray(234)
        config[:8], config[40:104] = s.DISCS["config"], QUOTE_SIGNER.public_key.to_bytes()
        config[232] = Pubkey.find_program_address([b"config"], Pubkey.from_string(self.d["programId"]))[1]
        for offset, address in ((136, TREASURY), (168, p["tokenList"]), (200, p["profiles"])):
            config[offset : offset + 32] = bytes(Pubkey.from_string(address))
        profiles = bytearray(91)
        profiles[:8] = s.DISCS["profiles"]
        struct.pack_into("<I", profiles, 8, 1)
        profiles[12:44] = bytes.fromhex(q["routeId"][2:])
        struct.pack_into("<H", profiles, 44, 100)
        profiles[48], profiles[89] = 1, 1
        profiles[90] = Pubkey.find_program_address([b"profiles-index"], Pubkey.from_string(self.d["programId"]))[1]
        token_list = bytearray(77)
        token_list[:8] = s.DISCS["tokenList"]
        struct.pack_into("<I", token_list, 40, 1)
        token_list[44:76] = bytes(Pubkey.from_string(q["token"]))
        token_list[76] = Pubkey.find_program_address([b"token-list"], Pubkey.from_string(self.d["programId"]))[1]
        mint = bytearray(82)
        mint[44:46] = bytes([6, 1])
        token = bytearray(165)
        token[:32], token[32:64] = bytes(Pubkey.from_string(q["token"])), bytes(PAYER.pubkey())
        struct.pack_into("<Q", token, 64, 1_000_000)
        token[108] = 1
        self.data = {
            p["config"]: config,
            p["profiles"]: profiles,
            p["tokenList"]: token_list,
            q["token"]: mint,
            str(s.associated_token(payer, q["token"])): token,
        }
        self.owners = {q["token"]: s.TOKEN, str(s.associated_token(payer, q["token"])): s.TOKEN}
        self.native_balance, self.genesis, self.fee = 1_000_000_000, s.GENESIS["mainnet"], 5000
        self.pending, self.failed, self.sends, self.quotes, self.pays = False, False, [], [], []
        self.claims_override = {}

    def account(self, address):
        if address == self.d["programId"]:
            return {"owner": s.LOADER, "executable": True, "lamports": 100, "data": ["", "base64"]}
        if address == str(PAYER.pubkey()):
            return {"owner": s.ZERO, "executable": False, "lamports": self.native_balance, "data": ["", "base64"]}
        if address not in self.data:
            return None
        return {
            "owner": self.owners.get(address, self.d["programId"]),
            "executable": False,
            "lamports": 1_000_000,
            "data": [base64.b64encode(self.data[address]).decode(), "base64"],
        }

    def request(self, method, params):
        if method == "getGenesisHash":
            return self.genesis
        if method == "getMultipleAccounts":
            return {"value": [self.account(address) for address in params[0]]}
        if method == "getMinimumBalanceForRentExemption":
            return params[0] * 1000
        if method == "getLatestBlockhash":
            return {"value": {"blockhash": MERCHANT, "lastValidBlockHeight": 1234}}
        if method == "simulateTransaction":
            assert Transaction.from_bytes(base64.b64decode(params[0])).signatures[0].to_bytes() == bytes(64)
            return {"value": {"err": None, "unitsConsumed": 30000}}
        if method == "getFeeForMessage":
            return {"value": self.fee}
        if method == "sendTransaction":
            tx = Transaction.from_bytes(base64.b64decode(params[0]))
            tx.verify()
            self.sends.append(tx)
            return str(tx.signatures[0])
        if method == "getSignatureStatuses":
            return {
                "value": [
                    (
                        None
                        if self.pending
                        else {
                            "confirmationStatus": "finalized",
                            "slot": 100,
                            "err": self.failure_meta()["err"] if self.failed else None,
                        }
                    )
                ]
            }
        if method == "getTransaction":
            return {
                "slot": 100,
                "version": "legacy",
                "transaction": [base64.b64encode(bytes(self.sends[-1])).decode(), "base64"],
                "meta": self.failure_meta(),
            }
        if method == "getBlock":
            return {
                "blockhash": MERCHANT,
                "previousBlockhash": TREASURY,
                "parentSlot": 99,
                "blockHeight": 100,
                "transactions": [
                    {
                        "transaction": [base64.b64encode(bytes(self.sends[-1])).decode(), "base64"],
                        "meta": self.failure_meta(),
                    }
                ],
            }
        raise AssertionError(method)

    def failure_meta(self):
        return {"err": {"InstructionError": [1 if self.asset == "SOL" else 3, {"Custom": 6010}]}, "fee": 5000}

    def get(self, url, headers=None, **_):
        if url.startswith("https://api.coinbase.com/"):
            return Response({"data": {"base": "SOL", "currency": "USD", "amount": "100"}})
        if url.endswith("/.well-known/jwks.json"):
            return Response(
                {
                    "keys": [
                        {
                            "kty": "OKP",
                            "crv": "Ed25519",
                            "x": b64url(bytes(ISSUER.verify_key)),
                            "kid": "test",
                            "alg": "EdDSA",
                        }
                    ]
                }
            )
        if url == SHOP + "/api/items":
            if (headers or {}).get("AIFP-Receipt"):
                return Response({"ok": True})
            return Response(
                {
                    "protocol": "AIFP-1",
                    "merchant_id": "mrch_sol",
                    "resource": "/api/items",
                    "base_unit_price_usd": "0.0005",
                },
                402,
            )
        raise AssertionError(url)

    def post(self, url, json=None, headers=None, data=None, **_):
        if data is not None:
            json = globals()["json"].loads(data)
        if url == RPC:
            return Response({"result": self.request(json["method"], json["params"])})
        if url.endswith("/v1/quote"):
            auth = json["quote_authorization"]
            assert (
                auth["payer"] == str(PAYER.pubkey()) and auth["network"] == "mainnet" and auth["network_mode"] == "live"
            )
            assert json["settlement_chain"] == "solana" and len(auth["nonce"]) == 64
            statement = [
                "AiFinPay quote authorization v1",
                API,
                "mainnet",
                "live",
                "mrch_sol",
                "/api/items",
                "standard",
                None,
                200,
                "USD",
                "exact",
                "solana",
                self.asset,
                str(PAYER.pubkey()),
                auth["nonce"],
                auth["expires_at"],
            ]
            nacl.signing.VerifyKey(bytes(PAYER.pubkey())).verify(
                json_module(statement).encode(), base58.b58decode(auth["signature"])
            )
            self.quotes.append(json)
            return Response(self.quote)
        if url.endswith("/v1/pay"):
            auth = json["payment_authorization"]
            assert auth["payer"] == str(PAYER.pubkey()) and json["chain"] == "solana"
            idem = (
                "aifp1-" + hashlib.sha256(f"aifp1|qt_solana|{self.asset}|solana|{json['tx_ref']}".encode()).hexdigest()
            )
            assert (headers or {})["Idempotency-Key"] == idem
            statement = [
                "AiFinPay receipt authorization v1",
                API,
                "qt_solana",
                "n_sol",
                "mrch_sol",
                "live",
                "solana",
                json["tx_ref"],
                self.asset,
                idem,
                str(PAYER.pubkey()),
                auth["expires_at"],
            ]
            nacl.signing.VerifyKey(bytes(PAYER.pubkey())).verify(
                json_module(statement).encode(), base58.b58decode(auth["signature"])
            )
            self.pays.append(json)
            now = int(time.time())
            claims = {
                "iss": API,
                "aud": "mrch_sol",
                "sub": str(PAYER.pubkey()),
                "scope": "exact",
                "resource": "/api/items",
                "chain": "solana",
                "network": "mainnet",
                "program": self.d["programId"],
                "asset": self.asset,
                "tx_ref": json["tx_ref"],
                "amount": "0.1",
                "currency": "USD",
                "network_mode": "live",
                "unit_quota": 200,
                "receipt_id": "rc_sol",
                "iat": now,
                "exp": now + 3600,
                **self.claims_override,
            }
            raw = (
                b64url(json_module({"alg": "EdDSA", "typ": "JWT", "kid": "test"}).encode())
                + "."
                + b64url(json_module(claims).encode())
            )
            return Response(
                {
                    **claims,
                    "merchant_id": claims["aud"],
                    "receipt": raw + "." + b64url(ISSUER.sign(raw.encode()).signature),
                    "expires_at": iso(claims["exp"]),
                }
            )
        raise AssertionError(url)


def json_module(value):
    return json.dumps(value, separators=(",", ":"), ensure_ascii=False)


def plan(f, **changes):
    return s.prepare_settlement(
        f.call,
        rpc=f,
        deployment=f.d,
        payer=str(PAYER.pubkey()),
        order_id="qt_solana",
        max_fee_lamports=changes.get("max_fee_lamports", 1_000_000),
    )


def approved(monkeypatch, f):
    monkeypatch.setattr(
        s,
        "authorized_inventory",
        lambda environment, network: {
            **s.inventory(environment, network),
            "status": "enabled",
            "settlementEnabled": True,
        },
    )  # Dependency injection only; production flags are unchanged.
    monkeypatch.setattr(a.requests, "Session", lambda: f)


def fetch(agent, tmp_path, asset="SOL", **changes):
    return agent.fetch_paid(
        SHOP + "/api/items",
        allowed_origins=[SHOP],
        max_amount_usd=1,
        daily_amount_usd=1,
        chain="solana",
        environment="prod",
        solana_network="mainnet",
        max_fee_lamports=1_000_000,
        asset=asset,
        scope="exact",
        journal_dir=str(tmp_path),
        **changes,
    )


def test_independent_pinned_wire_vectors():
    golden = json.loads((Path(__file__).parent / "fixtures/solana-v14-golden.json").read_text())
    for c in golden["cases"]:
        q = c["quote"]
        assert s.encode_quote(q).hex() == c["quoteHex"]
        assert s.quote_digest(c["programId"], q).hex() == c["digestHex"]
        assert s.payment_id(q) == c["paymentId"]
        disc = s.NATIVE_DISC if c["instruction"] == "settle_native" else s.STABLE_DISC
        assert (
            disc + struct.pack("<Q", int(q["nonce"])) + s.encode_quote(q) + bytes.fromhex(c["signatureHex"][2:])
        ).hex() == c["instructionHex"]


@pytest.mark.parametrize("asset", ["SOL", "USDC", "USDT"])
def test_actual_local_signing_and_save_before_single_send(asset):
    f, saved = Fixture(asset), []
    p = plan(f)
    assert p.fee_rent_lamports == (104000 if asset == "SOL" else 434000)

    def save(entry):
        assert not f.sends
        saved.append(entry)

    tx = s.execute_settlement(p, rpc=f, keypair=PAYER, on_prepared=save)
    assert len(f.sends) == 1 and saved == [tx]
    assert len(bytes(f.sends[0].message.instructions[-1].data)) == 297
    s.assert_prepared_recovery(f.call, tx, f.d, str(PAYER.pubkey()), "qt_solana")


@pytest.mark.parametrize(
    "failure",
    [
        "genesis",
        "paused",
        "profile",
        "signer",
        "unsafe balance",
        "mint decimals",
        "mint owner",
        "whitelist",
        "nonce",
        "missing fee",
        "rent cap",
    ],
)
def test_runtime_evidence_refuses_before_any_signature_or_send(failure):
    f = Fixture("USDC" if failure.startswith("mint") or failure == "whitelist" else "SOL")
    if failure == "genesis":
        f.genesis = s.GENESIS["devnet"]
    elif failure == "paused":
        f.data[str(f.pdas["config"])][233] = 1
    elif failure == "profile":
        struct.pack_into("<H", f.data[str(f.pdas["profiles"])], 44, 99)
    elif failure == "signer":
        f.data[str(f.pdas["config"])][40] ^= 1
    elif failure == "unsafe balance":
        f.native_balance = 2**53
    elif failure == "mint decimals":
        f.data[f.call["args"]["quote"]["token"]][44] = 18
    elif failure == "mint owner":
        f.owners[f.call["args"]["quote"]["token"]] = s.ZERO
    elif failure == "whitelist":
        f.data[str(f.pdas["tokenList"])][44:76] = bytes(32)
    elif failure == "nonce":
        f.call["args"]["quote"]["nonce"] = "1"
    elif failure == "missing fee":
        f.fee = None
    with pytest.raises(s.SolanaV14Error):
        plan(f, max_fee_lamports=1 if failure == "rent cap" else 1_000_000)
    assert not f.sends


@pytest.mark.parametrize(
    "failure",
    [
        "config bump",
        "profiles bump",
        "token-list bump",
        "creator owner",
        "creator data",
        "creator executable",
        "missing executable",
        "final simulation",
    ],
)
def test_malformed_runtime_evidence_refuses_before_signing(failure):
    f = Fixture("USDC" if failure == "token-list bump" else "SOL")
    if failure.endswith("bump"):
        name = {"config bump": "config", "profiles bump": "profiles", "token-list bump": "tokenList"}[failure]
        b = f.data[str(f.pdas[name])]
        b[232 if name == "config" else len(b) - 1] ^= 1
    original_account = f.account

    def account(address):
        if address == s.creator_placeholder(f.d["programId"], str(PAYER.pubkey())) and failure.startswith("creator"):
            return {
                "owner": f.d["programId"] if failure == "creator owner" else s.ZERO,
                "executable": failure == "creator executable",
                "lamports": 10,
                "data": ["AQ==" if failure == "creator data" else "", "base64"],
            }
        value = original_account(address)
        if address == str(f.pdas["config"]) and failure == "missing executable":
            value.pop("executable")
        return value

    f.account = account
    original_request, simulations = f.request, 0

    def request(method, params):
        nonlocal simulations
        if method == "simulateTransaction":
            simulations += 1
            if failure == "final simulation" and simulations == 2:
                return {"value": {"err": {"InstructionError": [1, "InvalidArgument"]}, "unitsConsumed": 1}}
        return original_request(method, params)

    f.request = request
    with pytest.raises(s.SolanaV14Error):
        plan(f)
    assert not f.sends


@pytest.mark.parametrize("field", ["unit_quota", "fee_on_top"])
def test_python_boolean_numeric_aliases_do_not_authorize_solana(monkeypatch, tmp_path, field):
    f = Fixture()
    approved(monkeypatch, f)
    if field == "unit_quota":
        f.quote[field] = True
    else:
        f.quote["settlement"][field] = 0
    with pytest.raises(a.Aifp1QuoteError):
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    assert not f.sends


@pytest.mark.parametrize("asset", ["SOL", "USDC", "USDT"])
def test_public_high_level_proof_jwt_journal_and_restart_recovery(monkeypatch, tmp_path, asset):
    f = Fixture(asset)
    approved(monkeypatch, f)
    agent = AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC)
    assert fetch(agent, tmp_path, asset).status_code == 200
    assert len(f.sends) == len(f.quotes) == len(f.pays) == 1
    journal = next(p for p in tmp_path.glob("*.json") if p.name != "spend.json")
    recovery = json.loads(journal.read_text())
    assert recovery["tx_ref"] == str(f.sends[0].signatures[0]) and recovery["family"] == "solana"
    assert recovery["reserved_amount_usd"] == pytest.approx(0.1104 if asset == "SOL" else 0.1434)
    assert a.SpendLedger(1, 1, str(tmp_path / "spend.json")).spent_24h() == pytest.approx(
        recovery["reserved_amount_usd"]
    )
    restart = AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC)
    restart.recover_paid(str(journal), solana_network="mainnet", environment="prod")
    assert len(f.sends) == 1 and len(f.pays) == 2
    assert a.SpendLedger(1, 1, str(tmp_path / "spend.json")).spent_24h() == pytest.approx(
        recovery["reserved_amount_usd"]
    )
    with pytest.raises(s.SolanaV14Error):
        restart.recover_paid(str(journal), solana_network="devnet", environment="dev")


def test_unknown_broadcast_survives_expiry_and_cannot_be_rebought(monkeypatch, tmp_path):
    f = Fixture()
    approved(monkeypatch, f)
    f.pending = True
    with pytest.raises(a.Aifp1PayError) as error:
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    recovery = error.value.recovery
    assert recovery["journal_path"] and len(f.sends) == 1
    original = time.time()
    monkeypatch.setattr(s.time, "time", lambda: original + 3 * 86400)
    s.assert_prepared_recovery(f.call, recovery["solana"], f.d, str(PAYER.pubkey()), "qt_solana")
    ledger = a.SpendLedger(1, 1, str(tmp_path / "spend.json"))
    assert ledger.spent_24h() == pytest.approx(0.1104)
    owner = AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC).evm_address.lower()
    evm = dict(
        a._budget_binding(f.quote, str(PAYER.pubkey()), "solana", "SOL", API, API, owner),
        payer="0x" + "12" * 20,
        chain="base",
        asset="ETH",
        token="0x" + "00" * 20,
        quote_id="qt_new",
    )
    with pytest.raises(a.Aifp1QuoteError, match="unresolved"):
        ledger.reserve(0.1, evm)
    assert len(f.sends) == 1


@pytest.mark.parametrize(
    "field,value",
    [
        ("sub", str(PAYER.pubkey()).lower()),
        ("chain", "polygon"),
        ("network_mode", "test"),
        ("network", "devnet"),
        ("program", MERCHANT),
        ("asset", "USDC"),
    ],
)
def test_signed_wrong_receipt_keeps_confirmed_debit_and_original_journal(monkeypatch, tmp_path, field, value):
    f = Fixture()
    approved(monkeypatch, f)
    f.claims_override[field] = value
    with pytest.raises(a.Aifp1PayError):
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    assert len(f.sends) == 1
    assert a.SpendLedger(1, 1, str(tmp_path / "spend.json")).spent_24h() == pytest.approx(0.1104)


def test_actual_canonical_unavailability_prevents_all_http_and_proofs(monkeypatch, tmp_path):
    f = Fixture()
    monkeypatch.setattr(a.requests, "Session", lambda: f)
    with pytest.raises(s.SolanaV14Error, match="disabled"):
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    assert not f.quotes and not f.sends and not f.pays


def test_failed_durable_callback_never_broadcasts():
    f = Fixture()
    with pytest.raises(OSError, match="fsync"):
        s.execute_settlement(
            plan(f), rpc=f, keypair=PAYER, on_prepared=lambda _entry: (_ for _ in ()).throw(OSError("fsync refused"))
        )
    assert not f.sends


@pytest.mark.parametrize(
    "failure",
    [
        "genesis",
        "missing transaction",
        "different bytes",
        "wrong slot",
        "version",
        "missing metadata",
        "invalid error",
        "null error",
        "unsafe fee",
        "negative fee",
        "over cap",
        "missing block",
        "no inclusion",
        "parent",
        "block metadata",
    ],
)
def test_incomplete_finalized_failure_proof_retains_unknown(failure):
    f = Fixture()
    p = plan(f)
    f.failed = True
    original = f.request

    def request(method, params):
        value = original(method, params)
        if method == "getGenesisHash" and failure == "genesis":
            return s.GENESIS["devnet"]
        if method == "getTransaction":
            if failure == "missing transaction":
                return None
            if failure == "different bytes":
                value["transaction"] = ["AAAA", "base64"]
            if failure == "wrong slot":
                value["slot"] = 101
            if failure == "version":
                value["version"] = 0
            if failure == "missing metadata":
                value["meta"] = None
            if failure == "invalid error":
                value["meta"]["err"] = False
            if failure == "null error":
                value["meta"]["err"] = None
            if failure == "unsafe fee":
                value["meta"]["fee"] = 2**53
            if failure == "negative fee":
                value["meta"]["fee"] = -1
            if failure == "over cap":
                value["meta"]["fee"] = 5001
        if method == "getBlock":
            if failure == "missing block":
                return None
            if failure == "no inclusion":
                value["transactions"] = []
            if failure == "parent":
                value["parentSlot"] = 100
            if failure == "block metadata":
                value["transactions"][0]["meta"] = None
        return value

    f.request = request
    with pytest.raises(s.SolanaV14Error) as error:
        s.execute_settlement(p, rpc=f, keypair=PAYER, on_prepared=lambda _: None)
    assert error.value.code == "SOLANA_V14_PENDING" and len(f.sends) == 1


@pytest.mark.parametrize("late", [False, True])
def test_public_finalized_failure_fee_once_and_crash_retry(monkeypatch, tmp_path, late):
    f = Fixture()
    approved(monkeypatch, f)
    f.failed = True
    f.pending = late
    agent = AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC)
    with pytest.raises(a.Aifp1PayError) as error:
        fetch(agent, tmp_path)
    path = error.value.recovery["journal_path"]
    original = time.time()
    if late:
        assert not isinstance(error.value, a.Aifp1FinalizedFailureError)
        admitted_at = json.loads((tmp_path / "spend.json").read_text())["reservations"][0]["at"]
        monkeypatch.setattr(s.time, "time", lambda: original + 3 * 86400)
        f.pending = False
        with pytest.raises(a.Aifp1FinalizedFailureError) as error:
            agent.recover_paid(path, environment="prod", solana_network="mainnet")
        assert json.loads((tmp_path / "spend.json").read_text())["spend"][0]["at"] == admitted_at
    assert isinstance(error.value, a.Aifp1FinalizedFailureError)
    assert error.value.fee_amount_usd == 0.0005 and error.value.actual_fee_lamports == 5000
    assert a.SpendLedger(1, 1, str(tmp_path / "spend.json")).spent_24h() == (0 if late else 0.0005)
    for _ in range(2):
        with pytest.raises(a.Aifp1FinalizedFailureError):
            agent.recover_paid(path, environment="prod", solana_network="mainnet")
    assert len(f.sends) == 1 and not f.pays
    monkeypatch.setattr(s.time, "time", lambda: original + 4 * 86400)
    with pytest.raises(a.Aifp1FinalizedFailureError):
        agent.recover_paid(path, environment="prod", solana_network="mainnet")
    assert a.SpendLedger(1, 1, str(tmp_path / "spend.json")).spent_24h() == 0
    assert len(f.sends) == 1


@pytest.mark.parametrize("crash", ["before-write", "after-write"])
def test_failure_ledger_write_crash_retains_exact_recovery(monkeypatch, tmp_path, crash):
    f = Fixture()
    approved(monkeypatch, f)
    f.failed = True
    write = a._write_private_json

    def write_crash(path, data):
        if "spend" in data and any(entry.get("failed") for entry in data["spend"]):
            if crash == "after-write":
                write(path, data)
            raise OSError("injected failure debit fsync crash")
        write(path, data)

    monkeypatch.setattr(a, "_write_private_json", write_crash)
    with pytest.raises(a.Aifp1PayError) as error:
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    assert not isinstance(error.value, a.Aifp1FinalizedFailureError)
    recovery = error.value.recovery
    monkeypatch.setattr(a, "_write_private_json", write)
    ledger = a.SpendLedger(1, 1, str(tmp_path / "spend.json"))
    assert ledger.spent_24h() == (recovery["reserved_amount_usd"] if crash == "before-write" else 0.0005)
    restart = AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC)
    for _ in range(2):
        with pytest.raises(a.Aifp1FinalizedFailureError):
            restart.recover_paid(recovery["journal_path"], environment="prod", solana_network="mainnet")
    assert ledger.spent_24h() == 0.0005 and len(f.sends) == 1 and not f.pays


def test_two_real_processes_finalize_same_failure_once(tmp_path):
    f = Fixture()
    path = str(tmp_path / "spend.json")
    ledger = a.SpendLedger(1, 1, path)
    binding = a._budget_binding(
        f.quote, str(PAYER.pubkey()), "solana", "SOL", API, API, "local-wallet-identity", "100", "1000000", "5000"
    )
    reservation = ledger.reserve(0.6, binding)
    signature = base58.b58encode(bytes([7]) * 64).decode()
    ledger.prepared(reservation, signature, binding)
    code = "import sys,json; from aifinpay.aifp1 import SpendLedger; SpendLedger(1,1,sys.argv[1]).finalize_failure(sys.argv[2],sys.argv[3],json.loads(sys.argv[4]),.0005)"
    processes = [
        subprocess.Popen(
            [sys.executable, "-c", code, path, reservation, signature, json.dumps(binding)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        for _ in range(2)
    ]
    for child in processes:
        _out, err = child.communicate(timeout=20)
        assert child.returncode == 0, err.decode()
    assert ledger.spent_24h() == 0.0005
    assert len(json.loads(Path(path).read_text())["spend"]) == 1
    with pytest.raises(a.Aifp1QuoteError, match="immutable"):
        ledger.finalize_failure(reservation, signature, binding, 0.0004)
    successful = {**binding, "resource": "/success", "quote_id": "qt_success"}
    success = ledger.reserve(0.6, successful)
    ledger.prepared(success, signature, successful)
    ledger.confirm(success, signature, successful)
    with pytest.raises(a.Aifp1QuoteError, match="successful"):
        ledger.finalize_failure(success, signature, successful, 0.0005)
    assert ledger.spent_24h() == 0.6005


def test_corrupted_boolean_zero_failed_debit_does_not_reset_budget(tmp_path):
    f = Fixture()
    path = tmp_path / "spend.json"
    ledger = a.SpendLedger(1, 1, str(path))
    binding = a._budget_binding(
        f.quote, str(PAYER.pubkey()), "solana", "SOL", API, API, "local-wallet-identity", "100", "1000000", "5000"
    )
    reservation = ledger.reserve(0.6, binding)
    signature = base58.b58encode(bytes([7]) * 64).decode()
    ledger.prepared(reservation, signature, binding)
    ledger.finalize_failure(reservation, signature, binding, 0)
    state = json.loads(path.read_text())
    state["spend"][0]["usd"] = False
    path.write_text(json.dumps(state))
    with pytest.raises(a.Aifp1QuoteError, match="malformed"):
        ledger.spent_24h()
    assert json.loads(path.read_text()) == state


def test_prequote_timeout_exact_replay_restart_and_expired_auth(monkeypatch, tmp_path):
    f, sent, now = Fixture(), [], time.time()
    approved(monkeypatch, f)
    post = f.post

    def lost(url, **kw):
        if url.endswith("/v1/quote"):
            sent.append(kw["data"])
            post(url, **kw)
            raise RuntimeError("quote response lost")
        return post(url, **kw)

    monkeypatch.setattr(f, "post", lost)
    with pytest.raises(RuntimeError, match="response lost"):
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    path = tmp_path / "spend.json"
    state = json.loads(path.read_text())
    original = state["quote_admissions"][0]
    assert state["version"] == 3 and not state["reservations"] and not state["spend"] and not f.sends
    assert original["request_body"] == sent[0] and (path.stat().st_mode & 0o777) == 0o600
    monkeypatch.setattr(a.time, "time", lambda: now + 300)

    def replay(url, **kw):
        if url.endswith("/v1/quote"):
            sent.append(kw["data"])
        return post(url, **kw)

    monkeypatch.setattr(f, "post", replay)
    assert fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path).status_code == 200
    assert sent == [sent[0], sent[0]] and len(f.sends) == 1
    state = json.loads(path.read_text())
    assert not state["quote_admissions"] and not state["reservations"]
    assert state["spend"][0]["id"] == original["id"] and len(state["spend"]) == 1


@pytest.mark.parametrize("fault", ["limits", "RPC", "signature", "body"])
def test_prequote_owner_context_and_signature_changes_refuse_before_post(monkeypatch, tmp_path, fault):
    f, calls = Fixture(), []
    approved(monkeypatch, f)
    post = f.post

    def unknown(url, **kw):
        if url.endswith("/v1/quote"):
            calls.append(kw["data"])
            raise RuntimeError("unknown quote outcome")
        return post(url, **kw)

    monkeypatch.setattr(f, "post", unknown)
    with pytest.raises(RuntimeError):
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    path = tmp_path / "spend.json"
    if fault in ("signature", "body"):
        state = json.loads(path.read_text())
        e = state["quote_admissions"][0]
        body = json.loads(e["request_body"])
        if fault == "body":
            body["units"] += 1
        else:
            body["quote_authorization"]["signature"] = base58.b58encode(bytes(64)).decode()
        e["request_body"] = json_module(body)
        path.write_text(json.dumps(state))
    agent = AiFinPayAgent.from_seed("42" * 32, solana_rpc="https://changed.example" if fault == "RPC" else RPC)
    with pytest.raises(a.Aifp1QuoteError):
        agent.fetch_paid(
            SHOP + "/api/items",
            allowed_origins=[SHOP],
            chain="solana",
            environment="prod",
            solana_network="mainnet",
            max_fee_lamports=1_000_000,
            scope="exact",
            max_amount_usd=2 if fault == "limits" else 1,
            daily_amount_usd=1,
            journal_dir=str(tmp_path),
        )
    assert len(calls) == 1 and not f.sends


@pytest.mark.parametrize("when", ["before", "after"])
def test_prequote_durable_write_failure_never_posts(monkeypatch, tmp_path, when):
    f = Fixture()
    approved(monkeypatch, f)
    write = a._write_private_json

    def fault(path, data):
        if data["quote_admissions"]:
            if when == "after":
                write(path, data)
            raise OSError("admission fsync failed")
        write(path, data)

    monkeypatch.setattr(a, "_write_private_json", fault)
    with pytest.raises(OSError, match="fsync failed"):
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    assert not f.quotes and not f.sends
    saved = json.loads((tmp_path / "spend.json").read_text())["quote_admissions"][0] if when == "after" else None
    monkeypatch.setattr(a, "_write_private_json", write)
    assert fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path).status_code == 200
    if saved:
        assert f.quotes[0]["quote_authorization"] == json.loads(saved["request_body"])["quote_authorization"]
    assert len(f.sends) == 1


@pytest.mark.parametrize("fault", ["exact", "hash", "payer", "collision", "DB", "unexpired"])
def test_only_exact_expired_nonadmission_closes_local_phase(monkeypatch, tmp_path, fault):
    f, sent, now = Fixture(), [], time.time()
    approved(monkeypatch, f)
    post = f.post

    def unknown(url, **kw):
        if url.endswith("/v1/quote"):
            sent.append(kw["data"])
            raise RuntimeError("unknown quote outcome")
        return post(url, **kw)

    monkeypatch.setattr(f, "post", unknown)
    with pytest.raises(RuntimeError):
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    if fault != "unexpired":
        monkeypatch.setattr(a.time, "time", lambda: now + 300)

    def missing(url, **kw):
        if url.endswith("/v1/quote"):
            sent.append(kw["data"])
            body = json.loads(kw["data"])
            auth = body["quote_authorization"]
            return Response(
                {
                    "error": "AIFP-410-SOLANA",
                    "reason": "solana_quote_authorization_expired",
                    "admission_status": "not_admitted",
                    "authorization_nonce": auth["nonce"],
                    "authorization_statement_hash": (
                        "bad"
                        if fault == "hash"
                        else hashlib.sha256(a.solana_quote_authorization_message(body, auth, API).encode()).hexdigest()
                    ),
                    "payer": MERCHANT if fault == "payer" else auth["payer"],
                    "network": auth["network"],
                    "network_mode": auth["network_mode"],
                },
                409 if fault == "collision" else 503 if fault == "DB" else 410,
            )
        return post(url, **kw)

    monkeypatch.setattr(f, "post", missing)
    with pytest.raises(a.Aifp1QuoteError):
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    e = json.loads((tmp_path / "spend.json").read_text())["quote_admissions"][0]
    assert (e.get("terminal") == "not-admitted") == (fault == "exact")
    assert sent == [sent[0], sent[0]] and not f.sends


def test_expired_adopted_quote_local_nonbroadcast_terminal_without_post(monkeypatch, tmp_path):
    f = Fixture()
    approved(monkeypatch, f)
    now = time.time()
    pd = s.pdas(f.d["programId"], str(PAYER.pubkey()), "0")
    f.data[str(pd["config"])][233] = 1
    with pytest.raises(s.SolanaV14Error, match="paused"):
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    path = tmp_path / "spend.json"
    original = json.loads(path.read_text())["quote_admissions"][0]
    assert "quote_json" in original and not f.sends and len(f.quotes) == 1
    monkeypatch.setattr(a.time, "time", lambda: now + 700)
    with pytest.raises(a.Aifp1QuoteError, match="expired"):
        fetch(AiFinPayAgent.from_seed("42" * 32, solana_rpc=RPC), tmp_path)
    terminal = json.loads(path.read_text())["quote_admissions"][0]
    assert terminal == {**original, "terminal": "expired-unbroadcast"} and not f.sends and len(f.quotes) == 1
    ledger = a.SpendLedger(1, 1, str(path))
    ledger.close_quote_admission(
        original["id"], original["binding"], original["owner_context"], "expired-unbroadcast", original["quote_json"]
    )
    assert ledger.spent_24h() == 0 and len(json.loads(path.read_text())["quote_admissions"]) == 1


def test_two_processes_share_prequote_and_atomic_adoption(tmp_path):
    f = Fixture()
    path = str(tmp_path / "spend.json")
    binding = a._budget_binding(f.quote, str(PAYER.pubkey()), "solana", "SOL", API, API, "one-wallet")
    zero = {**binding, "gross_amount": "0", "quote_id": "quote-admission", "quote_admission_version": "1"}
    code = "import sys,json,uuid; from aifinpay.aifp1 import SpendLedger; l=SpendLedger(1,1,sys.argv[1]); e=l.begin_quote_admission(json.loads(sys.argv[2]),'owner',lambda:(uuid.uuid4().hex,'signed-statement')); print(json.dumps(e))"
    processes = [
        subprocess.Popen(
            [sys.executable, "-c", code, path, json.dumps(zero)], stdout=subprocess.PIPE, stderr=subprocess.PIPE
        )
        for _ in range(2)
    ]
    rows = []
    for child in processes:
        out, err = child.communicate(timeout=20)
        assert child.returncode == 0, err.decode()
        rows.append(json.loads(out))
    assert rows[0] == rows[1]
    ledger = a.SpendLedger(1, 1, path)
    original = rows[0]
    ledger.adopt_quote_admission(original["id"], zero, "owner", json_module(f.quote))
    assert ledger.reserve(0.6, binding, original["id"]) == original["id"] and ledger.spent_24h() == 0.6
    with pytest.raises(a.Aifp1QuoteError):
        ledger.begin_quote_admission(zero, "owner", lambda: ("new-nonce", "new-statement"))
    with pytest.raises(a.Aifp1QuoteError):
        ledger.close_quote_admission(original["id"], zero, "owner", "expired-unbroadcast", json_module(f.quote))
    ledger.release(original["id"])
    resumed = ledger.begin_quote_admission(zero, "owner", lambda: ("new-nonce", "new-statement"))
    assert resumed["id"] == original["id"] and resumed["was_reserved"] is True and ledger.spent_24h() == 0
    with pytest.raises(a.Aifp1QuoteError):
        ledger.close_quote_admission(original["id"], zero, "owner", "expired-unbroadcast", json_module(f.quote))


def test_exact_v2_migration_keeps_all_debits_and_reservation_identity(tmp_path):
    f = Fixture()
    path = tmp_path / "spend.json"
    ledger = a.SpendLedger(2, 2, str(path))
    binding = a._budget_binding(f.quote, str(PAYER.pubkey()), "solana", "SOL", API, API)
    reservation = ledger.reserve(0.6, binding)
    state = json.loads(path.read_text())
    state["version"] = 2
    del state["quote_admissions"]
    state["spend"] = [{"at": time.time() - 3 * 86400, "usd": 0.001} for _ in range(1200)]
    path.write_text(json.dumps(state))
    before = copy.deepcopy(state)
    restart = a.SpendLedger(2, 2, str(path))
    restart.record(0.1)
    after = json.loads(path.read_text())
    assert (
        after["version"] == 3
        and after["reservations"] == before["reservations"]
        and after["reservations"][0]["id"] == reservation
    )
    assert after["spend"][:1200] == before["spend"]
