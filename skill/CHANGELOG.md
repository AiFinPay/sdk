# Changelog

## 2.0.9

- Minimum Node engine is now 22 (`engines: >=22`). Node 18/20 are no
  longer supported. No skill content changes.

## 2.0.8

- Payer skill points Ready snippets at runnable `examples/agent-snippets/`
  files (TS/JS/Python) instead of inline code blocks.

## 2.0.7

- Payer skill adds Ready snippets: wallet create/load, `setBudget`, and
  paid-call code for TypeScript, JavaScript, and Python (verified against
  `node/src/unifiedAgent.ts` and `python/aifinpay/unified_agent.py`).

## 2.0.6

- Payer skill adds Code examples pointers: QUICKSTART paths, node/python
  READMEs, and runnable Node + Python examples in `examples/`.

## 2.0.5

- Payer skill adds Transaction display rules: never leak private keys/seeds
  in logs, pre-send payload summary (sender, recipient, rounded + exact
  base-unit amounts, currency) with invoice table, post-send payment id /
  tx hash / status / explorer link.

## 2.0.4

- Payer skill adds a Payment guideline: `.well-known/x402.json` discovery,
  AIFP-1 protocol, budget rules, wallet/balance/deposit flow, and the 1000
  USD per-account per-transaction limit (KYC above it).

## 2.0.3

- Install instructions use the `latest` release (unpinned `npx
  @aifinpay/mcp`, `npm install @aifinpay/agent`, `pip install
  aifinpay-agent`); dropped the "never install latest" guidance.

## 2.0.2

- Removed dead `files` entries (`SKILL.md`, `.claude-plugin` — not in the
  tree); tarball now matches the published file list exactly.
- Synced the prerequisites section into the `mcp/skills/` bundle copy.

## 2.0.1

- Payer skill states its required installs up front (`@aifinpay/mcp` for MCP
  clients, `@aifinpay/agent` / `aifinpay-agent` for code), pinned to
  `2.0.0-rc.12`; fixed stale `rc.11` pins.

## 2.0.0-rc.12

- Initial `@aifinpay/skill` release: ships `aifinpay` (payer) and
  `aifinpay-merchant` skills from a single npm package with
  `.claude-plugin/plugin.json` for skill marketplaces.
- Root `SKILL.md` is a two-sided index shim; canonical instructions live in
  `skills/<name>/SKILL.md`, mirrored from repo-root `skills/`.
