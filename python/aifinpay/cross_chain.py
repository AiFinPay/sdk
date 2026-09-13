"""
Cross-chain orchestration via LiFi (Phase 1.5a — EVM↔EVM).

Mirrors `aifinpay-sdk/node/src/crossChain.ts`. We do NOT depend on a
LiFi-specific SDK — we call the public REST API at https://li.quest/v1
directly with `requests`, so the SDK footprint stays tiny and the flow
is easy to mock in tests.

Architectural note — Obsidian/21 - Unified Agent Economy.md non-goal:
    "We do not move funds ourselves. Cross-chain settlement is delegated
     to established bridges (LiFi, Jupiter, Wormhole) — we orchestrate
     the sequence and the agent signs every step."

This file is the orchestration layer for EVM↔EVM. Solana↔EVM will live
in `cross_chain_solana.py` (Phase 1.5b: Wormhole/deBridge + Jupiter swap).
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Any

import requests

from .errors import AiFinPayError

LIFI_API = "https://li.quest/v1"

# ── Supported EVM chains for cross-chain settlement ──────────────────────
# EVM chain IDs (canonical, used by both web3.py and LiFi). Ported verbatim
# from the Node SDK.
EVM_CHAINS: dict[str, int] = {
    "ethereum": 1,
    "polygon": 137,
    "bsc": 56,
    "arbitrum": 42161,
    "optimism": 10,
    "base": 8453,
}

# USDC token addresses per chain. Native (Circle CCTP) variant where it
# exists; bridged USDC.e listed in `USDC_BRIDGED` for legacy compatibility.
USDC_NATIVE: dict[str, str] = {
    "ethereum": "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
    "polygon": "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    "bsc": "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d",
    "arbitrum": "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
    "optimism": "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    "base": "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
}

USDC_BRIDGED: dict[str, str] = {
    "polygon": "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    "arbitrum": "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8",
}


# ── Dataclasses ─────────────────────────────────────────────────────────


@dataclass
class BridgeQuoteFrom:
    chain: str
    token: str
    amount: str


@dataclass
class BridgeQuoteTo:
    chain: str
    token: str
    amount: str
    amount_min: str


@dataclass
class BridgeQuoteFees:
    bridge_usd: float
    gas_usd: float
    total_usd: float


@dataclass
class BridgeQuote:
    """Subset of LiFi's quote response; full payload in `raw_quote`."""

    from_: BridgeQuoteFrom
    to: BridgeQuoteTo
    fees: BridgeQuoteFees
    eta_seconds: int
    bridge_tool: str
    raw_quote: dict[str, Any] = field(default_factory=dict)


@dataclass
class BridgeReceipt:
    source_tx: str
    source_chain: str
    dest_chain: str
    bridge_tool: str
    status: str  # "submitted" | "pending" | "done" | "failed"
    dest_tx: [str] = None


# ── Quote ───────────────────────────────────────────────────────────────


def bridge_quote(
    *,
    from_chain: str,
    to_chain: str,
    from_token: str,
    to_token: str,
    from_amount: str,
    from_address: str,
    to_address: [str] = None,
    slippage: [float] = None,
    integrator: str = "aifinpay",
    timeout: float = 30.0,
) -> BridgeQuote:
    """Fetch a cross-chain quote from LiFi.

    `from_amount` is in base units as a string (USDC = 6 decimals, so $1.00
    is "1000000"). Use the convenience method on `AiFinPayAgent.bridge_quote`
    to pass `amount_usdc` directly.

    `integrator` is forwarded to LiFi for analytics + revenue share with
    project partners; defaults to "aifinpay" so all our agent-driven volume
    is tagged.
    """
    if from_chain not in EVM_CHAINS:
        raise AiFinPayError(f"bridge_quote: unknown from_chain {from_chain!r}")
    if to_chain not in EVM_CHAINS:
        raise AiFinPayError(f"bridge_quote: unknown to_chain {to_chain!r}")

    params: dict[str, Any] = {
        "fromChain": EVM_CHAINS[from_chain],
        "toChain": EVM_CHAINS[to_chain],
        "fromToken": from_token,
        "toToken": to_token,
        "fromAmount": from_amount,
        "fromAddress": from_address,
        "integrator": integrator,
    }
    if to_address is not None:
        params["toAddress"] = to_address
    if slippage is not None:
        params["slippage"] = slippage

    r = requests.get(f"{LIFI_API}/quote", params=params, timeout=timeout)
    if not r.ok:
        detail = (r.text or "<unreadable>")[:300]
        raise AiFinPayError(
            f"bridge_quote: LiFi /quote returned {r.status_code} for " f"{from_chain}->{to_chain}: {detail}"
        )
    j = r.json()

    estimate = j.get("estimate", {}) or {}
    fee_costs = estimate.get("feeCosts") or []
    gas_costs = estimate.get("gasCosts") or []
    bridge_usd = sum(float(f.get("amountUSD", 0) or 0) for f in fee_costs)
    gas_usd = sum(float(g.get("amountUSD", 0) or 0) for g in gas_costs)

    tool_details = j.get("toolDetails") or {}
    bridge_tool = tool_details.get("name") or j.get("tool", "")

    return BridgeQuote(
        from_=BridgeQuoteFrom(
            chain=from_chain,
            token=from_token,
            amount=str(estimate.get("fromAmount", from_amount)),
        ),
        to=BridgeQuoteTo(
            chain=to_chain,
            token=to_token,
            amount=str(estimate.get("toAmount", "0")),
            amount_min=str(estimate.get("toAmountMin", "0")),
        ),
        fees=BridgeQuoteFees(
            bridge_usd=bridge_usd,
            gas_usd=gas_usd,
            total_usd=bridge_usd + gas_usd,
        ),
        eta_seconds=int(estimate.get("executionDuration") or 0),
        bridge_tool=bridge_tool,
        raw_quote=j,
    )


# ── Execute ─────────────────────────────────────────────────────────────


def bridge_execute(
    quote: BridgeQuote,
    *,
    evm_account: Any,  # eth_account.LocalAccount
    web3: Any,  # web3.Web3 instance connected to source chain
) -> BridgeReceipt:
    """Submit the source-chain transaction returned by `bridge_quote()`.

    Signs and submits the LiFi-returned `transactionRequest` on the SOURCE
    chain with the agent's EVM key. Returns once source-side inclusion is
    confirmed; dest-side arrival is async — call `bridge_wait_for_arrival(
    receipt.source_tx)` if you need to block on it.

    The agent signs and submits. AiFinPay never touches the funds.

    Note: web3.py is a required dependency of this SDK (declared in
    pyproject.toml), so this method works out of the box. The caller must
    pass a Web3 instance already pointed at the source chain's RPC — we
    don't switch chains for the caller, matching the Node SDK's explicit
    choice to keep this primitive small.
    """
    raw = quote.raw_quote or {}
    tx = raw.get("transactionRequest")
    if not tx:
        raise AiFinPayError(
            "bridge_execute: quote has no transactionRequest — likely returned " "by /quote/toAmount which we don't use"
        )

    # Sanity-check the Web3 instance is on the source chain.
    try:
        chain_id = web3.eth.chain_id
    except Exception as e:
        raise AiFinPayError(f"bridge_execute: web3 not connected: {e}") from e
    expected_chain_id = int(tx.get("chainId", EVM_CHAINS[quote.from_.chain]))
    if chain_id != expected_chain_id:
        raise AiFinPayError(
            f"bridge_execute: web3 is on chain {chain_id}, quote requires " f"{expected_chain_id} ({quote.from_.chain})"
        )

    # Build the tx. LiFi returns hex strings for value / gasLimit.
    value = int(tx.get("value", "0x0"), 16) if isinstance(tx.get("value"), str) else int(tx.get("value") or 0)
    gas_limit = int(tx["gasLimit"], 16) if isinstance(tx.get("gasLimit"), str) else int(tx.get("gasLimit") or 0)

    nonce = web3.eth.get_transaction_count(evm_account.address)
    tx_payload: dict[str, Any] = {
        "from": evm_account.address,
        "to": tx["to"],
        "data": tx["data"],
        "value": value,
        "nonce": nonce,
        "chainId": expected_chain_id,
        "gasPrice": web3.eth.gas_price,
    }
    if gas_limit:
        tx_payload["gas"] = gas_limit
    else:
        try:
            tx_payload["gas"] = int(web3.eth.estimate_gas(tx_payload) * 1.2)
        except Exception:
            tx_payload["gas"] = 500_000  # safe default for bridge txs

    signed = web3.eth.account.sign_transaction(tx_payload, evm_account.key)
    # web3 v7: raw_transaction; v6: rawTransaction — support both.
    raw = getattr(signed, "raw_transaction", None)
    if raw is None:
        raw = signed.rawTransaction
    tx_hash = web3.eth.send_raw_transaction(raw)
    receipt = web3.eth.wait_for_transaction_receipt(tx_hash, timeout=180)
    tx_hash_hex = tx_hash.hex() if hasattr(tx_hash, "hex") else str(tx_hash)
    if not tx_hash_hex.startswith("0x"):
        tx_hash_hex = "0x" + tx_hash_hex

    if receipt.status != 1:
        return BridgeReceipt(
            source_tx=tx_hash_hex,
            source_chain=quote.from_.chain,
            dest_chain=quote.to.chain,
            bridge_tool=quote.bridge_tool,
            status="failed",
        )
    return BridgeReceipt(
        source_tx=tx_hash_hex,
        source_chain=quote.from_.chain,
        dest_chain=quote.to.chain,
        bridge_tool=quote.bridge_tool,
        status="submitted",
    )


# ── Status polling ──────────────────────────────────────────────────────


def bridge_wait_for_arrival(
    source_tx_hash: str,
    *,
    poll_interval_ms: int = 5000,
    timeout_ms: int = 30 * 60 * 1000,
    request_timeout: float = 30.0,
) -> dict[str, Any]:
    """Poll LiFi's /v1/status for cross-chain arrival.

    Stargate/Across typically finalise in 30s-3min; Circle CCTP can take
    15-25min on Polygon side. Returns a dict with::

        {"status": "done" | "failed", "dest_tx": str | None, "raw": ...}

    Raises `AiFinPayError` on timeout.
    """
    poll_s = poll_interval_ms / 1000.0
    deadline = time.time() + (timeout_ms / 1000.0)

    while time.time() < deadline:
        try:
            r = requests.get(
                f"{LIFI_API}/status",
                params={"txHash": source_tx_hash},
                timeout=request_timeout,
            )
            if r.ok:
                j = r.json()
                status = j.get("status")
                if status == "DONE":
                    receiving = j.get("receiving") or {}
                    return {
                        "status": "done",
                        "dest_tx": receiving.get("txHash"),
                        "raw": j,
                    }
                if status in ("FAILED", "INVALID"):
                    return {"status": "failed", "dest_tx": None, "raw": j}
        except requests.RequestException:
            # Transient network errors are swallowed; we'll retry on the
            # next poll. A persistent outage hits the timeout below.
            pass
        time.sleep(poll_s)

    raise AiFinPayError(
        f"bridge_wait_for_arrival: timeout after {timeout_ms}ms — "
        f"source tx {source_tx_hash} did not finalise on dest"
    )
