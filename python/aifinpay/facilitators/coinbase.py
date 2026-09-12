"""Coinbase x402 flavor — `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` headers.

Reference: github.com/coinbase/x402

Detection works today. Payment execution is stubbed because the EVM /
SVM signing path requires a chain-specific wallet that the current Agent
doesn't carry yet (it has only an Ed25519 / Solana key). Wiring an EVM
key plus EIP-3009 `transferWithAuthorization` flow is scheduled for a
later SDK minor (see `14 - Design - Generic x402 Client.md` in vault).
"""
from __future__ import annotations

import base64
import json
from typing import TYPE_CHECKING, Any, Optional

import requests

from ..errors import (
    FacilitatorNotImplementedError,
    PaymentTooExpensiveError,
    UnsupportedFacilitatorError,
)
from .base import PayOptions

if TYPE_CHECKING:
    from ..client import Agent


PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED"
PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE"
PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE"


def _decode_payment_required(resp: requests.Response) -> dict[str, Any]:
    raw = resp.headers.get(PAYMENT_REQUIRED_HEADER)
    if not raw:
        raise UnsupportedFacilitatorError(
            f"missing {PAYMENT_REQUIRED_HEADER} header on Coinbase x402 response"
        )
    try:
        decoded = base64.b64decode(raw).decode("utf-8")
    except Exception as e:
        raise UnsupportedFacilitatorError(
            f"{PAYMENT_REQUIRED_HEADER} is not valid base64: {e}"
        ) from e
    try:
        return json.loads(decoded)
    except json.JSONDecodeError as e:
        raise UnsupportedFacilitatorError(
            f"{PAYMENT_REQUIRED_HEADER} body is not valid JSON: {e}"
        ) from e


class CoinbaseX402Facilitator:
    """Adapter for the Coinbase / public x402 spec."""

    name = "coinbase-x402"

    @staticmethod
    def detect(resp: requests.Response) -> bool:
        if resp.status_code != 402:
            return False
        return PAYMENT_REQUIRED_HEADER in resp.headers

    def build_auth(
        self,
        resp: requests.Response,
        agent: "Agent",
        opts: PayOptions,
        context: Optional[dict[str, Any]] = None,
    ) -> dict:
        # Parse the spec object so callers see useful errors instead of
        # opaque "not implemented".
        spec = _decode_payment_required(resp)

        # Best-effort cost extraction. Coinbase x402 PaymentRequirements
        # describe an array of `accepts` with per-scheme amount + asset.
        # We pick the first option whose maxAmountRequired we can cap.
        accepts = spec.get("accepts") or spec.get("paymentRequirements") or []
        if accepts and opts.max_amount_usd is not None:
            cheapest = _min_usd(accepts)
            if cheapest is not None and cheapest > opts.max_amount_usd:
                raise PaymentTooExpensiveError(
                    f"Coinbase x402 wants ${cheapest:.4f}, "
                    f"caller cap is ${opts.max_amount_usd:.4f}"
                )

        # Execution is the missing piece. We need an EVM (or SVM) key + a
        # facilitator's /verify and /settle endpoints. Until that ships:
        raise FacilitatorNotImplementedError(
            "Coinbase x402 detected, but payment execution is not yet wired. "
            "This SDK build supports detection + parsing only. "
            "Track progress in `14 - Design - Generic x402 Client.md`."
        )


def _min_usd(accepts: list[dict[str, Any]]) -> float | None:
    """Pull the smallest USD-equivalent amount across `accepts` entries.

    Coinbase x402 amounts are typically `maxAmountRequired` in the asset's
    smallest unit. Without an oracle we can only honor entries that come
    pre-priced in USD. Returns None if nothing is comparable.
    """
    candidates: list[float] = []
    for entry in accepts:
        usd = entry.get("priceUsd") or entry.get("usdPrice")
        if isinstance(usd, (int, float)):
            candidates.append(float(usd))
    return min(candidates) if candidates else None
