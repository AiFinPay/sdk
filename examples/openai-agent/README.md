# AiFinPay × OpenAI tool calling

Give a GPT model one tool, `payable_fetch(url)`, built on
`AiFinPayAgent.fetch_paid`. On an AIFP-1 `402` it buys one prepaid batch on
Polygon v1.4 from the owner's wallet, then returns the response body. Later
requests the batch covers cost no transaction.

The model chooses only the URL. The wallet and the limits come from the
environment, and `fetch_paid` refuses before signing anything outside them.

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
export AIFINPAY_DAILY_USD=5                                # rolling 24 hours
export AIFINPAY_PAY_ASSET=USDC                             # optional; native POL when unset

python agent.py https://merchant.example/api/data
```

The wallet's EVM address needs POL for gas, plus USDC when
`AIFINPAY_PAY_ASSET=USDC`. The script prints the address it pays from.

If a settlement's outcome is unknown, `payable_fetch` tells the model not to
retry. The owner then recovers with `agent.recover_paid(...)` using the journal
under `~/.aifinpay/journal` (see the
[Python SDK README](../../python/README.md)).

## Files

- `agent.py` — the `payable_fetch` tool and a chat-completions tool-calling
  loop that uses it.
