"""/.well-known/x402.json — how an agent learns a site takes payments before
it spends a request on a 402. Same document as @aifinpay/gate's."""

from typing import Any, Dict, Iterable, Mapping

from .challenge import DEFAULT_API_BASE
from .pricing import unit_price_usd

DISCOVERY_PATH = "/.well-known/x402.json"


def build_discovery_document(
    merchant_id: str, resources: Iterable[Mapping[str, Any]], api_base: str = DEFAULT_API_BASE
) -> Dict[str, Any]:
    """``resources``: ``{"resource": "/api/x", "tier": "standard", "scope": "exact", "name": ...}``."""
    api = (api_base or DEFAULT_API_BASE).rstrip("/")
    return {
        "x402_version": 1,
        "protocol": "AIFP-1",
        "merchant_id": merchant_id,
        "quote_endpoint": f"{api}/v1/quote",
        "pay_endpoint": f"{api}/v1/pay",
        "onboarding": "npx @aifinpay/mcp init",
        "documentation_url": "https://github.com/AiFinPay/sdk/blob/main/AGENT-FLOW.md",
        "instructions_url": "https://raw.githubusercontent.com/AiFinPay/skill/main/agent/skills/aifinpay/SKILL.md",
        "merchant_instructions_url":
            "https://raw.githubusercontent.com/AiFinPay/skill/main/agent/skills/aifinpay-merchant/SKILL.md",
        "resources": [
            {
                "resource": r["resource"],
                **({"name": r["name"]} if r.get("name") else {}),
                "tier": r.get("tier") or "standard",
                "scope": r.get("scope") or "exact",
                "unit_price_usd": unit_price_usd(r.get("tier") or "standard"),
            }
            for r in resources
        ],
        "settlement_terms_from": f"{api}/v1/quote",
    }
