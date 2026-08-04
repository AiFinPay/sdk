# Changelog

All notable changes to the AiFinPay SDK packages are documented here.
Versioning follows [Semantic Versioning](https://semver.org/). From
`1.0.0` onward the public API is stable and changes follow semver.

## @aifinpay/agent 1.7.1 — 2026-08-04

### Security
- **AIFINP-62:** untrusted 402 responses can no longer choose a splitter,
  ABI/version, merchant, royalty recipient, fee breakdown, asset domain, or
  fallback route that reaches wallet signing.
- The EVM route is bound to chain ID, exact address, runtime codehash,
  version, treasury/governance, fee policy, merchant and a validity window.
  RPC failures, empty code, stale entries and mismatches fail closed.
- Legacy v1.1 signing and the dynamic `payMatic` fallback were removed.
  Deployments controlled by the single-EOA treasury remain in inventory but
  are disabled; only the Polygon v1.2 Safe-governed target is enabled.
- Standard x402 EIP-3009 signing is disabled until a signed registry binds
  asset/codehash/decimals, `payTo`, EIP-712 domain and validity. Detection and
  a traceable error remain available; no account signing method is called.

### Tests
- Added 19 adversarial target/metadata tests covering wrong target, chain,
  version, merchant, royalty, fee components, expiry, disabled legacy routes,
  RPC timeout, wrong RPC chain, EOA/empty code, codehash mismatch and failed
  contract introspection before signing.

## @aifinpay/mcp 1.4.1 — 2026-08-04

### Fixed
- Declared `tweetnacl` and `bs58` as direct dependencies because
  `agent-claim-self.ts` imports them directly. MCP builds no longer depend on
  accidental transitive hoisting from `@aifinpay/agent`.
- CI now rebuilds MCP against the Node SDK from the same commit, ensuring the
  target-validation changes actually reach MCP payment tools before publish.

## aifinpay-agent 1.3.1 — 2026-08-04

### Security
- Mirrored the Node fail-closed Polygon registry checks in Python: exact
  splitter/version/merchant/fee terms plus live chain/codehash/governance read.
- Removed the Python v1.1 `payMatic` fallback and treasury-on-RPC-failure path.
- Added 16 positive/adversarial tests; no transaction is constructed until the
  quote and runtime target both validate.

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
