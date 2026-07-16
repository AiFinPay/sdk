# Changelog

All notable changes to the AiFinPay SDK packages are documented here.
Versioning follows [Semantic Versioning](https://semver.org/). From
`1.0.0` onward the public API is stable and changes follow semver.

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
