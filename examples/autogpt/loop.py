"""
Headless autonomous loop on a fixed budget.

Each tick reads an AIFP-1 paywalled URL with `AiFinPayAgent.fetch_paid` and has
a model summarize it. The first 402 buys one prepaid batch on Polygon v1.4;
later ticks spend that batch with no transaction until it runs out. The budget
is the owner's rolling 24-hour limit: the loop stops when `fetch_paid` refuses
a purchase that would exceed it.

    python loop.py https://merchant.example/api/feed
"""

import os
import sys
import time

from openai import OpenAI

from aifinpay import AiFinPayAgent
from aifinpay.aifp1 import Aifp1PayError, Aifp1QuoteError

TICK_SECONDS = 30


def required(name: str) -> str:
    value = os.environ.get(name, "").strip()
    if not value:
        raise SystemExit(f"Set {name}. Payment limits are the owner's choice; there are no defaults.")
    return value


def main(url: str) -> None:
    # The owner's wallet (64 hex characters; never print or log it) and limits.
    agent = AiFinPayAgent.from_seed(required("SEED_HASH"))
    limits = dict(
        allowed_origins=[o.strip() for o in required("AIFINPAY_GATEWAY_ORIGINS").split(",") if o.strip()],
        max_amount_usd=float(required("AIFINPAY_MAX_USD")),  # per batch
        daily_amount_usd=float(required("AIFINPAY_DAILY_USD")),  # rolling 24 h, persisted
        asset=os.environ.get("AIFINPAY_PAY_ASSET") or None,  # "USDC", or native POL when unset
    )
    openai = OpenAI()
    print(f"[boot] paying from {agent.evm_address} on Polygon")

    tick = 0
    while True:
        tick += 1
        try:
            r = agent.fetch_paid(url, **limits)
        except Aifp1QuoteError as e:
            # Refused before anything was signed: the daily limit, the
            # per-batch limit, an origin the owner did not approve, a quote
            # that did not check out. Nothing was paid.
            print(f"[halt] {e}")
            return
        except Aifp1PayError as e:
            # A settlement whose outcome is unknown. Paying again could pay
            # twice; recover it from the journal instead.
            journal = e.recovery.get("journal_path")
            print(f"[halt] {e} (tx {e.tx_ref}). Do not pay again: agent.recover_paid({journal!r}).")
            return
        if r.status_code != 200:
            print(f"[halt] {url} answered HTTP {r.status_code}")
            return
        summary = openai.chat.completions.create(
            model="gpt-4o-mini",
            messages=[{"role": "user", "content": f"Summarize in 3 bullets:\n{r.text[:4000]}"}],
        ).choices[0].message.content
        print(f"[tick {tick}] {summary}\n")
        time.sleep(TICK_SECONDS)


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("usage: python loop.py <AIFP-1 paywalled https URL on an allowed origin>")
    main(sys.argv[1])
