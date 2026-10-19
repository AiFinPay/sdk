# Changelog

## @aifinpay/analytics 0.1.0 — unreleased

- New package: opt-in SDK telemetry, off by default. `emit`, `configure`,
  `shutdown`, `isEnabled`; modes `off` / `on` / `read-only` / `install`.
- Red-team payload sanitization, schema v1 event catalog, bounded queue,
  batches of at most 64, 1.5 s timeout with one retry, redirects refused.
- Random install id at `~/.aifinpay/.telemetry-id` (600/700), never written in
  `read-only`. Postinstall install event only under `AIFINPAY_TELEMETRY=install`.
- No consumer wiring yet; `@aifinpay/agent` adoption is a separate change.
