# @aifinpay/analytics — agent guide

Opt-in SDK telemetry: env contract, install id, payload sanitization, transport
and the event schema. Read `docs/adr/0001-telemetry.md` before changing behaviour.

## Scope

- This package only. Consumers (`node/`, `mcp/`, `wallet/`, `gate/`,
  `mcp-http/`, `python/`) wire `emit()` in their own tickets.
- Entry: `src/index.ts`. Flow: `src/env.ts` → `src/emitter.ts` →
  `src/sanitize.ts` / `src/schema.ts` → `src/transport.ts`; install id in
  `src/identity.ts`; install event in `scripts/postinstall.js`.

## Commands

- `npm ci --no-audit --no-fund`, `npm run build`, `npm test` (vitest), from `analytics/`.

## Rules

- Default stays off. An unrecognised mode or unusable URL means no sending.
- Zero runtime dependencies. No third-party analytics SDKs.
- Never weaken `src/sanitize.ts`; a new redaction gets a case in
  `tests/redteam.test.ts`. Never log the install id or a payload.
- `install` must not leak into runtime events, and runtime modes never send
  the install event.
- The postinstall script must always exit 0 and must load nothing unless
  `AIFINPAY_TELEMETRY=install`.
- Event names are a wire contract shared with the backend gateway: adding one
  is additive (update both); renaming or removing one is a breaking schema
  change, at most once per 90 days.
- Tests never use the network; stub `fetch`.
