# Changelog

## 2.6.0 — release candidate

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
- Persist prepared.chain and its bound budget context for exact-rail recovery.
  A legacy missing-chain journal requires actual owner-signed transaction proof
  of chain/payer/pinned target/exact call before any receipt claim. Insufficient
  proof refuses with journal retained. Historical quote expiry does not force a
  replacement transaction. Tests use actual signed bytes and real SDK receipt
  signature/proof verification for Base and Robinhood.
- No deployment pins, flags, ABI, economics, route profiles or production activation
  change. Network deployment/receipt/indexing and paid acceptance remain required.
- Prepare canonical skill2.7.0 integration with an explicit exact MCP/Node/Python
  release target; dated publication baselines do not imply the target is live.
  Validate installed/bundled/served content, skill/package versions and the exact
  target, including stale-guide and changed-target negative controls.
- Release order: reviewed skill2.7.0 and Node2.4.0 publication, real MCP registry
  dependency/lock refresh and standalone CI, then MCP2.6.0 publication.
  The existing registry lock is retained until those actual inputs exist. Source-cohort
  checks build against the exact same Node commit, not an invented npm release.
  Hosted MCP CI is pending the real skill lock; never publish from the old lock.


See the repository [CHANGELOG](../CHANGELOG.md).
