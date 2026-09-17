# AiFinPay SDK — Claude Code instructions

Project memory. Root `AGENTS.md` is the single source of truth — read it first.

@AGENTS.md
@node_modules/@daochild/agents-config/AGENTS.md
@node_modules/@daochild/agents-config/.claude/rules/programming-best-practices.md
@node_modules/@daochild/agents-config/.agents/rules/sdlc-gates.md

## Shared SDLC wiring (from `@daochild/agents-config`)

Unlike `opencode.json`, Claude Code has no config hook to inherit agents/skills
from `node_modules` — so start sessions with the shared package as an added
directory instead:

```bash
claude --add-dir node_modules/@daochild/agents-config
```

That loads its `.claude/skills/` (`sdlc-regulatory`), `.claude/commands/`
(`/sdlc`), and `.claude/agents/` (orchestrator + 9 roles) for the session.
Do not copy those files into this repo — inherit, don't duplicate.

## Claude Code-specific notes

- Repo skills live in `.agents/skills/` (`yagni-principle`, `grill-me`); shared
  domain skills (auditors, `sdlc-regulatory`) are inherited from
  `node_modules/@daochild/agents-config/.agents/skills/` — load via the Skill
  tool, do not copy them into this repo.
- Always verify against the `node/`, `python/`, `gate/`, `mcp/`, `wallet/`
  package scopes in root `AGENTS.md` before editing outside the task's package.
- Keystore `~/.aifinpay/agent.json` is off-limits: never read, edit, or print it.
