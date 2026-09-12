from unittest.mock import Mock, patch

import pytest

from aifinpay.errors import AiFinPayError
from aifinpay.unified_agent import AiFinPayAgent


PROVIDER = {
    "name": "evil-provider",
    "preferred_chain": "polygon",
    "accepted_chains": ["polygon"],
    "price_usd": 0.01,
    "mode": "per_call",
    "bridge_url": "https://evil.example/bridge",
    "merchant_wallet": "0x1111111111111111111111111111111111111111",
    "service_type": "search",
}


def response(status, payload):
    r = Mock()
    r.status_code = status
    r.ok = status < 400
    r.json.return_value = payload
    return r


def test_legacy_call_refuses_paid_challenge_before_broadcast():
    agent = AiFinPayAgent.new()
    challenge = {"error": "Payment Required", "protocol": "AIFP-1", "pay_native": {
        "chain": "polygon", "splitter": "0x" + "9" * 40,
        "merchant_wallet": "0x" + "8" * 40, "total_wei": "1000", "order_id": "evil",
    }}
    with patch("aifinpay.unified_agent.requests.get", return_value=response(200, {"providers": [PROVIDER]})), \
         patch("aifinpay.unified_agent.requests.request", return_value=response(402, challenge)) as request:
        with pytest.raises(AiFinPayError, match="legacy call.*disabled|not trusted"):
            agent.call("evil-provider")
        request.assert_called_once()


def test_legacy_call_keeps_free_response_available():
    agent = AiFinPayAgent.new()
    with patch("aifinpay.unified_agent.requests.get", return_value=response(200, {"providers": [PROVIDER]})), \
         patch("aifinpay.unified_agent.requests.request", return_value=response(200, {"ok": True})) as request:
        assert agent.call("evil-provider").status_code == 200
        request.assert_called_once()


def test_legacy_call_does_not_accept_caller_cost_for_unknown_provider_price():
    agent = AiFinPayAgent.new()
    challenge = {"error": "Payment Required", "protocol": "AIFP-1"}
    unknown_price = {**PROVIDER, "price_usd": None}
    with patch("aifinpay.unified_agent.requests.get", return_value=response(200, {"providers": [unknown_price]})), \
         patch("aifinpay.unified_agent.requests.request", return_value=response(402, challenge)) as request:
        with pytest.raises(AiFinPayError, match="no trusted positive USD price"):
            agent.call("evil-provider", cost=0.25)
        request.assert_called_once()
