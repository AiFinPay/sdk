"""Cross-chain orchestration tests. Run: python -m pytest tests/test_cross_chain.py"""

from __future__ import annotations

import json
from unittest.mock import MagicMock, patch

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


def test_bridge_wait_for_arrival_times_out_without_claiming_failure():
    # The message used to read "timeout after Nms — source tx ... did not
    # finalise on dest". At the deadline we know only that we never saw it
    # complete, which is a different fact: one is actionable, the other sends
    # an agent re-sending money that is already on the other side.
    with patch("aifinpay.cross_chain.requests.get") as mock_get, patch("aifinpay.cross_chain.time.sleep") as _sleep:
        mock_get.return_value = _ok_response({"status": "PENDING"})
        with pytest.raises(AiFinPayError, match="without observing completion"):
            bridge_wait_for_arrival("0xsrc", poll_interval_ms=1, timeout_ms=5)


# ── A rate limit is not a failed bridge ─────────────────────────────────
#
# LiFi allows callers without an API key 75 requests per two hours, and this
# SDK sends none. Polling every 5s for up to 30 minutes asked up to 360 times
# for one transfer, and every non-2xx answer was treated exactly like "not
# arrived yet" — so a CCTP transfer, which this module says takes 15-25 min on
# Polygon, exhausted the quota around minute six and was then reported as not
# having finalised. For a transfer that had.


def _resp(status_code, body=None, headers=None):
    r = MagicMock()
    r.ok = 200 <= status_code < 300
    r.status_code = status_code
    r.headers = headers or {}
    r.json.return_value = body or {}
    return r


def test_a_persistent_429_is_reported_as_unreadable_not_as_absent():
    with patch("aifinpay.cross_chain.requests.get") as mock_get, \
         patch("aifinpay.cross_chain.time.sleep") as _sleep:
        mock_get.return_value = _resp(429, {}, {"retry-after": "0"})
        with pytest.raises(AiFinPayError) as exc:
            bridge_wait_for_arrival("0xsrc", poll_interval_ms=1, timeout_ms=60_000)
    msg = str(exc.value)
    assert "cannot READ" in msg
    assert "NOT evidence that it failed" in msg
    assert "75 requests" in msg
    # and it stops early rather than spending the whole window on 429s
    assert mock_get.call_count <= 10


def test_a_transient_429_followed_by_done_still_returns_done():
    with patch("aifinpay.cross_chain.requests.get") as mock_get, \
         patch("aifinpay.cross_chain.time.sleep") as _sleep:
        mock_get.side_effect = [
            _resp(429, {}, {"retry-after": "0"}),
            _resp(429, {}, {"retry-after": "0"}),
            _ok_response({"status": "DONE", "receiving": {"txHash": "0xdest"}}),
        ]
        out = bridge_wait_for_arrival("0xsrc", poll_interval_ms=1, timeout_ms=60_000)
    assert out["status"] == "done"
    assert out["dest_tx"] == "0xdest"


def test_a_sustained_network_failure_surfaces_instead_of_being_swallowed():
    # This used to be `except RequestException: pass` for the full window, so a
    # dead network looked exactly like a slow bridge for thirty minutes.
    with patch("aifinpay.cross_chain.requests.get") as mock_get, \
         patch("aifinpay.cross_chain.time.sleep") as _sleep:
        mock_get.side_effect = requests.RequestException("connection reset")
        with pytest.raises(AiFinPayError, match="cannot REACH LiFi"):
            bridge_wait_for_arrival("0xsrc", poll_interval_ms=1, timeout_ms=60_000)


def test_the_default_poll_interval_fits_the_quota_it_is_given():
    # 30 minutes at 5s is 360 requests against a budget of 75. This fails if
    # someone lowers it back for responsiveness without reading the header.
    from aifinpay.cross_chain import DEFAULT_POLL_INTERVAL_MS
    assert (30 * 60 * 1000) / DEFAULT_POLL_INTERVAL_MS <= 90


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
