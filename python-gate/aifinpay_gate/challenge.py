"""The 402 body, key for key what @aifinpay/gate and the hosted gateway emit.

It is the only documentation an agent gets before any relationship exists, so
it carries the whole purchase path. tests/test_parity.py compares it with the
Node package's output, byte for byte."""

from typing import Any, Dict, Optional

from .pricing import PROTOCOL_FEE_BPS, min_requests_for_tier, unit_price_usd

DEFAULT_API_BASE = "https://api.aifinpay.io"
DEFAULT_DETAIL = "Payment Required — prepay a batch of requests and retry with the AIFP-Receipt header"


def build_challenge(
    merchant_id: str,
    resource: str,
    tier: str,
    weight: int,
    detail: Optional[str] = None,
    scope: Optional[str] = None,
    unit_price: Optional[str] = None,
    min_requests: Optional[int] = None,
    api_base: Optional[str] = None,
) -> Dict[str, Any]:
    # Absolute on purpose: this gate runs on the merchant's host, so a relative
    # "/v1/quote" would send the agent to the merchant's own server.
    api = (api_base or DEFAULT_API_BASE).rstrip("/")
    scope = scope or "exact"
    requests_ = min_requests if min_requests is not None else min_requests_for_tier(tier)
    return {
        "error": "AIFP-402",
        "detail": detail or DEFAULT_DETAIL,
        "protocol": "AIFP-1",
        "documentation_url": "https://github.com/AiFinPay/sdk/blob/main/AGENT-FLOW.md",
        "instructions_url": "https://raw.githubusercontent.com/AiFinPay/skill/main/agent/skills/aifinpay/SKILL.md",
        "merchant_instructions_url":
            "https://raw.githubusercontent.com/AiFinPay/skill/main/agent/skills/aifinpay-merchant/SKILL.md",
        "merchant_id": merchant_id,
        "resource": resource,
        "tier": tier,
        "unit_weight": weight,
        "unit_price_usd": unit_price or unit_price_usd(tier),
        "min_requests": requests_,
        "scope": scope,
        "protocol_fee_bps": PROTOCOL_FEE_BPS,
        "no_minimum_fee": True,
        "settlement_terms_from":
            f"POST {api}/v1/quote — returns accepted_chains, accepted_assets, amount, order_id and expiry",
        "how_to_pay": [
            f'POST {api}/v1/quote {{"merchant_id":"{merchant_id}","resource":"{resource}","tier":"{tier}",'
            f'"scope":"{scope}","requests":{requests_},"payer":"<your wallet address>"}} — payer is required; '
            "raise requests to buy more than the minimum batch; check amount, scope, expiry and payer before paying",
            "settle the quoted batch on-chain from your own wallet (order_id = quote_id)",
            f"POST {api}/v1/pay {{quote_id, chain, asset, tx_ref, payment_authorization}} + Idempotency-Key header "
            "-> quota receipt (wallet-signature-v1). Keep the quote until you hold the receipt; on a timeout retry "
            "with the same key and tx_ref — never pay again",
            "retry this request with header: AIFP-Receipt: <receipt JWT>",
        ],
        "no_wallet": "npx @aifinpay/mcp init — creates or selects a local wallet; read instructions_url for supported "
                     "clients and payment availability. Wallet setup alone does not enable settlement.",
    }
