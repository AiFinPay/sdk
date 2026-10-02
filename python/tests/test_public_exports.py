"""The package's public names, at parity with what @aifinpay/agent exports.

fetch_paid raises Aifp1QuoteError / Aifp1PayError / V14SettlementError and
fetch_registry returns ProviderEntry, but none of them could be imported from
``aifinpay`` — a caller had to know the private module layout to catch them.
The Node SDK exports all four from its package root.
"""

import importlib
import re
import sys
from pathlib import Path

import pytest

import aifinpay


def test_every_name_in_all_resolves():
    for name in aifinpay.__all__:
        assert getattr(aifinpay, name) is not None, name


@pytest.mark.parametrize(
    "name,module",
    [
        ("Aifp1Error", "aifinpay.aifp1"),
        ("Aifp1QuoteError", "aifinpay.aifp1"),
        ("Aifp1PayError", "aifinpay.aifp1"),
        ("V14SettlementError", "aifinpay.settlement_v14"),
        ("ProviderEntry", "aifinpay.unified_agent"),
    ],
)
def test_errors_and_types_are_importable_from_the_package(name, module):
    exported = getattr(aifinpay, name)
    assert exported is getattr(importlib.import_module(module), name)
    assert name in aifinpay.__all__


def test_a_fetch_paid_refusal_is_catchable_by_its_package_level_class():
    agent = aifinpay.AiFinPayAgent.from_seed("11" * 32)
    # Base needs an explicit gas budget; fetch_paid refuses before any request.
    with pytest.raises(aifinpay.Aifp1QuoteError, match="max_gas_wei"):
        agent.fetch_paid(
            "https://merchant.example/data",
            allowed_origins=["https://merchant.example"],
            max_amount_usd=1,
            daily_amount_usd=1,
            chain="base",
        )


def test_aifp1_errors_share_one_root():
    assert issubclass(aifinpay.Aifp1QuoteError, aifinpay.Aifp1Error)
    assert issubclass(aifinpay.Aifp1PayError, aifinpay.Aifp1Error)


def test_a_missing_dependency_names_only_extras_that_exist(monkeypatch):
    tomllib = pytest.importorskip("tomllib")
    pyproject = Path(__file__).resolve().parents[1] / "pyproject.toml"
    extras = set(tomllib.loads(pyproject.read_text())["project"]["optional-dependencies"])

    monkeypatch.setitem(sys.modules, "web3", None)  # as if web3 were not installed
    monkeypatch.delitem(sys.modules, "aifinpay.unified_agent", raising=False)
    with pytest.raises(ImportError) as excinfo:
        importlib.import_module("aifinpay.unified_agent")

    message = str(excinfo.value)
    assert "web3" in message
    named = set(re.findall(r"aifinpay-agent\[([A-Za-z0-9_-]+)\]", message))
    assert named <= extras, f"the message recommends extras {named - extras} that pyproject.toml does not define"
