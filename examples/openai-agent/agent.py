"""
OpenAI tool calling × AiFinPay
------------------------------
Gives a GPT model one tool, `payable_fetch(url)`, built on
`AiFinPayAgent.fetch_paid`: a GET that buys one AIFP-1 batch on Polygon v1.4
when the URL answers 402. The model chooses only the URL; the owner's wallet
and spending limits come from the environment and cannot be raised by it.

    python agent.py https://merchant.example/api/data
"""

import json
import os
import sys

from openai import OpenAI

from aifinpay import AiFinPayAgent
from aifinpay.aifp1 import Aifp1Error


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Set {name}. Payment limits are the owner's choice; there are no defaults.")
    return value


# The owner's wallet (64 hex characters; never print or log it) and limits.
agent = AiFinPayAgent.from_seed(required("SEED_HASH"))
ALLOWED_ORIGINS = [o.strip() for o in required("AIFINPAY_GATEWAY_ORIGINS").split(",") if o.strip()]
MAX_USD = float(required("AIFINPAY_MAX_USD"))  # per batch
DAILY_USD = float(required("AIFINPAY_DAILY_USD"))  # rolling 24 h, persisted
ASSET = os.environ.get("AIFINPAY_PAY_ASSET") or None  # "USDC", or native POL when unset

openai = OpenAI()


def payable_fetch(url: str) -> str:
    """GET a URL; if it answers an AIFP-1 402, buy one batch within the owner's limits and retry."""
    try:
        r = agent.fetch_paid(
            url,
            allowed_origins=ALLOWED_ORIGINS,
            max_amount_usd=MAX_USD,
            daily_amount_usd=DAILY_USD,
            asset=ASSET,
        )
    except Aifp1Error as e:
        # A refused quote paid nothing. A failed settlement may have been
        # broadcast: its recovery journal is for the owner (recover_paid),
        # never for the model to retry.
        return f"payment not completed: {e}. Do not retry this URL."
    return f"HTTP {r.status_code}\n{r.text[:4000]}"


tools = [{
    "type": "function",
    "function": {
        "name": "payable_fetch",
        "description": (
            "GET a URL. If it is an AiFinPay (AIFP-1) paywalled resource on an origin the owner approved, "
            "buy one prepaid batch within the owner's limits and return the response body."
        ),
        "parameters": {
            "type": "object",
            "properties": {"url": {"type": "string", "description": "An https URL"}},
            "required": ["url"],
        },
    },
}]


def run(user_msg: str) -> str:
    messages = [{"role": "user", "content": user_msg}]
    while True:
        r = openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=messages,
            tools=tools,
            tool_choice="auto",
        )
        msg = r.choices[0].message
        messages.append(msg)
        if not msg.tool_calls:
            return msg.content
        for tc in msg.tool_calls:
            args = json.loads(tc.function.arguments)
            messages.append({
                "tool_call_id": tc.id,
                "role": "tool",
                "name": tc.function.name,
                "content": payable_fetch(args["url"]),
            })


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python agent.py <AIFP-1 paywalled https URL on an allowed origin>")
    print(f"[wallet] paying from {agent.evm_address} on Polygon")
    answer = run(f"Use payable_fetch to read {sys.argv[1]}, then summarize what it returned in three sentences.")
    print("\n=== ANSWER ===")
    print(answer)
