"""/.well-known/x402.json — how an agent learns a site takes payments before
it spends a request on a 402. Same document as @aifinpay/gate's."""

from typing import Any, Dict, Iterable, Mapping, Optional, Union

from .challenge import DEFAULT_API_BASE
from .pricing import unit_price_usd

DISCOVERY_PATH = "/.well-known/x402.json"
LLMS_TXT_PATH = "/llms.txt"


def discovery_link_header(setting: Union[bool, Mapping[str, Any], None] = True) -> Optional[str]:
    """The ``Link`` header the middlewares add to every HTML response they let
    through, so an agent that opened a page (the home page above all) finds
    ``/llms.txt`` and this document. Same value as ``discoveryLinkHeader`` in
    @aifinpay/gate. ``False`` switches it off; a mapping with ``llms_txt`` /
    ``x402`` moves either target, or drops it with ``False``."""
    if setting is False:
        return None
    opts = setting if isinstance(setting, Mapping) else {}
    llms = opts.get("llms_txt", LLMS_TXT_PATH)
    x402 = opts.get("x402", DISCOVERY_PATH)
    links = []
    if llms is not False:
        links.append(f'<{llms}>; rel="alternate"; type="text/markdown"; title="AI agents: access and payment"')
    if x402 is not False:
        links.append(f'<{x402}>; rel="describedby"; type="application/json"')
    return ", ".join(links) or None


def is_html_content_type(content_type: Optional[str]) -> bool:
    """Only HTML pages get the link: JSON already speaks to agents through the 402."""
    kind = (content_type or "").split(";", 1)[0].strip().lower()
    return kind in ("text/html", "application/xhtml+xml")


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
