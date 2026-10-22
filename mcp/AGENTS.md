# @aifinpay/mcp — agent guide

MCP production-RC control surface: Agent Passport resolution + runtime-verified AIFP-1/AIFP-2 settlement invoices. Signing tools stay gated until @aifinpay/agent v2.

## Scope

- This package only. Do not touch `gate/`, `mcp-http/`, `wallet/`, `node/`, `python/`.
- Entry: `src/index.ts`; server wiring in `src/server.ts`; tools in `src/tools/`; config in `src/config.ts`; keystore read in `src/identity.ts`.

## Commands

- `npm run build` — `tsc -p tsconfig.json`
- `npm test` — `vitest run` (from `mcp/`)
- Run locally: `npx @aifinpay/mcp` (reads `~/.aifinpay/agent.json`, created by `@aifinpay/wallet`)

## Rules

- Do not ungate signing tools or bypass runtime verification in `src/tools/` / `src/api.ts`.
- Payments are **safe while unfunded**, not "safe when the env is unset" (owner
  decision 2026-10-20, `Obsidian/proposals/2026-10-20-mcp-payments-on-by-default.md`).
  With no env, `payable_fetch` is on, but an ephemeral wallet never signs and a
  persistent one created by `init` holds nothing until the owner funds it. What
  bounds a funded wallet must keep holding with every variable unset: the
  built-in $5 / $20 ceiling checked in `persistPrepared` under the lock before
  broadcast, a backend-signed quote for a registered merchant (the 402 only
  names the merchant), the dashboard Controls the backend enforces, and the
  default gas cap. Env may only narrow these (`AIFINPAY_PAYMENTS_ENABLED=0`, a
  lower `AIFINPAY_MAX_USD`/`AIFINPAY_DAILY_USD`, an `AIFINPAY_GATEWAY_ORIGINS`
  allowlist); a value that would widen one is refused with a message, never
  clipped. Any new default that can move money needs the same argument.
- No new runtime deps without justification; keep stdio transport working (`bin/aifinpay-mcp.js`).
- `skills/` ships in the published files — keep it in sync if tools change.
- Tests go in `tests/`; no live network, mock via `src/safe-fetch.ts` patterns.
- Tests cover behavior and bundled skill consistency, not exact package versions
  in manifests or documentation. Keep protocol and contract version checks.


## FULL-PAYMENT-FLOW-20261004 source state

The user authorized coordinated Node/Python/MCP work on the existing v1.4 kernel.
Nine EVM client descriptors do not establish production readiness or activate
networks. Generated deployment pins, flags, profiles and economics are unchanged.
Stable token units are independent chain/address-pinned6/18 decimals and additive
quote metadata is validated. Preserve explicit owner chain, budgets, runtime,
payer proof, receipt/SSRF and durable recovery controls. MCP2.6.0 requires
agent2.4.0 source-pack integration, then published dependency/lock refresh before
standalone release. No publish/merge/contract operations are authorized by this note.
