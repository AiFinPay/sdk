"""Cross-chain orchestration tests. Run: python -m pytest tests/test_cross_chain.py"""

from __future__ import annotations

import json
from unittest.mock import patch

import pytest
import requests

from aifinpay import (
    EVM_CHAINS,
    USDC_NATIVE,
    BridgeQuote,
    bridge_quote,
    bridge_wait_for_arrival,
)
from aifinpay.errors import AiFinPayError

# ── Helpers ──────────────────────────────────────────────────────────────


def _ok_response(body: dict) -> requests.Response:
    r = requests.Response()
    r.status_code = 200
    r._content = json.dumps(body).encode()
    r.headers["Content-Type"] = "application/json"
    return r


def _err_response(status: int, text: str = "boom") -> requests.Response:
    r = requests.Response()
    r.status_code = status
    r._content = text.encode()
    return r


_SAMPLE_LIFI_QUOTE = {
    "estimate": {
        "fromAmount": "1000000",
        "toAmount": "999500",
        "toAmountMin": "998000",
        "feeCosts": [
            {"amountUSD": "0.12", "name": "stargate-fee"},
        ],
        "gasCosts": [
            {"amountUSD": "0.08"},
        ],
        "executionDuration": 47,
    },
    "transactionRequest": {
        "to": "0x1111111111111111111111111111111111111111",
        "data": "0xdeadbeef",
        "value": "0x0",
        "gasLimit": "0x186a0",
        "chainId": 8453,
    },
    "tool": "stargate",
    "toolDetails": {"name": "Stargate"},
    "action": {
        "fromChainId": 8453,
        "toChainId": 137,
        "fromToken": {"address": USDC_NATIVE["base"]},
        "toToken": {"address": USDC_NATIVE["polygon"]},
    },
}


# ── Constants ────────────────────────────────────────────────────────────


def test_evm_chains_match_node_sdk():
    assert EVM_CHAINS["polygon"] == 137
    assert EVM_CHAINS["base"] == 8453
    assert EVM_CHAINS["arbitrum"] == 42161


def test_usdc_native_addresses_present():
    for chain in ("ethereum", "polygon", "arbitrum", "optimism", "base"):
        assert USDC_NATIVE[chain].startswith("0x")
        assert len(USDC_NATIVE[chain]) == 42


# ── bridge_quote ─────────────────────────────────────────────────────────


def test_bridge_quote_populates_dataclass():
    """Mock LiFi /quote and verify BridgeQuote is populated correctly."""
    with patch("aifinpay.cross_chain.requests.get") as mock_get:
        mock_get.return_value = _ok_response(_SAMPLE_LIFI_QUOTE)

        q = bridge_quote(
            from_chain="base",
            to_chain="polygon",
            from_token=USDC_NATIVE["base"],
            to_token=USDC_NATIVE["polygon"],
            from_amount="1000000",
            from_address="0xabc0000000000000000000000000000000000001",
        )

    assert isinstance(q, BridgeQuote)
    assert q.from_.chain == "base"
    assert q.from_.amount == "1000000"
    assert q.to.chain == "polygon"
    assert q.to.amount == "999500"
    assert q.to.amount_min == "998000"
    assert q.fees.bridge_usd == pytest.approx(0.12)
    assert q.fees.gas_usd == pytest.approx(0.08)
    assert q.fees.total_usd == pytest.approx(0.20)
    assert q.eta_seconds == 47
    assert q.bridge_tool == "Stargate"
    assert q.raw_quote["tool"] == "stargate"


def test_bridge_quote_sends_correct_lifi_params():
    """Verify we hit https://li.quest/v1/quote with the right query params."""
    with patch("aifinpay.cross_chain.requests.get") as mock_get:
        mock_get.return_value = _ok_response(_SAMPLE_LIFI_QUOTE)
        bridge_quote(
            from_chain="base",
            to_chain="polygon",
            from_token=USDC_NATIVE["base"],
            to_token=USDC_NATIVE["polygon"],
            from_amount="1000000",
            from_address="0xabc0000000000000000000000000000000000001",
            slippage=0.005,
        )

    args, kwargs = mock_get.call_args
    assert args[0] == "https://li.quest/v1/quote"
    params = kwargs["params"]
    assert params["fromChain"] == 8453
    assert params["toChain"] == 137
    assert params["fromToken"] == USDC_NATIVE["base"]
    assert params["toToken"] == USDC_NATIVE["polygon"]
    assert params["fromAmount"] == "1000000"
    assert params["fromAddress"] == "0xabc0000000000000000000000000000000000001"
    assert params["slippage"] == 0.005
    assert params["integrator"] == "aifinpay"


def test_bridge_quote_rejects_unknown_chain():
    with pytest.raises(AiFinPayError, match="unknown from_chain"):
        bridge_quote(
            from_chain="not-a-chain",
            to_chain="polygon",
            from_token=USDC_NATIVE["polygon"],
            to_token=USDC_NATIVE["polygon"],
            from_amount="1",
            from_address="0xabc",
        )


def test_bridge_quote_raises_on_lifi_http_error():
    with patch("aifinpay.cross_chain.requests.get") as mock_get:
        mock_get.return_value = _err_response(429, "rate limited")
        with pytest.raises(AiFinPayError, match="LiFi /quote returned 429"):
            bridge_quote(
                from_chain="base",
                to_chain="polygon",
                from_token=USDC_NATIVE["base"],
                to_token=USDC_NATIVE["polygon"],
                from_amount="1000000",
                from_address="0xabc",
            )


# ── bridge_wait_for_arrival ──────────────────────────────────────────────


def test_bridge_wait_for_arrival_returns_done():
    with patch("aifinpay.cross_chain.requests.get") as mock_get, patch("aifinpay.cross_chain.time.sleep") as _sleep:
        mock_get.return_value = _ok_response(
            {
                "status": "DONE",
                "receiving": {"txHash": "0xdest"},
            }
        )
        out = bridge_wait_for_arrival("0xsrc", poll_interval_ms=1, timeout_ms=1000)
    assert out["status"] == "done"
    assert out["dest_tx"] == "0xdest"


def test_bridge_wait_for_arrival_returns_failed():
    with patch("aifinpay.cross_chain.requests.get") as mock_get, patch("aifinpay.cross_chain.time.sleep") as _sleep:
        mock_get.return_value = _ok_response({"status": "FAILED"})
        out = bridge_wait_for_arrival("0xsrc", poll_interval_ms=1, timeout_ms=1000)
    assert out["status"] == "failed"


def test_bridge_wait_for_arrival_times_out():
    with patch("aifinpay.cross_chain.requests.get") as mock_get, patch("aifinpay.cross_chain.time.sleep") as _sleep:
        mock_get.return_value = _ok_response({"status": "PENDING"})
        with pytest.raises(AiFinPayError, match="timeout after"):
            bridge_wait_for_arrival("0xsrc", poll_interval_ms=1, timeout_ms=5)


# ── AiFinPayAgent.bridge_quote convenience wrapper ──────────────────────


def test_agent_bridge_quote_defaults_to_native_usdc():
    """Calling agent.bridge_quote(amount_usdc=1.0) should auto-fill USDC
    addresses and convert 1.0 → "1000000" (6 decimals)."""
    from aifinpay import AiFinPayAgent

    agent = AiFinPayAgent.new()
    with patch("aifinpay.cross_chain.requests.get") as mock_get:
        mock_get.return_value = _ok_response(_SAMPLE_LIFI_QUOTE)
        q = agent.bridge_quote(
            from_chain="base",
            to_chain="polygon",
            amount_usdc=1.0,
        )

    args, kwargs = mock_get.call_args
    params = kwargs["params"]
    assert params["fromToken"] == USDC_NATIVE["base"]
    assert params["toToken"] == USDC_NATIVE["polygon"]
    assert params["fromAmount"] == "1000000"
    assert params["fromAddress"] == agent.evm_address
    assert isinstance(q, BridgeQuote)


def test_agent_bridge_quote_requires_amount():
    from aifinpay import AiFinPayAgent

    agent = AiFinPayAgent.new()
    with pytest.raises(AiFinPayError, match="provide either amount_usdc"):
        agent.bridge_quote(from_chain="base", to_chain="polygon")
