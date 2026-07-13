"""
Merchant-side helper for the AiFinPay hosted gateway.

When your API runs behind ``gateway.aifinpay.io/{slug}/…``, the gateway
meters billing units and signs a per-action Billing Receipt for the calling
agent. Your API tells the gateway *what happened* by returning a single-line
JSON response header::

    AIFP-Billing: {"action":"deep_research","cost_units":10,"category":"premium"}

Only ``action`` is required. ``cost_units`` is informational — the gateway's
own action registry weight is the billing authority; the header value is a
hint/confirmation. Everything else is optional telemetry that ends up on the
signed receipt and the merchant dashboard.

FastAPI::

    from aifinpay import billing_header, AIFP_BILLING_HEADER

    @app.post("/deep-research")
    def deep_research(q: Query, response: Response):
        result = run_deep_research(q)
        response.headers[AIFP_BILLING_HEADER] = billing_header(
            "deep_research", cost_units=10
        )
        return result

Flask::

    @app.post("/search")
    def search():
        resp = jsonify(run_search(request.json))
        resp.headers[AIFP_BILLING_HEADER] = billing_header("search", cost_units=1)
        return resp
"""

import json

#: Response header name the AiFinPay gateway reads billing metadata from.
AIFP_BILLING_HEADER = "AIFP-Billing"

_NUMERIC_FIELDS = ("cost_units", "execution_time_ms", "bytes", "tokens")
_STRING_FIELDS = ("category", "status")


def billing_header(
    action,
    cost_units=None,
    category=None,
    execution_time_ms=None,
    bytes=None,  # noqa: A002 — mirrors the wire field name
    tokens=None,
    status=None,
):
    """Build the compact single-line JSON value for the ``AIFP-Billing`` header.

    - ``action`` must be a non-empty string — raises ``TypeError`` otherwise.
    - Numeric fields are coerced to ``int``; negatives clamp to 0;
      non-coercible values raise ``TypeError``.
    - ``None`` fields are dropped.
    - Output is compact JSON with no whitespace; ``json.dumps`` escapes any
      newlines inside strings, so the value is always a single line.

    :returns: JSON string, e.g. ``{"action":"deep_research","cost_units":10}``
    """
    if not isinstance(action, str) or not action.strip():
        raise TypeError(
            "AIFP-Billing: 'action' is required and must be a non-empty string"
        )
    out = {"action": action.strip()}

    numeric = {
        "cost_units": cost_units,
        "execution_time_ms": execution_time_ms,
        "bytes": bytes,
        "tokens": tokens,
    }
    for key in _NUMERIC_FIELDS:
        raw = numeric[key]
        if raw is None:
            continue
        try:
            n = int(raw)
        except (TypeError, ValueError):
            raise TypeError(f"AIFP-Billing: '{key}' must be coercible to int")
        out[key] = max(0, n)

    strings = {"category": category, "status": status}
    for key in _STRING_FIELDS:
        raw = strings[key]
        if raw is None:
            continue
        s = str(raw).strip()
        if s:
            out[key] = s

    return json.dumps(out, separators=(",", ":"))
