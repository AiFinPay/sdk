"""AiFinPay gate for Python merchants — accept AIFP-1 payments from AI agents.

A port of ``@aifinpay/gate``: the same 402 challenge, the same local EdDSA
receipt verification against the AiFinPay JWKS, the same post-increment quota
metering. See README.md.
"""

from .agents import AI_AGENT_UA_MARKERS, AI_AGENT_UA_TABLE, GATE_OPERATORS, UA_CLASSES, classify_agent, known_ai_agent
from .asgi import AifpGateMiddleware
from .challenge import build_challenge
from .core import (
    DETAIL_QUOTA_EXHAUSTED,
    DETAIL_RECEIPT_EXPIRED,
    DETAIL_VERIFY_FAILED,
    HEADER_MODE,
    HEADER_QUOTA_REMAINING,
    HEADER_SHADOW_STATUS,
    Gate,
    GateResult,
    Route,
    SimpleRequest,
)
from .discovery import LLMS_TXT_PATH, build_discovery_document, discovery_link_header, is_html_content_type
from .operator_policy import OPERATOR_ACTIONS, OPERATOR_DEFAULT, decide_operator, normalize_operator_policy
from .reporter import GateReporter, GateReporterV2, ReportingFlow
from .pricing import TIER_WEIGHTS, UNIT_PRICE_USD, min_requests_for_tier, unit_price_usd, weight_for_tier
from .scope import pattern_covers, scope_covers
from .stores import REDIS_INCRBY_SCRIPT, MemoryStore, RedisStore, StoreCapacityError
from .verify import Verifier
from .wsgi import AifpGateWSGI

__version__ = "0.5.0"

__all__ = [
    "AI_AGENT_UA_MARKERS", "AI_AGENT_UA_TABLE", "AifpGateMiddleware", "AifpGateWSGI", "DETAIL_QUOTA_EXHAUSTED", "DETAIL_RECEIPT_EXPIRED",
    "DETAIL_VERIFY_FAILED", "GATE_OPERATORS", "Gate", "GateResult", "GateReporter", "GateReporterV2", "ReportingFlow", "HEADER_MODE", "HEADER_QUOTA_REMAINING", "HEADER_SHADOW_STATUS", "LLMS_TXT_PATH", "MemoryStore", "OPERATOR_ACTIONS", "OPERATOR_DEFAULT", "REDIS_INCRBY_SCRIPT",
    "RedisStore", "Route", "SimpleRequest", "StoreCapacityError", "TIER_WEIGHTS", "UA_CLASSES", "UNIT_PRICE_USD", "Verifier",
    "build_challenge", "build_discovery_document", "classify_agent", "decide_operator", "discovery_link_header", "is_html_content_type", "known_ai_agent", "min_requests_for_tier",
    "normalize_operator_policy", "pattern_covers", "scope_covers", "unit_price_usd", "weight_for_tier",
]
