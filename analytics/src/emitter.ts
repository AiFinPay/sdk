/**
 * Fire-and-forget emitter. `emit()` is synchronous, never throws and never
 * blocks the caller: it validates, sanitizes and enqueues, and a microtask
 * flushes the queue in batches. The queue is bounded; when it is full new
 * events are dropped — telemetry loses data before it costs the host memory.
 * No timers are created, so an idle process exits exactly as it would without
 * this package.
 */
import { modeFromEnv, runtimeEnabled, urlFromEnv, validTelemetryUrl, MODES, type TelemetryMode } from "./env.js";
import { resolveInstallId } from "./identity.js";
import { sanitizePayload } from "./sanitize.js";
import { isKnownEvent } from "./schema.js";
import { sendBatch, type WireEvent } from "./transport.js";
import { AIFINPAY_TELEMETRY_SCHEMA_VERSION } from "./version.js";

export type EventName = string;
export type EventPayload = Record<string, unknown>;

export interface EmitOptions {
  /** Only for payloads this package's own callers already sanitized. */
  skipSanitize?: boolean;
  schemaVersion?: number;
}

export interface TelemetryConfig {
  /** null disables sending (an invalid AIFINPAY_TELEMETRY_URL produces null). */
  url: string | null;
  schemaVersion: number;
  timeoutMs: number;
  maxRetries: number;
  queueSize: number;
  mode: TelemetryMode;
}

/** The gateway accepts at most 64 events per POST (AIFINP-240). */
export const MAX_BATCH = 64;
/** The gateway refuses a serialized event over 4 KB with 413. */
export const MAX_EVENT_BYTES = 4096;
/** The gateway's JSON body limit is 100 KB; 64 large events would exceed it. */
export const MAX_BATCH_BYTES = 90_000;
const INSTALL_EVENT = "agent_sdk_install_completed";

let config: TelemetryConfig | null = null;
let queue: Array<{ event: WireEvent; schemaVersion: number; bytes: number }> = [];
let scheduled = false;
let inflight: Promise<void> = Promise.resolve();
let installId: string | null = null;

function current(): TelemetryConfig {
  config ??= {
    url: urlFromEnv(),
    schemaVersion: AIFINPAY_TELEMETRY_SCHEMA_VERSION,
    timeoutMs: 1500,
    maxRetries: 1,
    queueSize: 256,
    mode: modeFromEnv(),
  };
  return config;
}

export function configure(next: Partial<TelemetryConfig>): void {
  const base = current();
  const merged = { ...base, ...next };
  if (next.url !== undefined) merged.url = next.url === null ? null : validTelemetryUrl(next.url);
  if (!MODES.includes(merged.mode)) merged.mode = "off";
  merged.timeoutMs = clampInt(merged.timeoutMs, 1, 1500, base.timeoutMs);
  merged.maxRetries = clampInt(merged.maxRetries, 0, 1, base.maxRetries);
  merged.queueSize = clampInt(merged.queueSize, 1, 256, base.queueSize);
  merged.schemaVersion = clampInt(merged.schemaVersion, 1, Number.MAX_SAFE_INTEGER, base.schemaVersion);
  if (merged.mode !== base.mode) installId = null;
  config = merged;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  return Number.isInteger(value) ? Math.min(max, Math.max(min, value as number)) : fallback;
}

/** True when runtime events would actually be sent. */
export function isEnabled(): boolean {
  const cfg = current();
  return runtimeEnabled(cfg.mode) && cfg.url !== null;
}

function allowed(name: string, mode: TelemetryMode): boolean {
  // The install event has its own consent level; it is never a runtime event.
  if (name === INSTALL_EVENT) return mode === "install";
  return runtimeEnabled(mode);
}

export function emit(name: EventName, payload: EventPayload = {}, opts: EmitOptions = {}): void {
  try {
    const cfg = current();
    if (cfg.url === null || !allowed(name, cfg.mode) || !isKnownEvent(name)) return;
    if (queue.length >= cfg.queueSize) return;
    const safe =
      opts.skipSanitize && payload && typeof payload === "object" && !Array.isArray(payload)
        ? payload
        : sanitizePayload(payload);
    const event: WireEvent = { name, ts: Math.floor(Date.now() / 1000), payload: safe };
    const bytes = Buffer.byteLength(JSON.stringify(event));
    if (bytes > MAX_EVENT_BYTES) return;
    queue.push({ event, schemaVersion: opts.schemaVersion ?? cfg.schemaVersion, bytes });
    if (!scheduled) {
      scheduled = true;
      queueMicrotask(() => {
        scheduled = false;
        inflight = inflight.then(flush, flush);
      });
    }
  } catch {
    // Telemetry never surfaces an error to the host.
  }
}

async function flush(): Promise<void> {
  while (queue.length) {
    const cfg = current();
    if (cfg.url === null || cfg.mode === "off") {
      queue = [];
      return;
    }
    // One schema version per POST: the header and the body must agree.
    const version = queue[0].schemaVersion;
    let take = 0;
    let bytes = 0;
    while (take < queue.length && take < MAX_BATCH && queue[take].schemaVersion === version) {
      bytes += queue[take].bytes;
      if (take > 0 && bytes > MAX_BATCH_BYTES) break;
      take++;
    }
    const events = queue.splice(0, take).map((item) => item.event);
    try {
      installId ??= resolveInstallId({ persist: cfg.mode !== "read-only" });
      await sendBatch(
        { schema_version: version, install_id: installId, mode: cfg.mode, events },
        { url: cfg.url, timeoutMs: cfg.timeoutMs, maxRetries: cfg.maxRetries }
      );
    } catch {
      // dropped; see sendBatch for the retry policy
    }
  }
}

/** Flush what is queued and wait for in-flight sends. Call before process exit. */
export async function shutdown(): Promise<void> {
  await new Promise<void>((resolve) => queueMicrotask(resolve));
  inflight = inflight.then(flush, flush);
  await inflight;
}
