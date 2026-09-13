"""Agent-network directory tests. Run: python -m pytest tests/test_network.py

Key invariant: register()/unregister() must sign the EXACT canonical message
the backend re-verifies (routes/network-agents.js -> publishMessage):
    AiFinPay-network-publish:polygon:<lowercased-addr>:<nonce>
We recover the signer from the produced signature with eth_account so a drift
in the template on either side fails this test.
"""

from __future__ import annotations

import json

import pytest
import requests
from eth_account import Account
from eth_account.messages import encode_defunct

from aifinpay import AiFinPayAgent, NetworkAgent

NONCE = "test-nonce-123"


# ── Helpers ──────────────────────────────────────────────────────────────


def _ok_response(body: dict) -> requests.Response:
    r = requests.Response()
    r.status_code = 200
    r._content = json.dumps(body).encode()
    r.headers["Content-Type"] = "application/json"
    return r


def _json_response(status: int, body: dict) -> requests.Response:
    r = requests.Response()
    r.status_code = status
    r._content = json.dumps(body).encode()
    r.headers["Content-Type"] = "application/json"
    return r


def _recover(message: str, signature: str) -> str:
    return Account.recover_message(encode_defunct(text=message), signature=signature)


# ── register ─────────────────────────────────────────────────────────────


def test_register_signs_canonical_message_and_posts_payload():
    agent = AiFinPayAgent.new()
    base = agent.inner.base_url
    addr = agent.evm_address.lower()

    from unittest.mock import patch

    with patch("aifinpay.unified_agent.requests.get") as mget, patch("aifinpay.unified_agent.requests.post") as mpost:
        mget.return_value = _ok_response({"nonce": NONCE})
        mpost.return_value = _ok_response(
            {
                "ok": True,
                "agent": {
                    "address": addr,
                    "name": "Weather Oracle",
                    "description": "Forecasts on demand",
                    "endpoint": "https://weather.example.com/agent",
                    "capabilities": ["weather", "forecast"],
                    "pricing": {"per_call": 0.01, "currency": "USDC"},
                    "rating": None,
                    "published_at": 1_700_000_000,
                    "created_at": 1_700_000_000,
                },
            }
        )

        result = agent.register(
            name="Weather Oracle",
            endpoint="https://weather.example.com/agent",
            description="Forecasts on demand",
            capabilities=["weather", "forecast"],
            pricing={"per_call": 0.01, "currency": "USDC"},
        )

    # 1. nonce fetched, then publish POSTed to the right URLs
    assert mget.call_args.args[0] == f"{base}/api/network/nonce"
    assert mpost.call_args.args[0] == f"{base}/api/network/agents/{addr}/publish"

    # 2. signature recovers to the agent's own EVM address over the canonical msg
    payload = mpost.call_args.kwargs["json"]
    message = f"AiFinPay-network-publish:polygon:{addr}:{NONCE}"
    assert _recover(message, payload["signature"]).lower() == addr

    # 3. payload carries the registration fields + nonce
    assert payload["name"] == "Weather Oracle"
    assert payload["endpoint"] == "https://weather.example.com/agent"
    assert payload["capabilities"] == ["weather", "forecast"]
    assert payload["pricing"] == {"per_call": 0.01, "currency": "USDC"}
    assert payload["nonce"] == NONCE

    # 4. returns the published agent record
    assert isinstance(result, NetworkAgent)
    assert result.name == "Weather Oracle"
    assert result.capabilities == ["weather", "forecast"]


def test_register_defaults_pricing_currency_and_nulls():
    agent = AiFinPayAgent.new()

    from unittest.mock import patch

    with patch("aifinpay.unified_agent.requests.get") as mget, patch("aifinpay.unified_agent.requests.post") as mpost:
        mget.return_value = _ok_response({"nonce": NONCE})
        mpost.return_value = _ok_response({"ok": True, "agent": {"address": agent.evm_address.lower()}})

        agent.register(
            name="Bare Agent",
            endpoint="https://bare.example.com",
            pricing={"per_call": 0.5},
        )

    payload = mpost.call_args.kwargs["json"]
    assert payload["pricing"] == {"per_call": 0.5, "currency": "USDC"}
    assert payload["description"] is None
    assert payload["capabilities"] == []


def test_register_raises_on_backend_rejection():
    agent = AiFinPayAgent.new()

    from unittest.mock import patch

    with patch("aifinpay.unified_agent.requests.get") as mget, patch("aifinpay.unified_agent.requests.post") as mpost:
        mget.return_value = _ok_response({"nonce": NONCE})
        mpost.return_value = _json_response(401, {"error": "signature_invalid"})

        with pytest.raises(Exception, match="network publish failed: signature_invalid"):
            agent.register(name="X", endpoint="https://x.example.com")


# ── unregister ───────────────────────────────────────────────────────────


def test_unregister_signs_unpublish_message():
    agent = AiFinPayAgent.new()
    base = agent.inner.base_url
    addr = agent.evm_address.lower()

    from unittest.mock import patch

    with patch("aifinpay.unified_agent.requests.get") as mget, patch("aifinpay.unified_agent.requests.post") as mpost:
        mget.return_value = _ok_response({"nonce": NONCE})
        mpost.return_value = _ok_response({"ok": True, "published": False})

        agent.unregister()

    assert mpost.call_args.args[0] == f"{base}/api/network/agents/{addr}/unpublish"
    payload = mpost.call_args.kwargs["json"]
    message = f"AiFinPay-network-unpublish:polygon:{addr}:{NONCE}"
    assert _recover(message, payload["signature"]).lower() == addr


# ── search ───────────────────────────────────────────────────────────────


def test_search_bare_capability_parses_agents():
    agent = AiFinPayAgent.new()
    base = agent.inner.base_url

    from unittest.mock import patch

    with patch("aifinpay.unified_agent.requests.get") as mget:
        mget.return_value = _ok_response(
            {
                "count": 1,
                "agents": [
                    {
                        "address": "0x000000000000000000000000000000000000dead",
                        "name": "Weather Oracle",
                        "description": None,
                        "endpoint": "https://w.example.com",
                        "capabilities": ["weather"],
                        "pricing": None,
                        "rating": None,
                        "published_at": 1_700_000_000,
                        "created_at": 1_700_000_000,
                    }
                ],
            }
        )

        agents = agent.search("weather")

    assert mget.call_args.args[0] == f"{base}/api/network/agents"
    assert mget.call_args.kwargs["params"]["capability"] == "weather"
    assert len(agents) == 1
    assert isinstance(agents[0], NetworkAgent)
    assert agents[0].name == "Weather Oracle"


def test_search_passes_q_and_limit():
    agent = AiFinPayAgent.new()

    from unittest.mock import patch

    with patch("aifinpay.unified_agent.requests.get") as mget:
        mget.return_value = _ok_response({"agents": []})
        agent.search(capability="translate", q="spanish", limit=5)

    params = mget.call_args.kwargs["params"]
    assert params["capability"] == "translate"
    assert params["q"] == "spanish"
    assert params["limit"] == 5


def test_search_empty_directory_returns_empty_list():
    agent = AiFinPayAgent.new()

    from unittest.mock import patch

    with patch("aifinpay.unified_agent.requests.get") as mget:
        mget.return_value = _ok_response({"agents": []})
        assert agent.search("nonexistent") == []
