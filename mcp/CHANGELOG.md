# Changelog

## 2.11.0 — a fresh agent reaches its first payment in five steps

A realistic test on 2026-10-19 (a fresh agent with MCP 2.10.0, told it could
pay $0.10 for one resource) ended after ten minutes with no payment. The tool
journal showed four causes; each is addressed here.

- `settlement_routes` now answers with splitter v1.4 first: one AIFP-1 entry per
  chain, with `chain_id`, `assets`, `quote_endpoint`, `pay_endpoint` and
  `live` (payable now through `payable_fetch`), served chains read from the
  issuer's `/api/health` and `/.well-known/x402.json` and pinned against the
  SDK's deployment registry. The splitter v1.3 answer from
  `GET /v1/settlement/routes` follows unchanged under `legacy_v13`. Before, the
  tool showed only v1.3, every route disabled, and agents concluded Polygon
  was off.
- New read-only `payment_setup_status`: wallet (persistent or ephemeral, source,
  EVM address), `payments_enabled`, each owner limit with `set`, the native
  balance on the pay chain when the RPC answers, and `next_step` — exactly one
  instruction for the first unmet item (the init command, the env block to add,
  the address and amount to fund, or the `payable_fetch` call).
- `payable_fetch` is always in `tools/list`. Until the owner's setup is
  complete (persistent wallet, `AIFINPAY_PAYMENTS_ENABLED=1`, every limit) it
  signs nothing and returns that same checklist as a tool error. The signing
  conditions are unchanged.
- `npx @aifinpay/mcp init` without a terminal on stdin, or with
  `AIFINPAY_NONINTERACTIVE=1`, never prompts: it generates a 192-bit
  passphrase, writes the encrypted keystore (mode 600) and prints one JSON
  document with the keystore path, the public addresses, the exact `env` block
  for the MCP client config and `next_step`. The passphrase appears only inside
  that `env` block. Existing keystores are kept; an encrypted keystore with
  `AIFINPAY_WALLET_PASSPHRASE` unset is reported in one line naming the
  variable. On a terminal the behaviour is unchanged.
- README: "First payment in five steps".

## 2.10.0 — name the AI client that pays

- `payable_fetch` maps the MCP client's `clientInfo.name` from initialize to
  `AIFP-Agent-Framework` and passes it to the SDK's purchase and pending-payment
  recovery, so the merchant dashboard shows which AI client paid. Exact names:
  `claude-ai` and `claude-code` → `claude`, `cursor` and `cursor-vscode` →
  `cursor`, `windsurf` → `windsurf`, `chatgpt` and `openai` → `chatgpt`,
  `gemini` → `gemini`, `perplexity` → `perplexity`. Any other client sends no
  header.
- Requires `@aifinpay/agent` 2.8.0 (the `framework` option). The release-input
  guard now requires its real registry installation, so 2.10.0 cannot be
  published before agent 2.8.0 is published and the lock refreshed.

## 2.9.0 — gateway merchant pins

- Require the published `@aifinpay/agent` 2.7.0, which pins each gateway site
  (origin + slug) to the merchant it was first paid as and treats
  `410 gateway_retired` as terminal.
- `payable_fetch` accepts an optional `expected_merchant_id`, passed to the SDK
  as `expectedMerchantId`. It does not expose the SDK's `allowMerchantChange`:
  the 402 that names a merchant is unauthenticated, so a blanket "allow change"
  argument would be too easy for a model to set.
- A site that answers as another merchant (`AIFP1_MERCHANT_CHANGED`) returns a
  tool error naming the site and both merchant ids. The error says nothing was
  paid and that only the owner can confirm the new merchant. Merchant ids that are
  not plain identifiers are never repeated to the model.
- A retired gateway site (`AIFP1_GATEWAY_RETIRED`) returns a terminal tool error
  that says not to retry.
- Tests isolate `AIFINPAY_STATE_DIR`, where the agent keeps its merchant pins.

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
