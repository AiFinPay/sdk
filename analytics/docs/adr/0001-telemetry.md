# ADR 0001 — SDK telemetry lives in `@aifinpay/analytics`

Status: proposed (2026-10-14); the default changed from off to on in 0.2.0 (item 9). Tracks AIFINP-239; the receiving gateway is AIFINP-240.

## Context

We want to know how the SDK is used and where it fails — which settlement
paths run, how often route verification refuses, where wallets fail to load —
without collecting anything that identifies a person or could move money.
Each consumer package wiring its own telemetry would mean several env-var
contracts, several network surfaces and several sanitizers to review.

## Decision

One standalone, zero-dependency package owns the contract. Consumers only call
`emit(name, payload)`.

1. **Transport.** Self-hosted `POST` to `AIFINPAY_TELEMETRY_URL`, default
   `https://api.aifinpay.io/v1/agent`. HTTPS only (loopback HTTP for
   development); an unusable override disables sending. Timeout 1.5 s, at most
   one retry (network error, timeout, 429, 5xx only), redirects refused.
   Bounded queue of 256, drop on overflow, batches of at most 64 events and
   ~90 KB (the gateway's event and body limits), fire-and-forget; consumers
   never `await` `emit`.
2. **Install id.** Random UUID at `~/.aifinpay/.telemetry-id`, file 600,
   directory 700, created exclusively by the first run that sends. Wiping the file resets
   it. A malformed file is left untouched.
3. **Failure visibility.** Consensus-critical refusals (`NoDeploymentError`,
   `SettlementRouteNotSettlingError`, `SettlementProtocolError`, on-chain route
   verification failure) get dedicated event names in the catalog; they never
   count as success. Telemetry never changes control flow: emit failures are
   swallowed.
4. **Schema versioning.** `AIFINPAY_TELEMETRY_SCHEMA_VERSION` (1), sent as the
   `AIFP-Telemetry-Schema` header and in the body. Unknown event names are
   dropped locally because the gateway refuses the whole batch. A breaking
   change waits at least 90 days after the previous one.
5. **Consumer relationship.** Consumers list `@aifinpay/analytics` under
   regular `dependencies`, not optional ones: one version-pinned contract and
   no "missing optional dependency" failure mode, at the cost of a slightly
   larger install that cannot be tree-shaken. `AIFINPAY_TELEMETRY=off` keeps
   the network quiet. The `mcp-against-source` pack flow
   must still pass once `node/` imports it.
6. **Retention.** 30 days hot, no cold tier, enforced by the gateway
   (AIFINP-240); needs the backend team's confirmation before launch.
7. **Modes.** `on` (default) | `off` | `read-only` | `install`.
   - `install` is a separate consent level: it runs at `npm install` time,
     not in user code, so it is not folded into `on`. In `install` mode only
     `agent_sdk_install_completed` is sent; runtime modes never send it.
   - `read-only` sends runtime events but never writes to disk: it reuses an
     existing install id or uses a per-process one. This is our reading of the
     ticket's distinction between the two runtime levels; confirm in review.
8. **Sanitization.** Every payload is scrubbed before queueing (seeds, hex and
   base58 keys, JWTs, bearer tokens, ≥64-byte hex, credential-named fields,
   URL paths and queries; addresses shortened to first-4/last-4; errors
   reduced to their class). Events over 4 KB are dropped. Over-redaction is
   accepted.
9. **Default on.** An opt-in default showed only our own runs, so unset or
   empty means `on`. `off`, `0`, `false`, `no`, any unrecognised value,
   `DO_NOT_TRACK=1|true` and a `CI` value other than empty, `false` or `0` mean
   off; an explicit `on` or `read-only` wins over both. The run that creates
   the install id without an explicit `on` prints one line to stderr; if the
   file cannot be written it sends with a per-process id and prints nothing.
   The postinstall script stays behind `install`.

## Consequences

- One package to security-review; consumers add call sites only.
- The event catalog is a wire contract shared with the gateway: adding a name
  needs both sides in the same release.
- The postinstall script runs on every install of the package. It exits before
  loading anything unless `AIFINPAY_TELEMETRY=install`, and always exits 0.

## Security review checklist

- [ ] Unset means on; `off`, `DO_NOT_TRACK`, `CI` turn it off; typo or invalid URL cannot enable sending.
- [ ] No runtime dependencies; `npm audit --omit=dev --audit-level=high` clean.
- [ ] Red-team suite covers every redaction class.
- [ ] Install id: random, 600/700, never logged, never derived from the host.
- [ ] No timers; `shutdown()` flushes; `emit()` never throws.
- [ ] Postinstall: no load unless `AIFINPAY_TELEMETRY=install`, exit code always 0.

## Open questions

- Confirm the 30-day retention and that `api.aifinpay.io` is the live
  hostname before any consumer ships with it.
- When `mcp/` or `wallet/` gain their own postinstall scripts, they should
  call this package's script rather than emit their own install event.
