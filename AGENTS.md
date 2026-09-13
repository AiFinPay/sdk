# AiFinPay SDK — agent guide

Primary instructions: node_modules/@daochild/agents-config/AGENTS.md — read in full and follow unless overridden below.

Payment rail for AI agents (AIFP-1 gross-inclusive settlement, AIFP-2/x402 negotiation). Security-candidate branch: build/test from source; never `npm install latest` as an upgrade. Canonical domain is `aifinpay.io` (`aifinpay.company` is retired).

## Layout (per-package rules in each `AGENTS.md`)

- `node/` — `@aifinpay/agent` (SDK). `python/` — `aifinpay-agent`. `mcp/` — MCP server (depends on the **published** `@aifinpay/agent`, not `../node`). `wallet/` — light wallet, keystore `~/.aifinpay/agent.json`. `gate/` — merchant paywall. `mcp-http/` — private transport shim, never publish. `deployments/` — canonical deployment registry grabber (`@aifinpay/deployments`, private). `skills/` — agent skill markdowns.

## Commands

- Node 22, Python 3.13. Use `npm ci --no-audit --no-fund` (never `npm install`) so lockfiles stay authoritative.
- Per package: `npm run build` (`tsc`) then `npm test` (`vitest run`) from `node/`, `wallet/`, `mcp/`, `gate/`, `deployments/`; `python -m pytest tests -q` from `python/` (install with `python -m pip install -e . pytest`).
- `node/`: run `npm run registry:check` before build — it verifies `*.generated.ts` against the vendored registry artifact + provenance. Never hand-edit `*.generated.ts`; change `registry/` inputs or `scripts/generate-splitter-routes.mjs`, then `registry:sync`.
- `deployments/`: run `npm run build` then `npm run registry:build` to refresh `registry/deployments.json` from upstream repos; keep `registry/abi/` and `registry/idl/` paths documented for downstream ABI/IDL artifacts.
- Version gate: changing published files without a version bump fails CI (`scripts/check-version-bump.mjs`). Bump version + CHANGELOG together.
- Breaking `node/` changes are invisible to the `mcp` release job until published — verify with the `mcp-against-source` flow (pack `node/`, install tarball into `mcp/`, build + test).

## Security rules

- Fail closed: never weaken route verification, receipt verification (`jose`), quota checks, or runtime verification in `mcp/src/tools|api.ts`.
- Secrets: never log, print, or persist seeds/secret keys. Keystore `~/.aifinpay/agent.json` is mode 600 (dir 700); `wallet new` must refuse to overwrite.
- Signing tools in `mcp/` stay gated until `@aifinpay/agent` v2 — do not ungate.
- `npm audit --omit=dev --audit-level=high` must pass for `node/` and `mcp/`; keep `mcp-http` `private: true` with its `ws`/`fast-uri`/`ip-address` overrides and rate limiting.
- Tests: no live network/RPC — mock at `settlementHttp.ts`, `safe-fetch.ts`, `client.py`, or facilitator boundaries. SSRF coverage in `mcp/tests/` must keep passing.
- Economics are consensus-critical: AIFP-1 = 1% inside gross (merchant 99%); do not touch fee splits, payout addresses, or settlement flags without a pinned deployment + paid E2E evidence.

## Skills

- Default skills directory is `.agents/skills/` (repo-local). Do not create `skills/` top-level dirs elsewhere; `skills/` at root is the shipped agent-skill markdown, not the skills workshop.
- Principal skill: **yagni-principle** (`.agents/skills/yagni-principle/SKILL.md`) — smallest change that satisfies the request; no speculative abstractions, no new deps/frameworks, no "while I'm here" refactors. A new helper needs 2+ call sites; a new dep needs no-stdlib-feasible justification.
