# @aifinpay/internal-tokenlist

Token list and contract ABIs for AiFinPay internal assets (AIFINP-78).

**The token list is generated from live chain reads — never hand-edit
`tokenlist/internal.json`.** The generator carries only addresses and their
provenance; `name`/`symbol`/`decimals` come from the chain, and generation
fails on a codeless address, an unreadable token, or any disagreement with the
pinned expectations. A wrong address is a build failure here, never a payment
error downstream (the 18-decimals BSC USDT trap — AIFINP-120 — is the class of
error this removes).

## Usage

```ts
import { INTERNAL_TOKENLIST, ERC20_ABI, findToken } from "@aifinpay/internal-tokenlist";

const bscUsdt = findToken("BSC", "0x55d398326f99059fF775485246999027B3197955");
// bscUsdt.decimals === 18
```

Key on `(network, address)`, never on symbol — Polygon USDT self-reports its
symbol as `USDT0`.

## Adding a token

1. Add the address to `EVM_TOKENS` or `SOLANA_TOKENS` in
   `scripts/gen-tokenlist.mjs`, with a provenance note and the expected
   decimals/symbol.
2. `npm run generate` — fails unless the chain agrees with your pins.
3. `npm test` — offline schema and trap guards.

CI should run `npm run generate:check` (drift gate against live chain state)
and `npm test`.

## Adding an ABI

Drop the JSON array in `abi/` and export it from `src/index.ts`. The AIFP
contract ABIs (Core, Passport, mSECCO, splitter) should be lifted from
`backend/polygon.js`, which is verified against deployed bytecode — several
fragments there were corrected after the deployed contracts diverged from
source (`paused()` reverts, `isPaused()` does not). Do not rewrite them from
the Solidity.

## Not yet included

- Tron USDT (`TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`) — needs a TronGrid read
  path in the generator before it can be verified rather than trusted.
- AIFP contract entries/ABIs — pending the lift from `backend/polygon.js`.
