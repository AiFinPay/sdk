# AiFinPay agent snippet: wallet → budget → provider call (Python).
#
# Run:  pip install aifinpay-agent
#       SEED_HASH=<64 hex chars> python examples/agent-snippets/wallet-budget-call.py
#
# Never log or print seeds, secrets, or keystore JSON — public addresses only.
# NOTE: Python call() passes free responses through but fails closed on paid
# 402s — for paid AIFP-1 settlement use the Node fetchPaid snippets alongside.
import os

from aifinpay import AiFinPayAgent

# 1. Wallet — read the seed from the environment, never hardcode or print it.
agent = AiFinPayAgent.from_seed(os.environ["SEED_HASH"])
print("fund:", agent.evm_address)

# 2 + 3. Call with a per-call cap in USD (raises PaymentTooExpensiveError above it).
resp = agent.call(
    "io-net",
    {
        "model": "meta-llama/Llama-3.3-70B-Instruct",
        "messages": [{"role": "user", "content": "Hello"}],
    },
    cost=0.10,
)
print(resp.json())
