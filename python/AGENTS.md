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

## FULL-PAYMENT-FLOW-20261004 source state

The user authorized coordinated Node/Python/MCP work on the existing v1.4 kernel.
Nine EVM client descriptors do not establish production readiness or activate
networks. Generated deployment pins, flags, profiles and economics are unchanged.
Stable token units are independent chain/address-pinned6/18 decimals and additive
quote metadata is validated. Preserve explicit owner chain, budgets, runtime,
payer proof, receipt/SSRF and durable recovery controls. MCP2.6.0 requires
agent2.4.0 source-pack integration, then published dependency/lock refresh before
standalone release. No publish/merge/contract operations are authorized by this note.

## SOLANA-INTEGRATION-20261005 source state

Python 2.5.0 is a new source candidate; published 2.4.0 remains a separate release.
Solana payment requires explicit `chain`, `environment`, `solana_network` and a
positive integer `max_fee_lamports` covering fees and rent. Canonical availability
stays disabled. Preserve local keys, exact IDL/quote/accounts, fresh mint/profile
evidence, durable shared cap and original signature recovery. Unknown broadcasts
retain their reservation indefinitely. Canonical finalized failure reconciles
fees once at the bound admission rate/time and cannot overwrite a paid debit.
Public history/quota binds cluster/program, preserves base58 case and redacts JWTs.
