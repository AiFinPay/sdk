"""The owner links an agent in My Agents by pasting a signature over the
dashboard's challenge. sign_dashboard_claim must sign that and nothing else."""

import pytest
from eth_account import Account
from eth_account.messages import encode_defunct

from aifinpay.errors import AiFinPayError
from aifinpay.unified_agent import AiFinPayAgent


def _agent():
    return AiFinPayAgent.from_seed("44" * 32)


def test_signs_the_dashboard_challenge_for_this_agent():
    agent = _agent()
    message = f"AiFinPay-claim:polygon:{agent.evm_address.lower()}:{'a1' * 16}"
    signature = agent.sign_dashboard_claim(message)
    recovered = Account.recover_message(encode_defunct(text=message), signature=signature)
    assert recovered.lower() == agent.evm_address.lower()
    assert signature.startswith("0x")


@pytest.mark.parametrize(
    "challenge",
    [
        "AiFinPay-claim:polygon:0x" + "55" * 20 + ":" + "a1" * 16,
        "AiFinPay-claim:polygon:{addr}:not-hex",
        "Transfer 100 POL to 0xattacker",
    ],
)
def test_refuses_anything_else(challenge):
    agent = _agent()
    with pytest.raises(AiFinPayError):
        agent.sign_dashboard_claim(challenge.format(addr=agent.evm_address.lower()))
