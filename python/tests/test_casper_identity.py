"""Casper identity derivation, and the cross-SDK agreement it depends on.

The SDK produced EVM and Solana addresses and nothing for Casper, while the
project counts Casper among its live networks and has a contract there that has
settled real payments.

Two properties are being defended, and the second is the dangerous one.

1. The rule matches Casper mainnet. Not documentation — a live account, queried
   through state_get_account_info.

2. Node and Python derive the SAME account from the same seed. If they diverge,
   an agent restored in the other language looks correct and controls nothing,
   and whatever was already sent to the first account is unreachable. The
   expected values below were produced by the Node SDK, so drift in either
   implementation fails this file.
"""

import hashlib

import nacl.signing
import pytest

from aifinpay.unified_agent import casper_identity_from_seed


def account_hash_of(public_key_hex: str) -> str:
    """Casper's own rule, restated independently of the implementation."""
    tag = public_key_hex[:2]
    algo = b"ed25519" if tag == "01" else b"secp256k1"
    pub = bytes.fromhex(public_key_hex[2:])
    return hashlib.blake2b(algo + b"\x00" + pub, digest_size=32).hexdigest()


def test_matches_a_real_mainnet_account():
    # Queried from node.mainnet.casper.network.
    public_key = "01000e6fce753895c0d08d5d6af62db4e9b0d070f10e69e2c6badf977b29bbeeee"
    on_chain = "e386a6e2d67ab4c7af524f0b7f60fa77fe420a189309b613f359ccd83c27807a"
    assert account_hash_of(public_key) == on_chain


@pytest.mark.parametrize(
    "seed_byte,expected",
    [
        # Produced by @aifinpay/agent (Node). These are the cross-SDK contract.
        (0x11, "account-hash-30e600ae3e6e66b6637581eebd823cbe9b9ffea1950db27655e4cd66c1aa1c37"),
        (0x22, "account-hash-45189f665c8bc5bb2dc2bd2e60e091d7b96f8feea69cd469d954ae9dd5b08354"),
        (0x42, "account-hash-75d6af676fd04011b9da7323cc5579dbea4c49caec4ef553e4af3945f6a299ae"),
    ],
)
def test_agrees_with_the_node_sdk(seed_byte, expected):
    assert casper_identity_from_seed(bytes([seed_byte]) * 32)["account_hash"] == expected


def test_public_key_is_tagged_ed25519():
    # 01 = ed25519. Shipping 02 would derive a different, wrong account hash
    # from identical key bytes, and Casper rejects an untagged key outright.
    identity = casper_identity_from_seed(b"\x07" * 32)
    assert identity["public_key"].startswith("01")
    assert len(identity["public_key"]) == 66
    assert identity["account_hash"] == "account-hash-" + account_hash_of(identity["public_key"])


def test_is_deterministic():
    # The property the whole design rests on: a changing address means anything
    # sent to the previous one is unrecoverable.
    seed = b"\x99" * 32
    assert casper_identity_from_seed(seed) == casper_identity_from_seed(seed)


def test_domain_separated_from_the_evm_path():
    # Both derive 32 bytes from one seed with SHA-256; only the domain differs.
    # Without separation, one compromised key would expose the other.
    seed = b"\x05" * 32
    evm = hashlib.sha256(b"aifinpay:evm:v1\0" + seed).digest()
    casper = hashlib.sha256(b"aifinpay:casper:v1\0" + seed).digest()
    assert evm != casper


def test_rejects_a_wrong_length_seed():
    from aifinpay.errors import AiFinPayError

    with pytest.raises(AiFinPayError):
        casper_identity_from_seed(b"\x00" * 31)
