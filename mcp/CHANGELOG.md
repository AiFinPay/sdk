# Changelog

## 2.8.0 — unreleased

- Support deterministic child wallet selection with `AIFINPAY_WALLET_INDEX`
  for seed-based identities and indexed wallet keystores. Preserve existing
  behavior when no index is configured; pass the recovery seed and index to
  the SDK for per-domain key derivation.

## 2.7.2 — programmatic external EVM wallet

- Allow an embedding host to inject a viem EVM `WalletClient` into
  `createServer`; preserve local identity for Solana and read-only identity
  surfaces. Bind the journal and payment identity to the external account and
  owner-selected EVM chain; refuse mismatched clients.
- Keep stdio CLI and environment-based local wallet loading unchanged.

## 2.7.1 — release candidate

- Align the README's prepared MCP version and Node SDK requirement with the
  package manifest. Publication and standalone release validation remain required.

## 2.8.0 — reporting cohort source candidate

- Prepare the exact Node2.6.0 / Python2.5.1 / canonical skill2.9.0 cohort.
  The SDK's optional reporting context does not grant payment authority; MCP
  tool inventory, owner consent, budgets and disabled networks are unchanged.
- Use the already patched immutable MCP bootstrap lock and the producer's
  authoritative Node lock for genuine disposable source-pack integration.
  High/critical audits, exact installed/bundled bytes and tests remain required.
- Keep the real agent2.5.0 / skill2.8.0 registry entries until reviewed inputs
  are actually published. The release-input guard requires2.6.0 /2.9.0 and
  refuses this retained lock. Canonical immutable source pins, paired smoke,
  independent review and standalone registry CI are still release gates.

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
