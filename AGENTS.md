# AiFinPay SDK — agent guide

Primary instructions: `node_modules/@daochild/agents-config/AGENTS.md` — read in full and follow unless overridden below.

Payment rail for AI agents (AIFP-1 gross-inclusive settlement, AIFP-2/x402 negotiation). Published releases: Node `@aifinpay/agent` 2.1.x and MCP `@aifinpay/mcp` 2.2.x pay AIFP-1 on native Polygon v1.4; Python `aifinpay-agent` 2.2.x pays AIFP-1 via `fetch_paid`. Build and test from source. Never use `npm install @aifinpay/agent@latest` or `pip install aifinpay-agent` to stand in for this source. Canonical domain is `aifinpay.io` (`aifinpay.company` is retired).

## Layout

Monorepo of independent packages. Each package owns its own `AGENTS.md`; respect its scope.

- `node/` — `@aifinpay/agent` (Node/TS SDK, publishes `dist/`, `README.md`, `PAYMENT_RECEIPTS.md`).
- `mcp/` — `@aifinpay/mcp` (MCP server). Depends on the **published** `@aifinpay/agent` from npm, *not* `../node`.
- `wallet/` — `@aifinpay/wallet` (light wallet + CLI). Keystore: `~/.aifinpay/agent.json`.
- `gate/` — `@aifinpay/gate` (merchant AIFP-1 paywall, optional Express peer dep).
- `mcp-http/` — transport shim for `https://mcp.aifinpay.io/mcp`.
- `deployments/` — `@aifinpay/deployments` (canonical registry grabber, private).
- `python/` — `aifinpay-agent` (Python SDK).
- `skill/` — `@aifinpay/skill` (published skill markdown). Must stay mirrored with repo-root `skills/` and `mcp/skills/`.
- `examples/` — working reference bridges and framework integrations; syntax-checked in CI, not installed.
- Root `skills/` (not `.agents/skills/`) is the shipped agent-skill markdown.

## Commands

- Node ≥22, Python 3.13. Install Node packages with `npm ci --no-audit --no-fund` in each package directory; never run `npm install` at root or in a package.
- Each package is built/tested independently from its own directory:
  - `npm run build` then `npm test` in `node/`, `wallet/`, `mcp/`, `gate/`, `deployments/`.
  - `python -m pip install -e . pytest` then `python -m pytest tests -q` in `python/`.
- `node/`: run `npm run registry:check` **before** `npm run build`. It verifies `src/*.generated.ts` against the `@aifinpay/deployments` package installed as a local dependency. Never hand-edit generated files; change the `@aifinpay/deployments` inputs or `scripts/generate-*.mjs`, then run `registry:sync`.
- `node/`: `npm run registry:sync` regenerates both `src/splitterRoutes.generated.ts` and `src/v14Deployments.generated.ts`/`src/solanaV14Deployments.generated.ts` from `@aifinpay/deployments`. `npm run registry:check` verifies them in CI.
- `deployments/`: run `npm run build` then `npm run registry:build` to refresh `registry/splitter/evm/v1.4/deployments.json` and `registry/splitter/solana/deployments.json` from upstream repos.
- `mcp-against-source` flow: when changing `node/` in a way that affects `mcp/`, pack the agent (`cd node && npm pack --pack-destination /tmp`), install the tarball into `mcp/` (`npm install --no-save /tmp/aifinpay-agent-*.tgz`), then build and test `mcp/`. CI already runs this; verify locally when touching the Node/MCP boundary.
- Version gate: changing published files without a version bump fails CI (`node scripts/check-version-bump.mjs`). Bump `package.json` (or `python/pyproject.toml`) and the package/root `CHANGELOG.md` together.

## Security rules

- Fail closed: never weaken route verification, receipt verification (`jose`), quota checks, or runtime verification in `mcp/src/tools/` or `mcp/src/api.ts`.
- Secrets: never log, print, or persist seeds/secret keys. Keystore `~/.aifinpay/agent.json` is mode 600 (directory 700); `wallet new` must refuse to overwrite an existing keystore.
- Signing tools in `mcp/` stay gated until `@aifinpay/agent` v2 — do not ungate them.
- `npm audit --omit=dev --audit-level=high` must pass for `node/` and `mcp/`; keep `mcp-http` `private: true` with its `ws`/`fast-uri`/`ip-address` overrides and rate limiting.
- Tests must not use live network/RPC; mock at `settlementHttp.ts`, `safe-fetch.ts`, `client.py`, or facilitator boundaries. SSRF coverage in `mcp/tests/` must keep passing.
- Economics are consensus-critical: AIFP-1 = 1% inside gross (merchant 99%, AiFinPay 1%, creator/referral 0%). Do not touch fee splits, payout addresses, or settlement flags without a pinned deployment and paid end-to-end evidence.

## Workflow conventions

- No workspace build orchestrator (no Turbo/Nx/Just). CI runs each package independently.
- Per-package lockfiles are authoritative (`package-lock.json` in `node/`, `wallet/`, `mcp/`, `gate/`, `deployments/`, `mcp-http/`). Root `pnpm-lock.yaml` only tracks `@daochild/agents-config`.
- Root `opencode.json` loads this file plus shared agent config and skills; edit it only for agent/config changes, not for application code.
- Default repo-local skills live in `.agents/skills/`; root `skills/` is the published skill package content, not the skills workshop.
- Principal skill: **yagni-principle** (`.agents/skills/yagni-principle/SKILL.md`) — smallest change that satisfies the request; no speculative abstractions, no new deps/frameworks, no "while I'm here" refactors. A new helper needs 2+ call sites; a new dep needs a no-stdlib-feasible justification.
