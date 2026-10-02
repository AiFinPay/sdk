# AiFinPay × CrewAI

A two-agent crew that pays for what it reads. The Researcher reads AIFP-1
paywalled resources with a `payable_fetch` tool built on
`AiFinPayAgent.fetch_paid`: on a `402` it buys one prepaid batch on Polygon
v1.4 from the owner's wallet, within the owner's limits. The Editor turns the
findings into a brief.

The crew chooses only the URL. The wallet and the limits come from the
environment, and `fetch_paid` refuses before signing anything outside them.

## Setup

CrewAI needs Python 3.10 or later.

```bash
pip install aifinpay-agent crewai
export OPENAI_API_KEY=sk-...

# The owner's wallet: a 32-byte seed as 64 hex characters, for example from
# `npx @aifinpay/wallet export`. Keep it out of chats, logs and version control.
export SEED_HASH=...

# The owner's limits. All are required; there are no defaults.
export AIFINPAY_GATEWAY_ORIGINS=https://merchant.example   # comma-separated exact origins it may pay
export AIFINPAY_MAX_USD=0.50                               # per batch
export AIFINPAY_DAILY_USD=5                                # rolling 24 hours
export AIFINPAY_PAY_ASSET=USDC                             # optional; native POL when unset

python crew.py https://merchant.example/api/report
```

The wallet's EVM address needs POL for gas, plus USDC when
`AIFINPAY_PAY_ASSET=USDC`. If a settlement's outcome is unknown, the tool tells
the crew not to retry; the owner recovers with `pay.recover_paid(...)` (see the
[Python SDK README](../../python/README.md)).

## Files

- `crew.py` — two agents, one `payable_fetch` tool, one task graph.
