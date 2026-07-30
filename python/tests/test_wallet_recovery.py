"""Wallet recoverability — the invariant that keeps funded agents spendable.

``AiFinPayAgent.new()`` once generated an EVM key independent of the Solana
key. Every recovery path derives the EVM key from the Solana seed, so restoring
an agent produced a DIFFERENT EVM address and any balance funded on the
original became unreachable. These tests fail if that regresses.
"""
import pytest

pytest.importorskip("web3", reason="unified extras not installed")
pytest.importorskip("solders", reason="unified extras not installed")

from aifinpay.unified_agent import AiFinPayAgent  # noqa: E402


def test_new_is_recoverable_from_solana_secret_alone():
    agent = AiFinPayAgent.new()
    # The Solana secret is what operators are told to back up, so it must be
    # a complete backup of the identity.
    restored = AiFinPayAgent.from_solana_secret(agent.inner.secret_b58)
    assert restored.solana_address == agent.solana_address
    assert restored.evm_address == agent.evm_address


def test_from_seed_is_deterministic():
    seed = "22" * 32
    a = AiFinPayAgent.from_seed(seed)
    b = AiFinPayAgent.from_seed(seed)
    assert a.solana_address == b.solana_address
    assert a.evm_address == b.evm_address


def test_matches_node_sdk_for_a_fixed_seed():
    """Same fixture asserted in node/tests/walletRecovery.test.ts.

    The two SDKs must derive identical addresses, or an agent created with one
    is unrecoverable with the other.
    """
    agent = AiFinPayAgent.from_seed("11" * 32)
    assert agent.evm_address == "0x467aeE37983Eb1d4aa98e837e7D621bD71Af0F48"
    assert agent.solana_address == "F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4"


def test_distinct_agents_get_distinct_keys():
    a = AiFinPayAgent.new()
    b = AiFinPayAgent.new()
    assert a.solana_address != b.solana_address
    assert a.evm_address != b.evm_address


def test_explicit_evm_key_is_honoured():
    """Importing a pre-existing EVM wallet must keep working."""
    agent = AiFinPayAgent.new(evm_private_key="0x" + "33" * 32)
    derived = AiFinPayAgent.from_seed("44" * 32)
    assert agent.evm_address != derived.evm_address
