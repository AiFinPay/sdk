"""
CrewAI × AiFinPay
-----------------
Two-agent crew that pays for what it reads. The Researcher reads AIFP-1
paywalled resources with a `payable_fetch` tool built on
`AiFinPayAgent.fetch_paid` (one prepaid batch on Polygon v1.4 per 402, within
the owner's limits); the Editor turns the findings into a brief.

    python crew.py https://merchant.example/api/report
"""

import os
import sys

from crewai import Agent, Crew, Task
from crewai.tools import BaseTool

from aifinpay import AiFinPayAgent
from aifinpay.aifp1 import Aifp1Error


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Set {name}. Payment limits are the owner's choice; there are no defaults.")
    return value


# The owner's wallet (64 hex characters; never print or log it) and limits.
pay = AiFinPayAgent.from_seed(required("SEED_HASH"))
ALLOWED_ORIGINS = [o.strip() for o in required("AIFINPAY_GATEWAY_ORIGINS").split(",") if o.strip()]
MAX_USD = float(required("AIFINPAY_MAX_USD"))  # per batch
DAILY_USD = float(required("AIFINPAY_DAILY_USD"))  # rolling 24 h, persisted
ASSET = os.environ.get("AIFINPAY_PAY_ASSET") or None  # "USDC", or native POL when unset


class PayableFetchTool(BaseTool):
    name: str = "payable_fetch"
    description: str = (
        "GET a URL. If it is an AiFinPay (AIFP-1) paywalled resource on an origin the owner approved, "
        "buy one prepaid batch within the owner's limits and return the response body. Input: an https URL."
    )

    def _run(self, url: str) -> str:
        try:
            r = pay.fetch_paid(
                url,
                allowed_origins=ALLOWED_ORIGINS,
                max_amount_usd=MAX_USD,
                daily_amount_usd=DAILY_USD,
                asset=ASSET,
            )
        except Aifp1Error as e:
            # A refused quote paid nothing. A failed settlement may have been
            # broadcast: its recovery journal is for the owner (recover_paid),
            # never for the crew to retry.
            return f"payment not completed: {e}. Do not retry this URL."
        return f"HTTP {r.status_code}\n{r.text[:4000]}"


researcher = Agent(
    role="Researcher",
    goal="Extract the strongest facts from the paid sources you are given.",
    backstory="A senior research analyst who reads primary sources and cites them.",
    tools=[PayableFetchTool()],
    verbose=True,
)

editor = Agent(
    role="Editor",
    goal="Turn raw research into a tight, accurate brief.",
    backstory="Loves short, source-cited writing.",
    verbose=True,
)


def crew_for(url: str) -> Crew:
    t1 = Task(
        description=f"Read {url} with payable_fetch and list its key facts. Do not invent sources.",
        agent=researcher,
        expected_output="3-5 bullet points, each tied to the source URL.",
    )
    t2 = Task(
        description="Edit the researcher's findings into a 5-sentence executive brief.",
        agent=editor,
        expected_output="One paragraph, 5 sentences, at most 120 words.",
    )
    return Crew(agents=[researcher, editor], tasks=[t1, t2], verbose=True)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python crew.py <AIFP-1 paywalled https URL on an allowed origin>")
    print(f"[wallet] paying from {pay.evm_address} on Polygon")
    result = crew_for(sys.argv[1]).kickoff()
    print("\n=== BRIEF ===\n", result)
