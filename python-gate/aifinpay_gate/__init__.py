"""AiFinPay gate for Python merchants — accept AIFP-1 payments from AI agents.

A port of ``@aifinpay/gate``: the same 402 challenge, the same local EdDSA
receipt verification against the AiFinPay JWKS, the same post-increment quota
metering. See README.md.
"""

from .agents import AI_AGENT_UA_MARKERS, known_ai_agent
from .asgi import AifpGateMiddleware
from .challenge import build_challenge
from .core import (
    DETAIL_QUOTA_EXHAUSTED,
    DETAIL_RECEIPT_EXPIRED,
    DETAIL_VERIFY_FAILED,
    HEADER_QUOTA_REMAINING,
    Gate,
    GateResult,
    Route,
    SimpleRequest,
)
from .discovery import build_discovery_document
from .pricing import TIER_WEIGHTS, UNIT_PRICE_USD, min_requests_for_tier, unit_price_usd, weight_for_tier
from .scope import pattern_covers, scope_covers
from .stores import REDIS_INCRBY_SCRIPT, MemoryStore, RedisStore, StoreCapacityError
from .verify import Verifier
from .wsgi import AifpGateWSGI

__version__ = "0.1.0"

__all__ = [
    "AI_AGENT_UA_MARKERS", "AifpGateMiddleware", "AifpGateWSGI", "DETAIL_QUOTA_EXHAUSTED", "DETAIL_RECEIPT_EXPIRED",
    "DETAIL_VERIFY_FAILED", "Gate", "GateResult", "HEADER_QUOTA_REMAINING", "MemoryStore", "REDIS_INCRBY_SCRIPT",
    "RedisStore", "Route", "SimpleRequest", "StoreCapacityError", "TIER_WEIGHTS", "UNIT_PRICE_USD", "Verifier",
    "build_challenge", "build_discovery_document", "known_ai_agent", "min_requests_for_tier", "pattern_covers",
    "scope_covers", "unit_price_usd", "weight_for_tier",
]
