# Contributing

Read root and package `AGENTS.md` before changes. This monorepo builds each
package independently; it has no root build orchestrator. Read runtime requirements
from package manifests and the tested matrix from [CI](.github/workflows/ci.yml).
Use each package's authoritative lockfile.

```sh
cd node
npm ci --no-audit --no-fund
npm run registry:check
npm run build
npm test
npm run lint
```

For Python, install its declared dependencies in a local virtual environment,
then run `python -m pytest tests -q` from `python/`. Keep the legacy import surface
working without EVM/Solana extras. Tests never use live RPC or real funds.

Node/MCP boundary changes require an actual packed SDK source cohort. Install
the packed agent and canonical sibling skill together with `--no-save`, retaining
the genuine registry lock. Test/build the installed package, not a source alias.
Source-cohort checks do not prove standalone registry release. Publication needs
actual dependency publication, lock refresh against that registry and required CI.

Generated deployment tables come from installed `@aifinpay/deployments`; change
the generator/input and regenerate, never hand-edit pins or enablement flags.
Change package version/changelog when published files change. Payment/signing,
budget/recovery and authorization changes require independent financial/security
review and the owner release gates. Contract/deployment governance belongs to
the relevant repository owners; coordinate before crossing that boundary.

Do not commit logs, private journals, credentials or local review artifacts.
Architecture decisions live in `docs/adr/`; user-visible API/configuration changes
must update package instructions as well as tests.

Keep operational evidence in its authoritative artifact, not copied into guides:
deployment pins and flags in the registry, test results in CI artifacts, and
payment evidence in the original transaction and verified receipt. Documentation
should link to these sources and explain how to verify them; it must not serve
as an activation or publication claim. See [the evidence rules](AGENTS.md#evidence-not-status-snapshots).
