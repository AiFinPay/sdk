# Splitter Deployment Registry — Index

Versioned storage for B2BSplitter contract deployments across all supported chains and ecosystems.

## Structure

```
deployments/registry/splitter
├── INDEX.md                 # This file
├── evm/v1.1/                    # EVM Legacy — Initial version (immutable 1%/0.01% fee)
│   ├── README.md
│   └── deployments.json
├── evm/v1.2/                    # EVM Legacy — Added paymentId replay guard
│   ├── README.md
│   └── deployments.json
├── evm/v1.3/                    # EVM Route table — Protocol routes (merchant-aifp1 / agent-x402)
│   ├── README.md
│   └── deployments.json
├── evm/v1.4/                    # EVM Full contract suite — 7 contracts per chain
│   ├── README.md
│   └── deployments.json
├── solana/                  # Solana v1.4 — Program deployments (non-EVM)
│   ├── README.md
│   └── deployments.json
└── casper/                  # Casper — Placeholder (not yet deployed)
    ├── README.md
    └── deployments.json
```

## Quick Lookup by Version

| Version | Ecosystem | Status | Chains/Networks | Key Feature |
|---------|-----------|--------|-----------------|-------------|
| [v1.1](evm/v1.1/README.md) | EVM | Superseded | Base, Unichain | Initial production release |
| [v1.2](evm/v1.2/README.md) | EVM | Superseded | Polygon, Optimism, BOT Chain, XRPL EVM | `bytes32 paymentId` replay guard |
| [v1.3](evm/v1.3/README.md) | EVM | Active | 10 chains × 2 routes | Protocol routes with immutable fee splits |
| [v1.4](evm/v1.4/README.md) | EVM | Mostly disabled | 10 chains | Full contract suite (7 contracts per chain) |
| [v1.4](./solana/README.md) | Solana | Disabled | Devnet, Mainnet | Program ID + IDL (Anchor-style) |
| [v1/v2](./casper/README.md) | Casper | Testnet live | Testnet (live), Mainnet (historical v1) | Rust → Wasm contract; `register_agent` / `pay_agent` |

## Quick Lookup by Chain

### EVM Chains

| Chain | Chain ID | v1.1 | v1.2 | v1.3 Routes | v1.4 Status |
|-------|----------|------|------|-------------|-------------|
| Amoy | 80002 | — | — | `merchant-aifp1`, `agent-x402` (testnet, settlement enabled) | ✅ enabled |
| Arbitrum | 42161 | — | — | `merchant-aifp1`, `agent-x402` | ❌ disabled |
| Avalanche | 43114 | — | — | `merchant-aifp1`, `agent-x402` | ❌ disabled |
| Base | 8453 | ✓ | — | `merchant-aifp1`, `agent-x402` | ⚠️ invalid (redeploy required) |
| BNB | 56 | — | — | `merchant-aifp1`, `agent-x402` | ❌ disabled |
| BOT Chain | 677 | — | ✓ | `merchant-aifp1`, `agent-x402` | — |
| Optimism | 10 | — | ✓ | `merchant-aifp1`, `agent-x402` | ❌ disabled |
| Polygon | 137 | — | ✓ | `merchant-aifp1`, `agent-x402` | ❌ disabled |
| Robinhood | 4663 | — | — | — | ❌ disabled (TokenList empty) |
| Unichain | 130 | ✓ | — | `merchant-aifp1`, `agent-x402` | ❌ disabled |
| XRPL EVM | 1440000 | — | ✓ | `merchant-aifp1`, `agent-x402` | ❌ disabled (no stablecoin) |

### Non-EVM Ecosystems

| Ecosystem | Network | Program ID / Contract Hash | Status |
|-----------|---------|---------------------------|--------|
| [Solana](./solana/README.md) | Devnet | `8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y` | ❌ disabled (no backend verification) |
| Solana | Mainnet | `724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD` | ❌ disabled (no backend verification + upgrade authority not multisig) |
| [Casper](./casper/README.md) | Testnet | `hash-47df409829ddf0612617460293ba591a19b26fa0c06918878204088d3eb9b78a` | ✅ **live** (v2 verified) |
| Casper | Mainnet | `hash-7ad34a204952eef63d5dcf5159fb7d009e85dea4f49cbdf73dde190652dfa375` | ⚠️ **historical** (v1 — receipt only, no atomic transfer) |

## Governance

All v1.3 deployments are owned by the same governance Safe:

- **Safe:** `0xFd936f75D9221949f2FEaB54Cd342F7527154eD5`
- **Threshold:** 3 of 5
- **Owners:** 5 multisig signers

Legacy v1.1/v1.2 deployments have varying owners (see version-specific READMEs).

## Sources of Truth

### EVM v1.1-v1.3 (Route Table)

- **Source:** `AiFinPay/evm-contract/registry/generated/splitter-table.json`
- **Local copy:** `deployments/registry/reference/splitter-table.json`
- **Last updated:** 2026-08-30

### EVM v1.4 (Full Contract Suite)

- **Source:** `AiFinPay/evm-contract/deployments/*-v14-*-latest.json`
- **Local copy:** `deployments/registry/evm-splitter-v1.4.json`
- **Last generated:** 2026-09-13
- **Upstream commit:** `a54a4c107de7bb42f54e411e621d3897938bfc31`

### Solana v1.4 (Program)

- **Source:** `AiFinPay/solana-contract/deployments/splitter_v14/`
- **Local copy:** `deployments/registry/solana-splitter-v1.4.json`
- **Last generated:** 2026-09-13
- **Upstream commit:** `e5df8f5436cf646ab495381eee04e0d1a10b4e2f`

### Casper

- **Testnet (v2):** `hash-47df409829ddf0612617460293ba591a19b26fa0c06918878204088d3eb9b78a` — live, verified
- **Mainnet (v1):** `hash-7ad34a204952eef63d5dcf5159fb7d009e85dea4f49cbdf73dde190652dfa375` — historical, receipt-only (not valid settlement proof)
- **Source:** `AiFinPay/casper-contract` — Rust → Wasm contract
- **IDL:** Not applicable (Casper uses Rust contract schema, not Anchor-style IDL)

**Do not hand-edit** the JSON files in this directory. To update:

1. Change `registry/registry.json` in `AiFinPay/evm-contract`
2. Run `verify-registry.mjs` to verify against chain
3. Run `npm run registry:sync -- --from <path-to-evm-contract>` in `node/`
4. Copy updated `node/registry/splitter-table.json` to `deployments/registry/reference/`
5. Regenerate versioned files with a script (TODO: add generator)

## Related Artifacts

### EVM

- `registry/reference/splitter-table.json` — Raw upstream route table (v1.2 + v1.3)
- `registry/reference/splitter-table-source.json` — Provenance metadata
- `registry/evm-splitter-v1.4.json` — v1.4 full contract suite deployments
- `registry/abi/` — EVM ABI bundles and Tron ABI artifacts

### Solana

- `registry/solana-splitter-v1.4.json` — v1.4 program deployments
- `registry/idl/solana/splitter-v14/` — IDL copies (devnet + mainnet)

### Casper

- `registry/idl/casper/` — Casper IDL artifacts (contract schema, not Anchor-style)
- **Upstream:** `AiFinPay/casper-contract` — https://github.com/AiFinPay/casper-contract

### Combined

- `registry/evm-splitter-v1.4.json` — Generated EVM v1.4 deployments (matches `splitter/v1.4/deployments.json` schema)
- `registry/solana-splitter-v1.4.json` — Generated Solana v1.4 deployments (matches `splitter/solana/deployments.json` schema)

## Usage

### For SDK consumers

Use the `@aifinpay/agent` SDK's `resolveSplitterRoute(chain, route)` function — it reads from the generated `splitterRoutes.generated.ts` table.

### For auditors

1. Check `evm/v1.2` for superseded addresses
2. Verify migration guards in `node/tests/splitterV12.test.ts`
3. Compare runtime code hashes against on-chain `eth_getCode`

### For deployment verification

1. Check `evm/v1.3` for current addresses
2. Verify `runtimeCodeHash` matches deployed bytecode
3. Confirm `owner` and `treasury` match expected governance Safe
4. Check `validFrom`/`validUntil` policy window

## Security Notes

- **Address collisions:** Same address can appear on different chains/routes with different fee splits. Never select by address alone.
- **Settlement status:** `settlementEnabled: false` means the route is not cleared for mainnet payments.
- **Policy window:** Routes outside their `validFrom`/`validUntil` window must not settle.
- **Testnet opt-in:** Amoy routes require explicit `allowTestnet: true` flag in settlement code.
