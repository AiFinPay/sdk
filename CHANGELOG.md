# Changelog

All notable changes to the AiFinPay SDK packages are documented here.
Versioning follows [Semantic Versioning](https://semver.org/). From
`1.0.0` onward the public API is stable and changes follow semver.

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
