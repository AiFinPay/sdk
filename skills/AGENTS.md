# skills/ — agent guide

Agent skill markdowns: `SKILL.md` (payer/agent flow) and `MERCHANT_SKILL.md` (merchant gate flow).

## Scope
- Markdown only. No code, no frontmatter changes without checking consumers (`mcp/skills/`, catalog listings).

## Rules
- Keep instructions aligned with the shipped packages (`@aifinpay/wallet`, `@aifinpay/mcp`, `@aifinpay/gate`); if a CLI command or tool name changes, update here in the same PR.
- Do not document ungated signing or unverified settlement — match the gated behavior in `mcp/`.
- Short, copy-pasteable commands; verify every command by running it before committing.
