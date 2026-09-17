# Settlement security candidate — 2026-09-12

This is source remediation for the supplied SDK/AIFP-1 audit. It is not a
production-readiness or mainnet activation report. Candidate versions:
Node/MCP `2.0.0-rc.12`, Python `2.0.0rc1`; publication remains separate.

## Fixed and exercised

- Native and stable v1.3 tuple ABI, independently decoded selectors
  `0x27a3bbaf` and `0x7d452d37`. Invoice identifiers bind to order IDs.
- Invoice binds requested amount, asset, recipient, order and expiry.
  Executor checks reviewed route/runtime hash, RPC and wallet chain,
  canonical economics, stable asset address/decimals and mined success.
- Polygon AIFP-1 `fetchPaid` uses the executor with a reviewed pin and fresh
  independent native/USD observation. The quote must identify the same
  v1.3 target/calldata and accepted POL/18 before the wallet is invoked.
- Confirmation timeout and receipt issuance failure preserve hash/quote
  recovery. Issued receipts enter the cache before content is requested.
  Concurrent callers share the purchase/failure; retrying content reuses it.
- API requests have redirect refusal, 15-second default deadline including
  body read, and 1 MiB response limit. Receipt issuer is independently set.
- MCP redirect modes, method/body preservation, cross-origin credential
  removal and mapped private IPv6 guards. Standard x402 USD caps use pinned
  chain/USDC identifiers, six decimals and integer atomic amounts.
- Canonical registry matches EVM commit
  `64e245fd613e97f95195239238d6ac75484a8a21`, SHA-256
  `36ee672b1deccd7b851460b459af26984ca07802477bc8c1e78018f5d5154827`.
  Amoy needs explicit testnet opt-in; mainnet flags remain disabled.
- Native v2 authentication binds trusted origin, method, path/query, body
  digest, nonce and expiry. Unbound v1 signing is retired in both SDKs.
- Removed legacy Node/Python payment submission bodies. The private legacy
  compatibility methods and public paid `call()` refuse; free responses work.
- v1.4 execution refuses before any RPC, wallet access or token approval.
  Read-only structural and nonce diagnostics do not authorize spending.

## Reproduce compatibility without funds

Build the Node package, then run from the SDK repository:

```sh
npm --prefix node run build
node scripts/check-settlement-compat.mjs /path/to/aifinpay-web/backend
node scripts/check-native-auth-compat.mjs /path/to/aifinpay-web/backend
```

The probe invokes the actual backend invoice handler and this SDK validator.
Only route resolution is a synthetic fixture. It does not activate a route,
contact RPC, use a real key or send a payment. Backend dependencies must exist.
Node tests additionally drive real executor code with mocked HTTP/RPC.
The native-auth probe signs with a fresh synthetic local identity, exercises
the actual backend gate, and rejects altered requests and consumed nonces.
Only seat lookup and metrics are stubbed; no external service is contacted.

Local verification of this candidate: Node **352 passed**, Python **69 passed**,
MCP **134 passed** against the locked registry dependency and **134 passed**
against the packed source SDK. The coordinated backend has **691 passed**,
no failures and one existing conditional skip. Native/stable invoice
compatibility and native-auth GET/POST, six request mutations and nonce replay
were exercised across the actual SDK/backend modules. Independent review of
the affected paths completed after the resulting edge cases were fixed.

## Open release work

Current v1.4 signatures do not commit mutable profile bps/resolved treasury.
EVM `78240ecc` has this at `B2BSplitterV14.sol:67,212,314` and
`Profiles.sol:75`. A preflight-only fix cannot close the change-before-mining
gap. The contract owner must review a signed economics commitment/versioned
immutable profile before a coordinated contract/backend/SDK upgrade.
Native and stable v1.4 execution are not implemented as a safe replacement.

Solana settlement verification remains unavailable; the coordinated backend
rejects v1.4 Solana quotes before signing/storage. Python has no replacement
paid `call()` executor. Native auth v2 requires the backend release as well.
Recovery/cache persistence across application restarts is the application's
responsibility; a fresh purchase is not a receipt-recovery operation.

MCP no longer has a high runtime advisory. Moderate transitive Solana
`jayson`/`stream-json`/`uuid` advisories remain; no forced major downgrade or
blanket audit exclusion was applied. CI rejects high/critical advisories and
Actions are pinned to commit SHAs. The RC MCP surface remains read-only and
is tested with both its locked registry dependency and this SDK's tarball.

Before publication/activation: review both dev PRs, verify coordinated native
auth compatibility, choose one reviewed enabled deployment, and run a separate
funded consumer test through quote → mined success → authorized receipt →
content 200 → receipt reuse. Component tests do not replace that evidence.
