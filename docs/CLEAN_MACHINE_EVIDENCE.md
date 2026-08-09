# Clean-machine package evidence (§14)

Run against the release candidate on `security/audit-2026-08-06-remediation`.
Both packages were built, packed, and installed into an empty project with no
knowledge of this repository.

## Packages

| | Version | Files | Packed |
|---|---|---|---|
| `@aifinpay/agent` | 1.9.0-rc.1 | 62 | 92.9 kB |
| `@aifinpay/mcp` | 1.6.0-rc.1 | 39 | 20.7 kB |

Neither tarball contains `.env`, `.pem`, keypairs, or anything matching a
secret pattern. A repository-wide scan for private key headers, `sk_live_`,
Slack tokens, GitHub PATs and AWS keys returns nothing, and a scan for
unexplained 64-hex-character literals in `node/src`, `mcp/src` and
`python/aifinpay` returns nothing.

## Import / startup test

```
npm init -y
npm install ./aifinpay-agent-1.9.0-rc.1.tgz
node smoke.mjs
```

```
evmAddress: 0x467aeE37983Eb1d4aa98e837e7D621bD71Af0F48
networks: polygon,base,optimism,unichain,botchain,xrplevm
paymentIdFor: 0x1c9e2e3076…
fetchPaid present: true
aifp1Receipts present: true
```

The published surface works from a clean project, AIFP-1 included.

## 🔴 Release blocker found: MCP resolves the OLD SDK

Installing the MCP tarball into the same project produced this:

```
node_modules/@aifinpay/agent/package.json                     1.9.0-rc.1
node_modules/@aifinpay/mcp/node_modules/@aifinpay/agent/...   1.8.0   ← MCP uses this
```

`@aifinpay/mcp` declares `"@aifinpay/agent": "^1.8.0"`. npm does not admit a
prerelease into a stable range, so it installed a **nested
`@aifinpay/agent@1.8.0`** from the registry — the published build this
candidate exists to replace — and MCP resolves to that nested copy at runtime.

Nothing failed. The install succeeded, CI was green, and MCP was quietly
running against the wrong SDK. This is only visible from a clean install,
which is exactly why §14 asks for one.

**Why CI did not catch it.** MCP's job installed the local SDK *after* building
and testing, so the tests ran against the registry copy and the override only
affected a final rebuild. Fixed: the local SDK is now swapped in **before** the
build and test steps.

**What must happen at publish time.** MCP's range must be set to the released
SDK version. While the SDK is an unpublished RC the manifest cannot name it —
`npm ci` could not resolve it — so `scripts/check-mcp-sdk-pin.mjs` reports the
blocker without failing the build, and **fails hard the moment the SDK version
becomes stable**. A stable release therefore cannot ship the mismatch.

This is Pasha's release step, per §5.4. It is listed under known limitations in
the handoff.

## Gate status

| §14 gate | Status |
|---|---|
| Unit/regression: SDK Node, MCP, Python | pass — 167 / 34 / 105 |
| Build / type / lint, no masking ignores | pass |
| Dependency security, production graph | pass — agent 0 critical 0 high, mcp 0 critical 0 high |
| Secret scan, tracked files and tarballs | pass |
| Clean package: pack, inspect, install, import | pass, with the blocker above |
| Registry drift test | pass — see `evm-contract` registry CI job |
| Cross-origin / redirect negative tests | pass — Python facilitator suite |
| EVM deterministic E2E with balance deltas | pass on local network — 154 contract tests |
| EVM fork/mainnet settlement E2E | **not run** — v1.3 not deployed |
| Solana E2E | **not run** — v0.6 not deployed |
| Casper v2 E2E | **not run** — no verified deployment manifest |
| Wallet swap E2E | pass — curated pair quote, order, payout resolution, status |
| Final independent review | **not done** — needs a reviewer who did not author the fixes |
