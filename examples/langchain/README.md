# AiFinPay × LangChain

Expose `AiFinPayAgent.fetch_paid` as a LangChain `BaseTool`. Any LangChain
agent that calls tools can then read AIFP-1 paywalled resources: on a `402`
the tool buys one prepaid batch on Polygon v1.4 from the owner's wallet,
within the owner's limits, and returns the response body.

The model chooses only the URL. The wallet and the limits come from the
environment, and `fetch_paid` refuses before signing anything outside them.

## Setup

```bash
pip install aifinpay-agent "langchain>=1.0" langchain-openai
export OPENAI_API_KEY=sk-...

# The owner's wallet: a 32-byte seed as 64 hex characters, for example from
# `npx @aifinpay/wallet export`. Keep it out of chats, logs and version control.
export SEED_HASH=...

# The owner's limits. All are required; there are no defaults.
export AIFINPAY_GATEWAY_ORIGINS=https://merchant.example   # comma-separated exact origins it may pay
export AIFINPAY_MAX_USD=0.50                               # per batch
export AIFINPAY_DAILY_USD=5                                # rolling 24 hours
export AIFINPAY_PAY_ASSET=USDC                             # optional; native POL when unset

python agent.py https://merchant.example/api/data
```

The wallet's EVM address needs POL for gas, plus USDC when
`AIFINPAY_PAY_ASSET=USDC`. If a settlement's outcome is unknown, the tool tells
the model not to retry; the owner recovers with `agent.recover_paid(...)` (see
the [Python SDK README](../../python/README.md)).

## Files

- `agent.py` — `PayableFetchTool` and a LangChain 1.x agent (`create_agent`) that
  uses it.
