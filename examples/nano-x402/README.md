# Nano (XNO) x402 — feeless settlement rail for OpenAI Agents SDK

An alternative to USDC-on-Polygon: settle x402 payments instantly with
zero fees using Nano (XNO) through the `openai-agents-nano-x402` adapter.

| | AiFinPay (default) | Nano x402 (this example) |
|---|---|---|
| Settlement network | Polygon / Solana | Nano (Nano Protocol) |
| Fee per payment | ~$0.02 + gas | **$0.00** |
| Settlement time | ~2 s (block time) | **<1 s** |
| Issuer / freeze risk | USDC issuer can freeze | None (no issuer) |
| Setup | Fund with MATIC + USDC | Fund with XNO |

Both use the same x402 protocol. The Nano payer is a drop-in OpenAI Agents
SDK `Tool` — same shape as an AiFinPay payer, different settlement rail.

## Setup

```bash
pip install openai-agents-nano-x402
```

## Usage

```python
from openai_agents_nano import make_nano_x402_tool

# Returns an OpenAI Agents SDK FunctionTool named `nano_x402_fetch`.
# Wallet defaults to ~/.nano-pay/wallet.json (fund with XNO) and the
# payment cap defaults to the X402_MAX_XNO env var (else 0.01 XNO).
nano_tool = make_nano_x402_tool()
```

The tool is a two-phase payer: an agent first calls it with
`dry_run=true` to preview the price, `pay_to` and cap (nothing is spent),
then, if within the cap, calls again with `dry_run=false` and the matching
`quote_token` to settle. The return is agent-readable text with the
on-ledger receipt.

## How it works

1. The payer sends an HTTP request to an x402-gated endpoint.
2. The endpoint responds 402 Payment Required with a charge-details header.
3. The Nano payer signs a Nano block to the seller's address and retries
   with the settlement proof.
4. The seller's facilitator verifies the block and fulfills the request.

Same protocol, different money.
