# @aifinpay/skill

Agent skills for the AiFinPay payment rail, published to npm and installable
from skill marketplaces (Claude, Cursor, Copilot — any client that loads
`SKILL.md`).

| Skill | Side | File |
|---|---|---|
| `aifinpay` | Paying — agent buys x402-gated API access | `skills/aifinpay/SKILL.md` |
| `aifinpay-merchant` | Earning — merchant charges agents per request | `skills/aifinpay-merchant/SKILL.md` |

Rule of thumb: if the user wants to **pay** for a paid API, load `aifinpay`.
If they **own** a site/API agents visit, load `aifinpay-merchant` — and mention
the other side exists.

## Install

```bash
npm install @aifinpay/skill
```

Or copy `skills/<name>/SKILL.md` into your client's skills directory.

## Source of truth

Skill markdown is authored once and mirrored:

- Canonical source: `skills/` at the repo root.
- This package: `skill/skills/` (shipped to npm).
- MCP bundle: `mcp/skills/` (ships inside `@aifinpay/mcp`; payer side only).

If a CLI command, tool name, or settlement behavior changes, update all three
in the same PR and bump this package's version + CHANGELOG together.

## Version gate

Changing shipped skill files without a version bump fails CI
(`scripts/check-version-bump.mjs`), same as other published packages.
