# Changelog

## 2.4.0 — source candidate, unreleased

- Reuse the signed EVM v1.4 kernel for nine explicitly owner-selected mainnets;
  preserve Polygon defaults, merchant authorization, deployment/runtime/signer,
  TokenList, payer proof, receipts, budgets, SSRF and durable recovery controls.
- Bind USD micro-units to exact pinned6/18-decimal stablecoin units using additive
  token_settlement; validate every split leg and approval.18dp requires metadata,
  old6dp quotes remain accepted. Split token gross independently of USD rounding.
- Budget OP data/operator fees for Base/Optimism/Unichain; count Nitro parent-data
  estimates once on Arbitrum/Robinhood. Native symbols are POL/ETH/AVAX/BNB/XRP.
- Add Python canonical RPC overrides/native gas caps and normalize valid token
  destinations to checksum form before eth-account signing.
- MCP reuses SDK metadata, permits pinned USDe and retains owner-only configuration.
  Independent price freshness refuses implausible future timestamps.
- Harden public FileSpendLedger: malformed/unreadable state refuses payment,
  unknown reservations never expire and locks are never stolen by age. Private
  atomic fsynced writes preserve legacy entries. Additive bound preparation,
  recovery and completion hooks keep unresolved access blocked across rails and
  commit recovered spend once. Retain completed reconciliation identities after
  the daily window without counting old debits. Old custom capped v1.4 adapters
  require the hooks; reconcile pending state before an SDK downgrade.
- Accept the real backend's verified USDC.E/USDE receipts with exact signed
  response and purchase bindings. Add read-only signed-byte recovery validation
  that permits historical quote expiry and checks original chain/payer/target/call.
- No deployment pins, flags, ABI, economics, route profiles or production activation
  change. Network deployment/receipt/indexing and paid acceptance remain required.
- Release order: Node2.4.0 publication, MCP published dependency/lock refresh and
  standalone CI, then MCP2.6.0. Existing registry lock is preserved; source-packed
  integration verifies the candidate. Python2.4.0 publishes independently after review.


## 2.3.2

- README only: native auth is documented as the v2 request-bound signature;
  chain and release wording match the source. No code change.

## 2.3.1

- `fetchRegistry`, `register`, `unregister`, `search` and the network nonce use
  the configured `fetchImpl` instead of global `fetch`.
- Export the `AuthRequestContext` type and `SettlementHttpError`.
- See `docs/sdk-parity.md` for the Node/Python comparison.

## 2.3.0

- Add explicitly selected Base ETH/USDC AIFP-1 payments with `v14.chain: "base"`.
  Polygon remains the default; quotes cannot select a network or replace pinned
  tokens, deployment/runtime, signer, EIP-712 domain, or profile checks.
- Bind receipt verification and recovery journals to the authorized chain. Old
  journals without a chain remain Polygon-only. Verified merchant access remains
  reusable across payment-chain preferences without another payment.
- Include buffered Base L1 data and operator fees in approval/settlement fee and
  balance preflight. Missing oracle estimates block signing. This is an estimated
  fee budget; EIP-1559 cannot cap inclusion-time L1/operator fees.

See the repository [CHANGELOG](../CHANGELOG.md) for previous releases.
