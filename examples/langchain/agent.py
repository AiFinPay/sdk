"""
LangChain × AiFinPay
--------------------
Expose `AiFinPayAgent.fetch_paid` as a LangChain BaseTool: a GET that buys one
AIFP-1 batch on Polygon v1.4 when the URL answers 402. The model chooses only
the URL; the owner's wallet and spending limits come from the environment.

    python agent.py https://merchant.example/api/data
"""

import os
import sys

from langchain.agents import create_agent
from langchain.tools import BaseTool
from langchain_openai import ChatOpenAI
from pydantic import BaseModel, Field

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


class PayableFetchInput(BaseModel):
    url: str = Field(description="An https URL on an origin the owner approved")


class PayableFetchTool(BaseTool):
    name: str = "payable_fetch"
    description: str = (
        "GET a URL. If it is an AiFinPay (AIFP-1) paywalled resource on an origin the owner approved, "
        "buy one prepaid batch within the owner's limits and return the response body."
    )
    args_schema: type = PayableFetchInput

    def _run(self, url: str) -> str:
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


# LangChain 1.x agent API (create_agent); AgentExecutor moved to langchain-classic.
reader = create_agent(
    ChatOpenAI(model="gpt-4o-mini", temperature=0),
    tools=[PayableFetchTool()],
    system_prompt="You can read AiFinPay-paywalled resources with payable_fetch; the owner's limits apply.",
)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python agent.py <AIFP-1 paywalled https URL on an allowed origin>")
    print(f"[wallet] paying from {agent.evm_address} on Polygon")
    task = f"Read {sys.argv[1]} with payable_fetch, then summarize it in three sentences."
    out = reader.invoke({"messages": [{"role": "user", "content": task}]})
    print("\n=== OUTPUT ===\n", out["messages"][-1].content)
