# Changelog

## @aifinpay/analytics 0.2.0 — unreleased

- Telemetry is on unless turned off. Unset or empty `AIFINPAY_TELEMETRY`
  means `on`; `off`, `0`, `false`, `no`, any unrecognised value,
  `DO_NOT_TRACK=1|true` and `CI` mean off; an explicit `on` or `read-only`
  wins over both.
- The first default-on run that creates the install id prints one line to
  stderr. The postinstall script still does anything only under `install`.

## @aifinpay/analytics 0.1.1 — unreleased

- Default destination `https://api.aifinpay.io/v1/agent`, the host that serves
  the telemetry route. The earlier default named a host that does not exist.

## @aifinpay/analytics 0.1.0 — unreleased

- New package: opt-in SDK telemetry, off by default. `emit`, `configure`,
  `shutdown`, `isEnabled`; modes `off` / `on` / `read-only` / `install`.
- Red-team payload sanitization, schema v1 event catalog, bounded queue,
  batches of at most 64, 1.5 s timeout with one retry, redirects refused.
- Random install id at `~/.aifinpay/.telemetry-id` (600/700), never written in
  `read-only`. Postinstall install event only under `AIFINPAY_TELEMETRY=install`.
- No consumer wiring yet; `@aifinpay/agent` adoption is a separate change.
