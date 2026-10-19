# @aifinpay/analytics

Opt-in telemetry for AiFinPay SDK packages. **Off by default.** Zero runtime
dependencies: `node:fetch`, `node:fs` and `node:crypto` only.

This package owns the whole telemetry contract — the opt-in environment
variables, the install id, payload sanitization, transport and the event
schema — so there is one network surface to review. Consumer packages
(`@aifinpay/agent`, `@aifinpay/mcp`, …) only call `emit()`.

## Opting in

| `AIFINPAY_TELEMETRY` | What happens                                                                                                      |
| -------------------- | ----------------------------------------------------------------------------------------------------------------- |
| unset / `off`        | Nothing is sent, nothing is written. Any unrecognised value also means off.                                       |
| `on`                 | Runtime events are sent. A random install id is stored at `~/.aifinpay/.telemetry-id`.                            |
| `read-only`          | Runtime events are sent, but nothing is written to disk: an existing install id is reused, else a per-process id. |
| `install`            | Only the one-shot `agent_sdk_install_completed` event from the postinstall script. Runtime events stay off.       |

`AIFINPAY_TELEMETRY_URL` overrides the destination (default
`https://telemetry.aifinpay.io/v1/agent`). It must be HTTPS, or HTTP on
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

Delete `~/.aifinpay/.telemetry-id`. The next opted-in run creates a new random
id. The id is never derived from the machine or user and is never logged.

## Threat model (summary)

The package sends only what consumers pass to `emit()`, after sanitization,
only after explicit opt-in, only to an HTTPS destination. The postinstall
script loads nothing unless `AIFINPAY_TELEMETRY=install` and always exits 0.
See [docs/adr/0001-telemetry.md](docs/adr/0001-telemetry.md).
