# Changelog

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
