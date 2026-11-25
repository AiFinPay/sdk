# @aifinpay/analytics

Telemetry for AiFinPay SDK packages. **On unless turned off** with
`AIFINPAY_TELEMETRY=off`. Zero runtime dependencies: `node:fetch`, `node:fs`
and `node:crypto` only.

This package owns the whole telemetry contract — the environment
variables that turn it off, the install id, payload sanitization, transport and the event
schema — so there is one network surface to review. Consumer packages
(`@aifinpay/agent`, `@aifinpay/mcp`, …) only call `emit()`.

## Turning it off

| `AIFINPAY_TELEMETRY`                 | What happens                                                                                                      |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| unset or empty                       | Runtime events are sent. A random install id is stored at `~/.aifinpay/.telemetry-id`.                            |
| `on`                                 | The same, and it wins over `DO_NOT_TRACK` and `CI`.                                                               |
| `read-only`                          | Runtime events are sent, but nothing is written to disk: an existing install id is reused, else a per-process id. |
| `off`, `0`, `false`, `no` (any case) | Nothing is sent, nothing is written.                                                                              |
| `install`                            | Only the one-shot `agent_sdk_install_completed` event from the postinstall script. Runtime events stay off.       |
| anything else                        | Off: a typo never turns sending on.                                                                               |

Unless the value is `on` or `read-only`, `DO_NOT_TRACK=1` (or `true`) and a
`CI` variable other than empty, `false` or `0` also turn it off. The first
run that stores an install id without an explicit `on` prints one line to
stderr, never to stdout; if the id file cannot be written, the run sends with
a per-process id and prints nothing. Nothing is sent at install time unless
`AIFINPAY_TELEMETRY=install`.

`AIFINPAY_TELEMETRY_URL` overrides the destination (default
`https://api.aifinpay.io/v1/agent`). It must be HTTPS, or HTTP on
loopback for local development. An unusable value disables sending — it never
falls back to the default.

## What is sent

```json
{
  "schema_version": 1,
  "install_id": "8f2c…-uuid",
  "mode": "on",
  "events": [{ "name": "settlement_execute_confirmed", "ts": 1792000000, "payload": { "network": "polygon" } }]
}
```

Headers: `AIFP-Telemetry-Schema`, `AIFP-Telemetry-Install`,
`AIFP-Telemetry-Mode`, `AIFP-Telemetry-User-Agent` (package and Node version).
Only names in the schema catalog (`EVENT_NAMES`) are sent; anything else is
dropped locally.

## Payload sanitization

Every payload passes through a scrubber before it is queued. It removes seed
phrases, private keys (hex and base58), JWTs, bearer tokens and signature-sized
hex blobs; shortens addresses to first-4/last-4; reduces URLs to their origin;
and replaces any field whose name looks like a credential (`privateKey`,
`passphrase`, `token`, …). Errors are reduced to their class name. Payloads are
bounded (depth 4, 32 keys, 32 array items, 256-character strings) and an event
over 4 KB is dropped.

## Behaviour

- `emit()` is synchronous for the caller and never throws. Sending happens on
  a microtask, in batches of at most 64 events and about 90 KB (the
  gateway's body limit is 100 KB).
- Bounded queue of 256 events; when full, new events are dropped.
- Each POST waits at most 1.5 s and is retried at most once, only after a
  network error, timeout, 429 or 5xx. Redirects are refused.
- No timers: an idle process exits as if this package were absent. Call
  `await shutdown()` before exit to flush what is queued.

```ts
import { emit, shutdown } from "@aifinpay/analytics";

emit("unified_call_succeeded", { network: "polygon", ms: 412 });
await shutdown();
```

## Resetting the install id

Delete `~/.aifinpay/.telemetry-id`. The next run that sends creates a new random
id. The id is never derived from the machine or user and is never logged.

## Threat model (summary)

The package sends only what consumers pass to `emit()`, after sanitization,
only while it is not turned off, only to an HTTPS destination. The postinstall
script loads nothing unless `AIFINPAY_TELEMETRY=install` and always exits 0.
See [docs/adr/0001-telemetry.md](docs/adr/0001-telemetry.md).
