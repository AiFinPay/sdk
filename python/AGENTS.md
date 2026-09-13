# aifinpay-agent (Python) — agent guide

Unified chain-opaque agent SDK: `AiFinPayAgent` call/balance/verify over Polygon + Solana. Non-custodial, x402-native.

## Scope
- This package only (`aifinpay/`, `tests/`, `pyproject.toml`). Do not touch `node/`, `gate/`, `mcp/`, `mcp-http/`, `wallet/`.
- Entry: `aifinpay/__init__.py`. Core: `aifinpay/unified_agent.py`, `aifinpay/client.py`, `aifinpay/cross_chain.py`, `aifinpay/facilitators/`.

## Commands
- Install: `pip install -e .` (from `python/`); legacy light install: `pip install -e .[legacy]` (Solana-only `Agent`, skips `AiFinPayAgent`)
- Tests: `pytest` / `python -m pytest tests/` (from `python/`)
- Python >= 3.9

## Rules
- Keep the `legacy` extra working: `aifinpay/__init__.py` must import without `web3`/`eth-account`/`solders` installed.
- No live network in tests; mock HTTP/RPC at `client.py` / facilitator boundaries.
- Never log or persist seeds/secret keys; non-custodial stays non-custodial.
- Version bumps touch `pyproject.toml` + `README.md` together.
