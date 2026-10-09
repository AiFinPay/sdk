# AiFinPay × headless autonomous loop (AutoGPT-style)

A minimal long-running agent that reads a paid resource on a schedule and
summarizes it, on a budget the owner sets once.

Each tick calls `AiFinPayAgent.fetch_paid`. The first AIFP-1 `402` buys one
prepaid batch on Polygon v1.4; later ticks spend that batch with no
transaction until it runs out, then the next batch is bought. The loop stops
when `fetch_paid` refuses a purchase: the rolling 24-hour limit would be
exceeded, the batch costs more than the per-batch limit, or the quote does not
check out. Nothing is signed in those cases.

This isn't tied to the AutoGPT framework specifically. It is the pattern for
any headless agent that must operate unattended on a fixed budget.

## Setup

```bash
pip install aifinpay-agent openai
export OPENAI_API_KEY=sk-...

# The owner's wallet: a 32-byte seed as 64 hex characters, for example from
# `npx @aifinpay/wallet export`. Keep it out of chats, logs and version control.
export SEED_HASH=...

# The owner's limits. All are required; there are no defaults.
export AIFINPAY_GATEWAY_ORIGINS=https://merchant.example   # comma-separated exact origins it may pay
export AIFINPAY_MAX_USD=0.50                               # per batch
export AIFINPAY_DAILY_USD=2                                # rolling 24 hours: the loop's budget
export AIFINPAY_PAY_ASSET=USDC                             # optional; native POL when unset

python loop.py https://merchant.example/api/feed
```

The wallet's EVM address needs POL for gas, plus USDC when
`AIFINPAY_PAY_ASSET=USDC`. If a settlement's outcome is unknown the loop stops
and prints the transaction hash and journal path. Recover with
`agent.recover_paid(journal_path)` rather than paying again (see the
[Python SDK README](../../python/README.md)).

## Files

- `loop.py` — loads the owner's wallet and limits, runs the paid read and
  summary loop, and stops when the budget refuses a purchase.
