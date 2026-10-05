"""Public cluster-partitioned history; a retained bearer receipt stays private."""

import pytest

from aifinpay import AiFinPayAgent, get_agent_history, get_quota
from aifinpay.settlement_solana_v14 import SolanaV14Error, inventory

ADDRESS = AiFinPayAgent.from_seed("42" * 32).solana_address
PROGRAM = inventory("prod", "mainnet")["programId"]


class Session:
    def __init__(self, source="receipts", fault=None):
        self.source, self.fault, self.urls = source, fault, []

    def get(self, url, **options):
        from urllib.parse import parse_qs, urlsplit

        self.urls.append(url)
        u = urlsplit(url)
        assert u.path == f"/v1/agents/{ADDRESS}/{self.source}"
        query = parse_qs(u.query)
        assert query["network"] == ["mainnet"] and query["program"] == [PROGRAM] and query["chain"] == ["solana"]
        body = {
            "address": ADDRESS,
            "chain": "solana",
            "network": "devnet" if self.fault == "body" else "mainnet",
            "program": PROGRAM,
            self.source: [
                {
                    "network": "mainnet",
                    "program": ADDRESS if self.fault == "row" else PROGRAM,
                    "chain": "solana",
                    "payer": ADDRESS,
                    "agent_address": ADDRESS,
                    "remaining": 7,
                    "used": 3,
                    "quota": 2,
                    "unit_quota": 10,
                    "merchant_id": "mrch_sol",
                    "asset": "USDC",
                    "tx_hash": "sig",
                    "receipt": "secret",
                    "jwt": "secret",
                    "private_key": "secret",
                }
            ],
        }
        return type("Response", (), {"ok": True, "json": lambda _: body})()


@pytest.mark.parametrize("source", ["transactions", "receipts"])
def test_public_case_preserved_cluster_pinned_redacted_history(source):
    session = Session(source)
    data = get_agent_history(ADDRESS, chain="solana", solana_network="mainnet", source=source, session=session)
    assert data["address"] == ADDRESS and data["program"] == PROGRAM and "secret" not in str(data)


def test_local_public_quota_needs_no_wallet_signature_or_passport():
    agent = AiFinPayAgent.from_seed("42" * 32)
    data = agent.get_quota(chain="solana", solana_network="mainnet", session=Session())
    assert data["agent"] == ADDRESS and data["totals"]["mrch_sol"]["remaining"] == 7 and "secret" not in str(data)


@pytest.mark.parametrize("fault", ["cluster", "payer", "body", "row"])
def test_mismatched_cluster_program_or_payer_fails_closed(fault):
    session = Session(fault=fault)
    with pytest.raises((ValueError, SolanaV14Error)):
        get_quota(
            ADDRESS.lower() if fault == "payer" else ADDRESS,
            chain="solana",
            solana_network=None if fault == "cluster" else "mainnet",
            session=session,
        )
    if fault in ("cluster", "payer"):
        assert not session.urls


@pytest.mark.parametrize(
    "fault",
    ["body payer", "row payer", "bool used", "missing used", "negative", "fractional", "conservation", "overflow"],
)
def test_strict_conserved_unit_quota_and_wallet_binding(fault):
    row = {
        "chain": "solana",
        "network": "mainnet",
        "program": PROGRAM,
        "payer": ADDRESS,
        "used": 3,
        "remaining": 7,
        "unit_quota": 10,
        "quota": 2,
        "merchant_id": "mrch_sol",
    }
    body = {"address": ADDRESS, "chain": "solana", "network": "mainnet", "program": PROGRAM, "receipts": [row]}
    if fault == "body payer":
        body["address"] = ADDRESS.lower()
    if fault == "row payer":
        row["payer"] = ADDRESS.lower()
    if fault == "bool used":
        row["used"] = False
    if fault == "missing used":
        del row["used"]
    if fault == "negative":
        row["remaining"] = -1
    if fault == "fractional":
        row["unit_quota"] = 10.1
    if fault == "conservation":
        row["remaining"] = 8
    if fault == "overflow":
        body["receipts"].insert(0, {**row, "used": 0, "remaining": 2**53 - 1, "unit_quota": 2**53 - 1})
    session = type("S", (), {"get": lambda *args, **kwargs: type("R", (), {"ok": True, "json": lambda _: body})()})()
    with pytest.raises(ValueError):
        get_quota(ADDRESS, chain="solana", solana_network="mainnet", session=session)


def test_nullable_shared_costs_and_partial_history_coverage_preserved_without_bearer_material():
    body = {
        "address": ADDRESS,
        "chain": "solana",
        "network": "mainnet",
        "program": PROGRAM,
        "indexing": {
            "coverage_kind": "retained_rpc_inventory",
            "coverage_start": None,
            "archive_complete": False,
            "jwt": "secret",
        },
        "transactions": [
            {
                "agent_address": ADDRESS,
                "chain": "solana",
                "network": "mainnet",
                "program": PROGRAM,
                "cost_allocation": "shared-unavailable",
                "fee_lamports": None,
                "ata_rent_lamports": None,
                "nonce_rent_lamports": "1000",
                "jwt": "secret",
            }
        ],
    }
    session = type("S", (), {"get": lambda *args, **kwargs: type("R", (), {"ok": True, "json": lambda _: body})()})()
    result = get_agent_history(ADDRESS, chain="solana", solana_network="mainnet", session=session)
    assert result["indexing"] == {
        "coverage_kind": "retained_rpc_inventory",
        "coverage_start": None,
        "archive_complete": False,
    }
    assert result["items"][0]["cost_allocation"] == "shared-unavailable" and result["items"][0]["fee_lamports"] is None
    assert "secret" not in str(result) and "partial history" in result["coverage"]
