# @aifinpay/skill — agent guide

Published skill package: `skills/aifinpay/SKILL.md` (payer) + `skills/aifinpay-merchant/SKILL.md` (merchant).

## Scope
- This package only. Do not touch `mcp/`, `gate/`, `wallet/`, `node/`, `python/`.
- Skill markdown is authored once and mirrored: repo-root `skills/` (canonical) → `skill/skills/` (npm) → `mcp/skills/` (MCP bundle, payer only). Update all three in the same PR.

## Commands
- `npm test` — validates frontmatter (`name`, `description`) from `skill/`
- `npm pack --dry-run` — verify tarball contents before publish

## Rules
- Keep instructions aligned with shipped packages and the gated MCP tool inventory; never document ungated signing or unverified settlement.
- Changing shipped files without a version bump fails CI (`scripts/check-version-bump.mjs`). Bump version + CHANGELOG together.
