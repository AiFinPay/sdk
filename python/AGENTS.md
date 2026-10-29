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

## Runtime and release evidence

Client chain descriptors and source tests are not production approval. Payment
availability is determined by the installed deployment registry, runtime
verification and backend/merchant capabilities. Preserve explicit `chain`,
`environment`, `solana_network` and positive fee-plus-rent limits; local keys,
exact quote/account evidence, durable reservations and original-signature
recovery remain required. Unknown broadcasts retain their reservation, and
finalized-failure reconciliation must not overwrite a paid debit. Public
history/quota binds the selected cluster/program, preserves address case and
redacts bearer tokens. Never bypass an unavailable registry/runtime check or
infer activation from a source build; use manifests/locks, registry inputs,
capability APIs, executor tests and CI for current evidence.
