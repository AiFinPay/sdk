"""
OpenAI Agents SDK x Nano (XNO) x402
-----------------------------------
Drop-in Nano settlement rail for the OpenAI Agents SDK.
Gives an agent a `nano_x402_fetch` Tool that pays x402-gated endpoints
with Nano (XNO) — instant, feeless, peer-to-peer.

Same x402 protocol, different settlement rail.
"""

from agents import Agent, Runner

from openai_agents_nano import make_nano_x402_tool

# Build the Nano x402 payer Tool. It uses the wallet at the default path
# (fund it with XNO) and refuses to pay more than the default cap.
nano_x402_fetch = make_nano_x402_tool()

agent = Agent(
    name="Nano x402 agent",
    instructions=(
        "You can fetch pay-per-call resources that are gated behind an "
        "x402 payment and settle them instantly in Nano (XNO) using the "
        "nano_x402_fetch tool. First call it with dry_run=true to preview "
        "the price and cap; only if it is acceptable pay with the returned "
        "quote_token."
    ),
    tools=[nano_x402_fetch],
)

# Example: ask the agent to fetch a Nano-priced x402 endpoint.
# result = await Runner.run(
#     agent, "Fetch https://example.com/paid-data and summarize it."
# )
