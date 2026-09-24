## MCP 2.3.0 / Node 2.2.0 — unreleased

- MCP `payable_fetch` can pay in USDC: the owner sets `AIFINPAY_PAY_ASSET=USDC`
  (unset or `POL` keeps native). The tool asks the SDK for a stablecoin
  purchase, budgets it from the quoted USD amount (no POL price needed), refuses
  a prepared payment in any other asset, and recovers a pending payment only in
  POL or the configured asset. Requires `@aifinpay/agent` 2.2.0.

## Node 2.2.0 — unreleased

- `fetchPaid` can pay a v1.4 quote in a stablecoin: `v14: { asset: "USDC", ... }`.
  The asset must be one the SDK's own Polygon v1.4 pin lists; the quote is asked
  for in that asset and must accept only it. A token quote needs no
  `nativeUsdPrice`: the signed gross must equal the quote's settlement units and
  its USD amount in 6-decimal micro-dollars, and the call's `approval` must be
  exactly that gross to the pinned splitter.
- `executeV14Settlement` settles `settleStable`: it checks the token is pinned,
  still allowed by the splitter's tokenList, 6-decimal and fully held; approves
  exactly the gross when the allowance is short (not journaled — an approval
  moves no funds and is safe to repeat); then journals and sends settleStable
  with value 0, and accepts only a Payment event in that token. `maxGasWei`
  covers the approval and the settlement together. New refusal codes:
  `V14_APPROVAL_MISMATCH`, `V14_TOKEN_NOT_ALLOWED`, `V14_TOKEN_DECIMALS`,
  `V14_APPROVAL_FAILED`, `V14_APPROVAL_PENDING`.
- Receipt verification checks the receipt's asset against the one paid.
- Requires a backend that signs v1.4 token quotes (`/v1/quote` with `asset`).

## MCP 2.2.4 / Node 2.1.4 / Python 2.1.1 — 2026-09-23

- MCP `payable_fetch`: the independent POL/USD rate no longer depends on one
  host. It reads Chainlink POL/USD on Polygon over the agent's own RPC, then
  api.coinbase.com, then api.coingecko.com (`polygon-ecosystem-token`), each
  with a freshness check. A sandbox that blocked Coinbase stopped every payment
  before it began; now the error, if every source fails, names each host tried.
- MCP: `agent_claim_self` is registered. The owner generates a one-time URL at
  dash.aifinpay.io → My Agents → Claim via MCP and the agent links itself; the
  tool still contacts only AiFinPay origins and signs only its own claim
  challenge. Its reply points at dash.aifinpay.io (was dashboard.aifinpay.io)
  and recommends funding POL, which is what `payable_fetch` settles in.
- MCP: `agent_address` no longer says payment signing is absent, and offers the
  dashboard link; `init` prints the payment settings and the dashboard step.
- Node `signDashboardClaim(challenge)` / Python `sign_dashboard_claim(challenge)`:
  sign the dashboard's "Add agent by address" challenge — only
  `AiFinPay-claim:polygon:<own address>:<nonce>`, nothing else.
- READMEs: released status instead of "source candidate"; network access for
  sandboxes; Python states plainly that it cannot pay AIFP-1 v1.4 yet and no
  longer describes the closed Solana Seat flow.

## MCP 2.2.3 — 2026-09-23

- `npx @aifinpay/mcp init` no longer creates an unencrypted wallet by default.
  Without `AIFINPAY_WALLET_PASSPHRASE` it exits 2 and explains the two options:
  set a passphrase (encrypted keystore), or pass `--plaintext` for a disposable
  test wallet. Existing keystores, encrypted or not, keep working unchanged.

## Node 2.1.3 / gate 0.3.4 — 2026-09-22

- `@aifinpay/agent`: `scopeCovers` understands registered wildcard resources
  (`/movies/*`), matching the server and `@aifinpay/gate`. Direct mode
  (`resourcePathMode: "direct"`) accepts a 402 whose resource is a pattern
  covering the URL; it still refuses one that does not. Before this, a direct
  merchant page such as `/movies/11/…` answered with `/movies/*` was refused
  before quoting.
- `@aifinpay/gate`: see gate/CHANGELOG.md.

## Unreleased — Node 2.1.0 / MCP 2.2.0

- Native v1.4 executor uses independent release pins, EIP-712 signer validation,
  current profile checks, purchase/gas limits, simulation and exact Payment evidence.
- Preserve the signed quote through `fetchPaid`; require durable preparation
  before broadcast and verify receipt signatures/purchase bindings.
- Owner-enabled generic MCP `payable_fetch` supports Polygon AIFP-1 GET resources,
  private durable recovery/cache, per-payment/daily limits and exact origin policy.
- Preserve the accepted administrative profile model; no contract redeployment,
  legacy activation or stable-token executor included.
- Correct pre-existing legacy registry TypeScript drift without inventing a
  legacy Robinhood deployment (Robinhood remains in the v1.4 registry).

# Changelog

All notable changes to the AiFinPay SDK packages are documented here.
Versioning follows [Semantic Versioning](https://semver.org/). From
`1.0.0` onward the public API is stable and changes follow semver.

## @aifinpay/gate 0.3.3 — 2026-09-19

- Link both discovery and HTTP 402 responses to the public payer skill,
  merchant skill and payment-flow documentation.
- Correct wallet onboarding text: creating a wallet does not enable a payment
  executor. No changes to receipt verification, quotas or settlement.

## 2.0.2 — 2026-09-17

### Added

- **`@aifinpay/mcp-http`** — HTTP/Streamable transport wrapper for
  `@aifinpay/mcp`. Exposes the AiFinPay MCP server at
  `https://mcp.aifinpay.io/mcp` for catalogs (Smithery, mcp.so, LobeHub)
  that require a public HTTP URL. Previously private; now published to npm.

## 2.0.0 — 2026-09-16

**Stable release** — Node `2.0.0`, MCP `2.0.0`, Python `2.0.0`. All RC
features and security fixes from the `2.0.0-rc.x` lane are now stable.

### Core changes

- **Persistent wallet identity** — `AiFinPayAgent.fromEnvironment()` (Node)
  and environment-based loading (Python/MCP) select exactly one wallet from
  configured inputs: `SEED_HASH` → `./aifinpay/agents.json` →
  `AIFINPAY_AGENT_SECRET` → `~/.aifinpay/agent.json`. Fails on missing or
  ambiguous configuration; never creates or overwrites a wallet.
- **Native authentication v2** — requires request-bound challenges from the
  coordinated backend. The retired unbound proof is refused.
- **Verified AIFP-1 settlement** — Node `fetchPaid` requires a reviewed
  Polygon v1.3 deployment pin, fresh independent native/USD price, and
  matching quote target/calldata before payment.
- **Deployment registry** — v1.4 deployments for all supported EVM networks
  (arbitrum, avalanche, base, bnb, optimism, polygon, robinhood, unichain,
  xrplevm, plus amoy testnet). `resolveDeployment(..., "auto")` prefers v1.4
  on base/optimism/unichain/xrplevm.
- **Quota and history APIs** — `getQuota()`, `getDailySpendUsd()`,
  `Aifp1ReceiptCache.summary()`, and `agent_history()` with `source`
  parameter (`"transactions"` or `"receipts"`).
- **Safe error handling** — `toSafeError()` boundary-safe serialization
  (name/message + allowlisted fields only; never secrets).
- **Deprecations** — `openSession()` / `reputation()` stubs marked
  `@deprecated`. BOT Chain (677) deprecated in favor of Robinhood Chain (4663).

### Security

- Pinned `jayson`'s transitive `uuid` dependency to `^11.1.1` in
  `@aifinpay/agent` and `@aifinpay/mcp` via `overrides`, resolving the
  moderate `uuid` advisory (GHSA-w5hq-g745-h8pq).
- Bound API HTTP redirects, timeouts and response sizes; pin receipt issuer.
  MCP blocks cross-origin credentials/body leakage and private IPv4-mapped
  IPv6 destinations.
- Quarantine v1.4 signing until quotes include mutable fee/treasury
  commitments. Legacy `call()` payments and unbound native v1 authentication
  are refused; free calls remain available.
- Pin CI Actions to commit SHAs and reject high/critical runtime dependency
  advisories.

### Migration

- Upgrade from 1.x: wallet identity loading is now load-only; use
  `AiFinPayAgent.new()` only when deliberately creating a new ephemeral
  wallet.
- Backend must support native auth v2 challenges.
- Polygon AIFP-1 requires v1.3 deployment pin and fresh price feed.

Read `node/PAYMENT_RECEIPTS.md` for receipt configuration and recovery.

## Unreleased — Node 2.0.0-rc.16 / MCP 2.0.0-rc.14 — 2026-09-13

Minimum Node engine is now 22 (`engines: >=22` in `@aifinpay/agent`,
`@aifinpay/mcp`, `@aifinpay/wallet`, `@aifinpay/gate`, `@aifinpay/skill`,
and the example bridges). Node 18/20 are no longer supported. CI now
builds and tests on 22, 24 and 26. No runtime or API changes.

### Deprecations

- **BOT Chain (chainId: 677) is deprecated in favor of Robinhood Chain (chainId: 4663).**
  All type definitions, exports, and configuration surfaces now carry `@deprecated`
  JSDoc annotations. Backward compatibility is maintained — existing code using
  `botchain` continues to work, but TypeScript will emit deprecation warnings.
  Migration: replace `botchain` with `robinhood` in chain selections, type
  parameters, and configuration. The `botchain` export and type entries will be
  removed in a future major version.

### Security

- Pinned `jayson`'s transitive `uuid` dependency to `^11.1.1` in
  `@aifinpay/agent` and `@aifinpay/mcp` via `overrides`, resolving the
  moderate `uuid` advisory (GHSA-w5hq-g745-h8pq). The remaining moderate
  `stream-json` advisory (GHSA-528h-pc64-c93x) is inherited from
  `@solana/web3.js` → `jayson`; `jayson@4.3.0` requires `stream-json@^1.9.1`
  and no patched 1.x release exists. It is tracked as accepted
  transitive risk and does not meet the high/critical audit threshold.

## Unreleased — Node 2.0.0-rc.15 — 2026-09-13

v1.4 deployments for all supported EVM networks (from `AiFinPay/evm-contract@78240ec`):

- `V14_DEPLOYMENTS` now covers 10 networks (was: amoy + polygon only) — amoy (dev) plus arbitrum, avalanche, base, bnb, optimism, polygon, robinhood, unichain, xrplevm (prod). BOT Chain (677) stays absent: no production deployment exists for it upstream.
- New `registry/v14/*.json` vendored deployment artifacts + `registry/v14-source.json` provenance, with `scripts/generate-v14-deployments.mjs` (`npm run registry:sync:v14 -- --from <evm-contract>`); `npm run registry:check` now verifies both the v1.3 route table and the v1.4 table.
- `resolveDeployment(..., "auto")` now prefers v1.4 on base/optimism/unichain/xrplevm (previously v1.2 fallback); botchain remains the only legacy network without v1.4.

## Unreleased — Node 2.0.0-rc.14 — 2026-09-13

Round 2 (medium/low, node-side):

- `getQuota()` / `agent.getQuota()` — typed prepaid-batch reads (filter,
  sort, per-merchant rollup) ported from the MCP `agent_quota` tool logic.
- `balance()` is feed-first (env → `/api/price/native` → unknown leg
  excluded, never fabricated); new additive `prices` / `unknown_legs`
  fields. Shared `tokenUsd()` helper backs `nativeUsdFor()`.
- `Aifp1ReceiptCache.summary()` + `agent.getReceiptCacheSummary()` —
  JWT-free cache inspection for dashboards/MCP.
- `@deprecated` on the `openSession()` / `reputation()` stubs.

## Unreleased — Node 2.0.0-rc.13 — 2026-09-13

Node↔MCP alignment (non-signing; no settlement semantics change):

- `AiFinPayAgent.settlementRoutes()` / `requestSettlementInvoice()` — validated
  route/invoice reads over the caller's fetch (MCP `safeFetch`), for the MCP
  `settlement_routes` / `settlement_invoice` tools to call instead of raw fetch.
- `toSafeError()` + `SafeErrorShape` — boundary-safe error serialization
  (name/message + allowlisted public fields only; never secrets).
- Exported `AGENT_RECEIPT_FIELDS` / `AGENT_TRANSACTION_FIELDS` history
  allowlists as single source of truth.
- `AiFinPayAgent.getDailySpendUsd()` — durable ledger read for long-lived
  hosts; removed dead `checkBudget()` superseded by `checkPerCall`+`reserveDaily`.

## Unreleased — Node/MCP 2.0.0-rc.12 · Python 2.0.0rc1 — 2026-09-12

Security RC; these versions have not been published by this change.

- Preserve existing wallet identity across SDK startup and concurrent MCP
  initialization. Fail on missing, invalid or ambiguous seed configuration;
  never overwrite an existing wallet or advertise an unsaved deposit address.
- Fix v1.3 native/stable tuple ABI. Bind invoice/order/payment ID, independently
  pin target bytecode, chain, economics and stable token, and wait for mined
  success. Retain broadcast hashes when confirmation is uncertain.
- Wire Polygon AIFP-1 `fetchPaid` to that executor. Require a reviewed
  deployment pin and fresh independent native/USD price. Match quote target
  and calldata before payment; preserve receipts across content-request errors.
- Synchronize canonical deployment registry and add explicit Amoy testnet
  opt-in. Mainnet activation is unchanged. Add matching backend routes via the
  coordinated dev PR; older backend quotes may be refused.
- Bound API HTTP redirects, timeouts and response sizes; pin receipt issuer.
  MCP honors redirect modes and blocks cross-origin credentials/body leakage
  and private IPv4-mapped IPv6 destinations. Standard x402 USD caps require a
  known chain/USDC pair and use integer atomic amounts.
- Quarantine v1.4 signing while quotes omit mutable fee/treasury commitments.
  Legacy Node/Python `call()` payments and unbound native v1 authentication
  are refused; free calls remain available. Native auth v2 requires the
  coordinated backend update. These are intentional breaking security changes.
- Pin CI Actions to commit SHAs and reject high/critical runtime dependency
  advisories. Update vulnerable MCP transitive dependencies. Moderate Solana
  dependency advisories remain tracked; no forced dependency downgrade.

Read `node/PAYMENT_RECEIPTS.md` for recovery and required configuration.
No mainnet transaction, production activation or package publication is part
of this release candidate. Passing component tests is not paid end-to-end proof.

## aifinpay-agent 1.5.0 · @aifinpay/mcp 2.0.0-rc.3 — 2026-08-27

**aifinpay-agent 1.5.0 changes where money goes. Read this before upgrading.**

The royalty slot now defaults to `address(0)` instead of the splitter's own
treasury. `B2BSplitter._split` folds that share into the merchant's when the
recipient is zero and attempts no transfer, so the merchant keeps it — which is
what `/v1/quote` has always published.

The previous fallback was justified in the code as "address(0) would strand the
1bp inside the contract", which the contract does not do. The effect was that
0.01% of every payment with no explicit `ip_creator` went to us instead of the
merchant, silently. Observed on Polygon in tx `0x6b853876…`: merchant 98.99%,
treasury 1.01% across one address, against a quoted 99/1/0.

Minor rather than patch: an agent that upgrades builds a different transaction.

**@aifinpay/mcp 2.0.0-rc.3** adds two operator allowlists, both off by default:

- `AIFINPAY_GATEWAY_ORIGINS` — origins this agent may settle against. The
  wrapper never exposed a parameter `@aifinpay/agent` has always supported, so
  self-hosted merchants were unreachable: `payable_fetch` reached the 402 and
  refused. Validated as bare https origins with plain hostnames — a wildcard is
  rejected rather than stored and silently matched against nothing.
- `AIFINPAY_TRUSTED_HOSTS` — hosts whose DNS pre-check is skipped, matched
  exactly. Behind an HTTP proxy the client cannot resolve at all, so the SSRF
  guard refused every host as "cannot resolve". Deliberately per-host and not a
  proxy-detection switch: "disable the check when proxied" turns an environment
  quirk into a blanket SSRF bypass.

## @aifinpay/agent 1.8.4 · aifinpay-agent 1.4.1

### Fixed

- **`agent.call({provider})` works against live bridges again.** The production
  bridges renamed their 402 payment block `pay_matic` → `pay_native` on
  2026-08-04 (when the on-chain entrypoint became `payNative`) and no SDK
  release followed, so the call failed against every bridge with an error
  blaming facilitator wiring. Both names are now accepted, newest first, in
  `nativePayBlock` / `native_pay_block`; `pay_matic` stays supported for
  bridges not yet redeployed. Guarded by a fixture captured verbatim from a
  production 402 — the bug survived as long as it did because the old tests
  authored their own fixtures in the SDK's vocabulary. (AIFINP-118)

## @aifinpay/agent 1.8.3

### Added

- **`@aifinpay/agent/wallet` — derive a wallet without the transaction stack.**
  `deriveWallet(seedHex)` and `newWallet()` return the Solana, EVM and Casper
  addresses (and the raw keys) using only tweetnacl + bs58 + @noble, and the
  subpath's module graph is free of viem and @solana/web3.js — asserted by a
  test that fails if either ever enters it. Byte-for-byte identical to
  `AiFinPayAgent`, verified against the full class. For agents that only need a
  wallet, this is the light door: importing it into a bundle drops the ~157 MB
  transaction stack a full `AiFinPayAgent` import pulls, which in a constrained
  sandbox is the difference between installing and failing (AIFINP-117).
  Unlike `AiFinPayAgent.new()`, `newWallet()` returns a recoverable seed.

## @aifinpay/agent 1.8.2

### Fixed

- **An agent hitting a real x402 endpoint now gets a comprehensible error.**
  `standard-x402.ts` targets x402Version 1; the live standard is version 2 and
  sends payment data base64-encoded in a `payment-required` response header
  rather than in the body. Our detector returned false for it — correct — but
  `CoinbaseX402Facilitator` then claimed the response, because it looks for a
  `PAYMENT-REQUIRED` header and HTTP header names are case-insensitive. The
  agent failed deep inside a facilitator that had nothing to do with the
  endpoint it was talking to.

  `detectFacilitator` now recognises v2 before choosing a facilitator and
  refuses with a message naming the version. Interoperability is unchanged —
  still none — but the failure is legible instead of misleading.

- The file header claimed this facilitator made agents "interoperable with the
  wider x402 economy (Coinbase, Dexter, 69k+ agents)". It shipped in 1.8.1 and
  could not complete a single payment to any of them. It now describes what the
  implementation actually targets and how it differs from the live standard.

## @aifinpay/agent 1.4.0 · aifinpay-agent 1.2.0 — 2026-08-01

### Changed
- **B2BSplitter v1.2 on Polygon, Optimism, BOT Chain and XRPL EVM.** The
  entrypoint is now `payNative(bytes32 paymentId, address merchant, address
  ipCreator, string memo)` and the contract rejects a paymentId it has already
  settled. Base and Unichain were not part of that rollout and still use
  `payMatic`, so the ABI is selected per chain rather than per release — sending
  v1.2 calldata to a v1.1 contract reverts with no useful reason.
- `paymentId` is derived deterministically from the quote's order id. Random ids
  would satisfy the contract while defeating the guard: the point is that the
  same order cannot be paid twice. A retry after a *reverted* transaction is
  unaffected, since a revert settles nothing.
- A bridge may now send `splitter_version` alongside `splitter`; it takes
  precedence over the built-in registry, because the server knows what it just
  deployed. Absent, it is treated as 1.1.

### Fixed
- The registry shipped the superseded Polygon splitter `0xE34F…8440`, which v1.2
  replaced. Every address here was re-checked with `eth_getCode` on its own
  chain on 2026-08-01.

## @aifinpay/agent 1.3.3 · aifinpay-agent 1.1.3 — 2026-07-30

### Fixed
- **1.3.2 broke the default registry lookup it was meant to fix.** That release
  reordered the candidate paths to try `/providers` first, which is right for
  `api.aifinpay.io` but wrong for the Node SDK's default base of
  `https://aifinpay.io`, where `/providers` hits the single-page-app catch-all
  and returns **200 with HTML**. The fallback only advanced on a 404, so it
  accepted the HTML and failed inside `JSON.parse`. The Node default had in fact
  been working before 1.3.2; only the Python default (which points at
  `api.aifinpay.io/api/providers`, a genuine 404) was broken.
- `/api/providers` is now tried first — correct for the default base, and a wrong
  guess there is a clean 404 rather than a 200 of HTML — and a response is only
  accepted when it parses as JSON containing a `providers` array. A 200 that is
  not a registry document is treated as a miss and the next candidate is tried,
  so a proxy or SPA catch-all can no longer masquerade as the registry.
- Verified against production with both base URLs and with an explicit
  `registryUrl` pointed at the SPA path, which now fails with
  `200 but not JSON` instead of an opaque parse error.

## @aifinpay/agent 1.3.2 · aifinpay-agent 1.1.2 — 2026-07-30

### Fixed
- **Provider registry lookup 404'd against production**, so
  `agent.call({provider})` / `agent.call(provider=...)` could not resolve any
  provider through `api.aifinpay.io`. Both SDKs defaulted the registry to
  `https://api.aifinpay.io/api/providers`, but that host rewrites `^/(.*)` to
  `/api/$1`, so the request arrived as `/api/api/providers`. The registry lives
  at `/providers` there; a backend reached directly still serves it at
  `/api/providers`, so both are now tried, edge first. Only a `404` advances to
  the next candidate — any other status is the registry answering badly and is
  raised as-is rather than masked by a retry against a different path. An
  explicitly configured `registryUrl` / `AIFINPAY_REGISTRY_URL` is honoured
  exactly and never retried elsewhere.

## @aifinpay/agent 1.3.0 — 2026-07-16

### Added
- **Multi-EVM splitter settlement (native token, direct path)** —
  `AiFinPayAgent.call()` now settles `B2BSplitter.payMatic` on every
  chain in the new exported `SPLITTER_DEPLOYMENTS` registry: Polygon
  (default), Base, Optimism, Unichain, BOT Chain, XRPL EVM. All splitter
  addresses verified on-chain (`eth_getCode`) before inclusion. `payMatic`
  is the splitter's generic native-token entrypoint (POL/ETH/BOT/XRP) —
  there is still **no ERC-20/USDC settlement path**.
- `ChainId` widened (additive union) to `"solana" | SplitterChainName`;
  new exported types `SplitterChainName`, `SplitterDeployment`,
  `AnyEvmChainName`. `evmRpcUrls` now accepts overrides for the new
  chains (public RPC fallbacks built in).
- Safety: `call()` refuses a `pay_matic` challenge denominated for a
  different chain than the one routed; per-chain native-USD guard envs
  (`AIFINPAY_ETH_USD`, `AIFINPAY_BOT_USD`, `AIFINPAY_XRP_USD`;
  `AIFINPAY_MATIC_USD` kept for Polygon back-compat).

### Unchanged
- Solana settlement (`b2b_pay_with_split`) byte-identical.
- Backend-quoted invoice flow (`/api/b2b/pay-with-split`,
  `/api/b2b/quote-split`, MCP `pay_with_split` / `quote_split` tools)
  remains Polygon + Solana — backend constraint, documented in-code.
- Python SDK direct settlement remains Polygon + Solana.

## 1.0.0 — 2026-06-16

First stable release. The three packages graduate from alpha to a
semver-stable `1.0.0` on PyPI and npm under the default (`latest`) tag.

### Packages
- `aifinpay-agent` (Python) — `1.0.0`
- `@aifinpay/agent` (Node / TypeScript) — `1.0.0`
- `@aifinpay/mcp` (MCP server) — `1.0.0`

### Stable
- **Unified `AiFinPayAgent` surface** — chain-opaque `call({provider})`
  plus `openSession` / `balance` / `verify` / `deposit`. The legacy
  chain-aware `Agent` class stays exported and continues to work.
- **Non-custodial settlement** — the agent's private key never leaves
  the process; payment is a single atomic on-chain transaction.
- **Multi-chain** — Polygon + Solana mainnet, with the SDK selecting the
  funding path so callers don't hand-pick a chain.
- **Fee-on-top split** — `quote_split` / `pay_with_split` surface the
  merchant / protocol / referral breakdown before paying.
- **MCP server** — `@aifinpay/mcp` exposes the agent payment tools to
  MCP runtimes (Claude Code, Cursor, etc.).
- **Cross-chain helpers** — `bridgeQuote` / `bridgeExecute` /
  `bridgeWaitForArrival` over third-party bridges (funds never touch
  AiFinPay infra).

### Changed
- Install commands no longer require a prerelease tag:
  `pip install aifinpay-agent` and `npm install @aifinpay/agent`.
- All documentation, example endpoints, and contact email moved to the
  canonical `aifinpay.io` domain. The legacy `aifinpay.company` host is
  fully retired (DNS removed).

### Notes
- Semver guarantees apply from `1.0.0`: no breaking changes without a
  major bump; deprecations ship with a minor and a migration note.
