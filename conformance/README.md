# Gate conformance

Language-neutral vectors for what a gate must answer, and a runner that drives any implementation over HTTP. No dependencies beyond Node. [`SPEC.md`](SPEC.md) is the contract in words.

This is an engineering test suite. It certifies nothing to anyone outside this repository.

```bash
(cd ../gate && npm ci && npm run build)
```

```bash
node scripts/gen-vectors.mjs --check
```

```bash
node run.mjs --subject=subjects/gate-node.mjs --ratchet
```

```bash
node --test tests/runner.test.mjs
```

The runner starts a private stand-in for the AiFinPay API (JWKS, public merchant record, resource registry, an ingest with the real one's rules), a test origin that resolves path spellings the way a forgiving server does, and a private `redis-server` when the subject wants one. It signs each receipt with a synthetic key, sends real HTTP, and records `pass`, `fail` or `na` with the reason. Read the counts, not the exit code: exit is non-zero on a `must` failure.

## Add an implementation

A subject is a module exporting `{ id, label, capabilities, supports(profile), start(ctx) }`; see [`subjects/gate-node.mjs`](subjects/gate-node.mjs). `start` returns `{ baseUrl, stop() }` and whichever hooks it can honour:

| Capability | Hook | Unlocks |
|---|---|---|
| `events` | `flushEvents()` | the `events.*` cases |
| `restart` | `restart({ cold })` | `meter.survives_restart`; a cold restart drops cached keys |
| `fault:jwks`, `fault:record` | `restart({ cold: true })` | outage cases, set on the stand-in API |
| `fault:store` | `breakStore()`, `healStore()` | meter outage cases |
| `fault:decision` | `breakDecision()`, `healDecision()` | sidecar outage cases |
| `proxy` | | `pass.*`: the subject proxies to `ctx.origin` |
| `pre_cache` | | the decision runs before any cache, so a reader's copy may be cacheable |
| `real_cache` | | `cache.real_*`: a real cache sits in the chain |

`--ratchet` compares against `known-differences.json`: a new failure or a fixed one fails the run. Adding a line there is a decision, and its reason says whose.

## Change the vectors

Edit `scripts/gen-vectors.mjs` and regenerate. Golden bodies come from the built `../gate`, so a change to the 402 shows up as a stale file in CI. A body change is a contract change: it needs its own proposal, and every port follows.
