"""The royalty slot defaults to address(0), which pays the MERCHANT — not us.

The fallback used to be the splitter's own treasury, justified in the code as:

    Passing address(0) would skip the transfer and permanently strand the 1bp
    inside B2BSplitter — no sweep function.

B2BSplitter._split does not do that::

    if (_ipCreator != address(0)) { ipAmt = ...; }
    // else: ipAmt stays 0 and is absorbed into merchantAmt below
    merchantAmt = _total - treasuryAmt - ipAmt;
    ...
    if (ipAmt > 0) { transfer to _ipCreator }

With address(0) the share is not stranded — the merchant keeps it, and no
transfer is attempted. The premise was wrong, and the consequence was that
0.01% of every unattributed payment moved from the merchant to us, silently,
while /v1/quote published a 99/1/0 split.

Observed on-chain 2026-08-27, tx 0x6b853876…: merchant 98.99%, treasury 1.00%,
and 0.01% paid to 0xD31d82…3c8e — our own Safe. AIFINP-211.
"""
import re
from pathlib import Path

SRC = (Path(__file__).resolve().parents[1] / "aifinpay" / "unified_agent.py").read_text()


def _evm_block() -> str:
    """The EVM payment branch, where the ipCreator argument is chosen."""
    start = SRC.index("# ipCreator routing")
    return SRC[start : start + 2000]


def test_ip_creator_falls_back_to_the_zero_address():
    block = _evm_block()
    assert 'pm.get("ip_creator") or ("0x" + "00" * 20)' in block, (
        "the ipCreator fallback is not address(0) — an unattributed payment "
        "diverts the royalty share away from the merchant"
    )


def test_the_treasury_is_not_used_as_a_default_recipient():
    """Naming ourselves as the royalty recipient collects a fee we did not quote."""
    block = _evm_block()
    assert "_splitter_treasury" not in block, (
        "the treasury is being substituted as ipCreator again — that is 0.01% of "
        "every payment taken from the merchant without being published anywhere"
    )


def test_an_explicit_ip_creator_is_still_honoured():
    """The change is to the DEFAULT. A challenge that names a creator keeps it."""
    block = _evm_block()
    assert 'pm.get("ip_creator")' in block, (
        "an explicitly supplied ip_creator is no longer read"
    )


def test_the_reason_is_recorded_next_to_the_code():
    """The old premise was plausible and wrong; the next reader needs the contract quoted."""
    block = _evm_block()
    assert "absorbed into merchantAmt" in block, (
        "the comment no longer explains what the contract actually does with "
        "address(0) — which is the fact the previous fallback got wrong"
    )
