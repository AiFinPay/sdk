import { randomUUID } from "node:crypto";
import type { GateEvent } from "./types.js";
import type {
  Ack,
  HealthAck,
  Channel,
  Consent,
  FlowRequest,
  FlowResponse,
  HealthError,
  HealthSample,
  ReportedEvent,
  ReportingContext,
  ServerObservation,
} from "./types.js";
export type {
  Ack,
  HealthAck,
  Batch,
  BrowserEvent,
  BrowserObservation,
  Channel,
  Consent,
  ErrorResponse,
  FlowRequest,
  FlowResponse,
  HealthError,
  HealthSample,
  Mode,
  ReportedEvent,
  ReportingContext,
  ReportingReason,
  ResponseOutcome,
  ServerObservation,
  UUID,
  UTC,
} from "./types.js";

export interface GateReporterOptions {
  merchantId: string;
  merchantSecret: string;
  /** HTTPS origin only. Defaults to https://api.aifinpay.io. */
  apiBase?: string;
}

export type GateReporterError =
  | "invalid_event"
  | "queue_full"
  | "closed"
  | "expired"
  | "timeout"
  | "network"
  | "redirect"
  | "auth"
  | "rejected"
  | "server"
  | "invalid_response"
  | "retry_exhausted"
  | "shutdown";

export interface GateReporterStats {
  /** Includes events in the current HTTP request. */
  queued: number;
  delivered: number;
  dropped: number;
  retries: number;
  lastError: GateReporterError | null;
  stopped: boolean;
  closed: boolean;
}

export interface GateReporter {
  /** Synchronous enqueue only; pass directly to the gate's onEvent hook. */
  onEvent(event: GateEvent): void;
  /** Attempt every currently queued event once; transient failures stay queued. */
  flush(): Promise<GateReporterStats>;
  /** Stop accepting events, flush once, then drop unsent events and stop timers. */
  close(): Promise<GateReporterStats>;
  readonly stats: GateReporterStats;
}

interface Pending {
  event: { id: string; kind: "402" | "serve"; resource: string; at: string };
  created: number;
  attempts: number;
  nextAt: number;
}

const MAX_QUEUE = 1000;
const MAX_BATCH = 50;
const MAX_AGE = 15 * 60_000;
const MAX_ATTEMPTS = 5;
const TIMEOUT = 3000;
const DELAY = 1000;

/** Registered static/prefix patterns only; never turn a URL into a resource. */
function validResource(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\/(?!\/)[A-Za-z0-9_./:*{}-]{0,511}$/.test(value) &&
    !value.includes("//") &&
    !value.split("/").some((segment) => segment === "." || segment === "..")
  );
}

/** One instance per merchant per process, shared by all gate mounts. No keys,
 * receipts, headers or customer content are copied from gate events. */
export function createGateReporter(options: GateReporterOptions): GateReporter {
  if (!/^mrch_[a-f0-9]{16}$/.test(options.merchantId)) {
    throw new Error("createGateReporter: valid merchantId is required");
  }
  if (
    typeof options.merchantSecret !== "string" ||
    !options.merchantSecret ||
    Array.from(options.merchantSecret).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
  ) {
    throw new Error("createGateReporter: merchantSecret is required");
  }
  let base: URL;
  try {
    base = new URL(options.apiBase ?? "https://api.aifinpay.io");
  } catch {
    throw new Error("createGateReporter: apiBase must be an HTTPS origin");
  }
  if (
    /[\s\\?#]/.test(options.apiBase ?? "") ||
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    base.pathname !== "/"
  ) {
    throw new Error("createGateReporter: apiBase must be an HTTPS origin");
  }
  const endpoint = `${base.origin}/v1/merchants/${encodeURIComponent(options.merchantId)}/gate-events`;
  // Keep secrets in the closure, never in reporter.stats or diagnostic errors.
  const secret = options.merchantSecret;
  let queue: Pending[] = [];
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<void> | undefined;
  let flushing: Promise<GateReporterStats> | undefined;
  let closing: Promise<GateReporterStats> | undefined;
  let stopped = false;
  let closed = false;
  let delivered = 0;
  let dropped = 0;
  let retries = 0;
  let lastError: GateReporterError | null = null;
  const stats = (): GateReporterStats => ({
    queued: queue.length,
    delivered,
    dropped,
    retries,
    lastError,
    stopped,
    closed,
  });
  const clearTimer = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const expire = () => {
    if (active) return;
    const now = Date.now();
    const remaining = queue.filter((entry) => now - entry.created < MAX_AGE);
    if (remaining.length !== queue.length) {
      dropped += queue.length - remaining.length;
      lastError = "expired";
      queue = remaining;
    }
  };
  const schedule = () => {
    clearTimer();
    if (stopped || closed || active || flushing || !queue.length) return;
    const next = Math.min(...queue.map((entry) => entry.nextAt));
    timer = setTimeout(
      () => {
        timer = undefined;
        void sendOnce()
          .catch(() => {
            // All transport errors are handled below. Unexpected errors are still
            // isolated from the gate and never become unhandled rejections.
            lastError = "network";
          })
          .finally(schedule);
      },
      Math.max(0, next - Date.now())
    );
    timer.unref?.();
  };

  const sendOnce = async (ids?: Set<string>): Promise<void> => {
    if (active) await active;
    expire();
    if (stopped) return;
    const batch = queue
      .filter((entry) => (ids ? ids.has(entry.event.id) : entry.nextAt <= Date.now()))
      .slice(0, MAX_BATCH);
    if (!batch.length) return;
    for (const entry of batch) entry.attempts++;
    active = (async () => {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), TIMEOUT);
      let failure: GateReporterError | null = null;
      let permanent = false;
      try {
        const response = await fetch(endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json", "AIFP-Merchant-Secret": secret },
          body: JSON.stringify({ events: batch.map((entry) => entry.event) }),
          signal: controller.signal,
          redirect: "manual",
        });
        if (response.status >= 300 && response.status < 400) {
          failure = "redirect";
          permanent = true;
        } else if (response.status === 401 || response.status === 403) {
          failure = "auth";
          permanent = true;
        } else if (response.status >= 400 && response.status < 500 && ![408, 429].includes(response.status)) {
          failure = "rejected";
          permanent = true;
        } else if (!response.ok) {
          failure = "server";
        } else {
          try {
            const reader = response.body?.getReader();
            if (!reader) throw new Error();
            const chunks: Uint8Array[] = [];
            let size = 0;
            try {
              while (true) {
                const { done, value } = await reader.read();
                if (done) break;
                size += value.byteLength;
                if (size > 4096) {
                  await reader.cancel();
                  throw new Error();
                }
                chunks.push(value);
              }
            } finally {
              reader.releaseLock();
            }
            const bytes = new Uint8Array(size);
            let offset = 0;
            for (const chunk of chunks) {
              bytes.set(chunk, offset);
              offset += chunk.byteLength;
            }
            const body = JSON.parse(new TextDecoder().decode(bytes));
            if (
              !Number.isInteger(body?.accepted) ||
              !Number.isInteger(body?.duplicates) ||
              body.accepted < 0 ||
              body.duplicates < 0 ||
              body.accepted + body.duplicates !== batch.length
            )
              failure = "invalid_response";
          } catch {
            failure = controller.signal.aborted ? "timeout" : "invalid_response";
          }
        }
        // Never store/log a server response body or headers. Non-JSON error
        // bodies are cancelled rather than consumed into diagnostics.
        if (failure) await response.body?.cancel().catch(() => {});
      } catch {
        failure = controller.signal.aborted ? "timeout" : "network";
      } finally {
        clearTimeout(timeout);
      }
      if (failure && permanent) {
        stopped = true;
        lastError = failure;
        dropped += queue.length;
        queue = [];
        clearTimer();
        return;
      }
      const batchIds = new Set(batch.map((entry) => entry.event.id));
      if (!failure) {
        delivered += batch.length;
        queue = queue.filter((entry) => !batchIds.has(entry.event.id));
        lastError = null;
      } else {
        lastError = failure;
        for (const entry of batch) {
          if (entry.attempts >= MAX_ATTEMPTS || Date.now() - entry.created >= MAX_AGE) {
            queue = queue.filter((queued) => queued !== entry);
            dropped++;
          } else {
            retries++;
            entry.nextAt = Date.now() + Math.min(30_000, DELAY * 2 ** entry.attempts);
          }
        }
        if (batch.every((entry) => entry.attempts >= MAX_ATTEMPTS)) lastError = "retry_exhausted";
      }
    })();
    try {
      await active;
    } finally {
      active = undefined;
    }
  };

  const flush = (): Promise<GateReporterStats> => {
    if (flushing) return flushing;
    clearTimer();
    // Snapshot is taken before awaiting a background attempt. Events that it
    // delivered are simply absent when selecting the next batch.
    const ids = new Set(queue.map((entry) => entry.event.id));
    flushing = (async () => {
      if (active) await active;
      while (ids.size && !stopped) {
        const batch = queue.filter((entry) => ids.has(entry.event.id)).slice(0, MAX_BATCH);
        if (!batch.length) break;
        await sendOnce(new Set(batch.map((entry) => entry.event.id)));
        for (const entry of batch) ids.delete(entry.event.id);
      }
      return stats();
    })().finally(() => {
      flushing = undefined;
      schedule();
    });
    return flushing;
  };

  return {
    onEvent(event) {
      if (!event || typeof event !== "object") return;
      if (event.exempt || (event.kind !== "402" && event.kind !== "serve")) return;
      if (closed || stopped) {
        dropped++;
        if (!stopped) lastError = "closed";
        return;
      }
      if (!validResource(event.resource)) {
        dropped++;
        lastError = "invalid_event";
        return;
      }
      expire();
      if (queue.length >= MAX_QUEUE) {
        dropped++;
        lastError = "queue_full";
        return;
      }
      const now = Date.now();
      queue.push({
        event: { id: randomUUID(), kind: event.kind, resource: event.resource, at: new Date(now).toISOString() },
        created: now,
        attempts: 0,
        nextAt: now + DELAY,
      });
      schedule();
    },
    flush,
    close() {
      if (closing) return closing;
      closed = true;
      clearTimer();
      closing = flush().then(() => {
        if (queue.length) {
          dropped += queue.length;
          queue = [];
          if (!stopped) lastError = "shutdown";
        }
        clearTimer();
        return stats();
      });
      return closing;
    },
    get stats() {
      return stats();
    },
  };
}

export interface GateReporterV2Options extends GateReporterOptions {
  version: 2;
  /** Declare only stages actually wired by the integrator. */
  supported: readonly ServerObservation[];
}
export interface GateReporterV2Stats {
  producerId: string;
  pending: number;
  delivered: string;
  dropped: string;
  retries: string;
  lastError: HealthError;
  /** No acknowledged health sample means remote queue/drop coverage is unknown. */
  lastSample: HealthSample | null;
  stopped: boolean;
  closed: boolean;
}
export interface GateReporterV2 {
  readonly version: 2;
  /** Copies exact facts; returns false on malformed/conflicting/full input. */
  record(event: ReportedEvent): boolean;
  /** Generates one random fact ID/time; retries retain both. */
  observe(event: Omit<ReportedEvent, "id" | "at">): boolean;
  flush(): Promise<GateReporterV2Stats>;
  /** Explicit optional operation. Failure returns null, never a payment error. */
  mintFlow(request: FlowRequest): Promise<FlowResponse | null>;
  /** Frozen sample/sequence is retained until ack or bounded exhaustion. */
  health(): Promise<boolean>;
  close(): Promise<GateReporterV2Stats>;
  readonly stats: GateReporterV2Stats;
}

const UUID_V2 = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TOKEN_V2 = /^[A-Za-z0-9_-]{43}$/;
const STAGES_V2: ServerObservation[] = ["access_challenged", "access_admitted", "resource_response_completed"];
const REASONS_V2 = [
  "receipt_missing",
  "receipt_rejected",
  "quota_exhausted",
  "upstream_error",
  "client_abort",
  "unknown",
];
function exactV2(value: unknown, required: string[], optional: string[] = []): value is Record<string, unknown> {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key))
  );
}
function utcV2(value: unknown): value is string {
  return (
    typeof value === "string" &&
    /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(value) &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}
function resourceV2(value: unknown): value is string {
  return validResource(value) && !/[:{}]/.test(value);
}
/** Caller identity is supplied explicitly and stays unverified and site-scoped. */
export function validReportingContext(value: unknown): value is ReportingContext {
  if (!exactV2(value, ["channel", "consent"], ["client_id", "reporting_token"])) return false;
  return (
    ["browser", "api", "unknown"].includes(value.channel as Channel) &&
    ["granted", "denied", "unknown"].includes(value.consent as Consent) &&
    (!Object.hasOwn(value, "client_id") ||
      (value.consent === "granted" && typeof value.client_id === "string" && UUID_V2.test(value.client_id))) &&
    (!Object.hasOwn(value, "reporting_token") ||
      (typeof value.reporting_token === "string" && TOKEN_V2.test(value.reporting_token)))
  );
}
/** Syntax only: cryptographic scope, expiry and identity claims belong to server validation. */
export function validReportedEvent(value: unknown): value is ReportedEvent {
  if (
    !exactV2(
      value,
      ["id", "name", "resource", "at", "channel", "consent"],
      ["client_id", "reporting_token", "outcome", "status", "reason"]
    )
  )
    return false;
  const context = {
    channel: value.channel,
    consent: value.consent,
    ...(Object.hasOwn(value, "client_id") ? { client_id: value.client_id } : {}),
    ...(Object.hasOwn(value, "reporting_token") ? { reporting_token: value.reporting_token } : {}),
  };
  if (
    !validReportingContext(context) ||
    typeof value.id !== "string" ||
    !UUID_V2.test(value.id) ||
    !STAGES_V2.includes(value.name as ServerObservation) ||
    !resourceV2(value.resource) ||
    !utcV2(value.at) ||
    (Object.hasOwn(value, "reason") && !REASONS_V2.includes(value.reason as string))
  )
    return false;
  if (value.name !== "resource_response_completed")
    return !Object.hasOwn(value, "outcome") && !Object.hasOwn(value, "status");
  if (!["success", "redirect", "error", "abort"].includes(value.outcome as string)) return false;
  if (value.outcome === "abort" && !Object.hasOwn(value, "status")) return true;
  if (!Number.isInteger(value.status) || (value.status as number) < 100 || (value.status as number) > 599) return false;
  return (
    value.outcome === "abort" ||
    value.outcome ===
      ((value.status as number) >= 200 && (value.status as number) < 300
        ? "success"
        : (value.status as number) >= 300 && (value.status as number) < 400
          ? "redirect"
          : "error")
  );
}
function ackV2(value: unknown, count: number): value is Ack {
  return (
    exactV2(value, ["version", "accepted", "duplicates", "received_at"]) &&
    value.version === 2 &&
    utcV2(value.received_at) &&
    Number.isSafeInteger(value.accepted) &&
    Number.isSafeInteger(value.duplicates) &&
    (value.accepted as number) >= 0 &&
    (value.duplicates as number) >= 0 &&
    (value.accepted as number) + (value.duplicates as number) === count
  );
}
// Health has its own acknowledgment: one sample, so `duplicate` replaces the batch counts.
function healthAckV2(value: unknown): value is HealthAck {
  return exactV2(value, ["version", "duplicate"]) && value.version === 2 && typeof value.duplicate === "boolean";
}

/** Separate v2 opt-in. Does not call the legacy producer or any payment API. */
export function createGateReporterV2(options: GateReporterV2Options): GateReporterV2 {
  if (
    !exactV2(options, ["version", "merchantId", "merchantSecret", "supported"], ["apiBase"]) ||
    options.version !== 2 ||
    typeof options.merchantId !== "string" ||
    !/^mrch_[a-f0-9]{16}$/.test(options.merchantId) ||
    typeof options.merchantSecret !== "string" ||
    !options.merchantSecret ||
    /[^\x21-\x7e]/.test(options.merchantSecret) ||
    !Array.isArray(options.supported) ||
    !options.supported.length ||
    new Set(options.supported).size !== options.supported.length ||
    options.supported.some((stage) => !STAGES_V2.includes(stage))
  )
    throw new Error("createGateReporterV2: invalid options");
  let base: URL;
  try {
    base = new URL(options.apiBase ?? "https://api.aifinpay.io");
  } catch {
    throw new Error("createGateReporterV2: HTTPS origin required");
  }
  if (
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/" ||
    base.search ||
    base.hash ||
    /[\s\\?#]/.test(options.apiBase ?? "")
  )
    throw new Error("createGateReporterV2: HTTPS origin required");
  const prefix = `${base.origin}/v2/merchants/${options.merchantId}`;
  const secret = options.merchantSecret;
  const supported = [...options.supported];
  const producerId = randomUUID();
  type Entry = { event: ReportedEvent; facts: string; created: number; attempts: number; nextAt: number };
  let queue: Entry[] = [];
  let delivered = 0n,
    dropped = 0n,
    retries = 0n,
    sequence = 0n;
  let lastError: HealthError = "none";
  let stopped = false,
    closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let active: Promise<GateReporterV2Stats> | undefined;
  let closing: Promise<GateReporterV2Stats> | undefined;
  let healthActive: Promise<boolean> | undefined;
  let flowActive: { facts: string; promise: Promise<FlowResponse | null> } | undefined;
  let sample: { value: HealthSample; created: number; attempts: number; nextAt: number } | undefined;
  let lastSample: HealthSample | null = null;
  let lastHealthAt = -Infinity;
  const HEALTH_INTERVAL = 5000;
  const counter = (value: bigint) => (value > 99999999999999999999n ? 99999999999999999999n : value).toString();
  const stats = (): GateReporterV2Stats => ({
    producerId,
    pending: queue.length,
    delivered: counter(delivered),
    dropped: counter(dropped),
    retries: counter(retries),
    lastError,
    lastSample: lastSample ? { ...lastSample, supported: [...lastSample.supported] } : null,
    stopped,
    closed,
  });
  const clear = () => {
    if (timer) clearTimeout(timer);
    timer = undefined;
  };
  const backoff = (attempts: number) => Math.round(DELAY * 2 ** (attempts - 1) * (0.9 + Math.random() * 0.2)); //1/2/4/8s ±10%
  const expire = () => {
    const keep = queue.filter((entry) => Date.now() - entry.created < MAX_AGE);
    if (keep.length !== queue.length) {
      dropped += BigInt(queue.length - keep.length);
      lastError = "retry_exhausted";
      queue = keep;
    }
  };
  type Transport = { body?: unknown; error: HealthError; permanent: boolean };
  const post = async (path: string, body: string): Promise<Transport> => {
    const controller = new AbortController();
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    const deadline = new Promise<Transport>((resolve) => {
      timeout = setTimeout(() => {
        controller.abort();
        void reader?.cancel().catch(() => {});
        resolve({ error: "timeout", permanent: false });
      }, TIMEOUT);
    });
    const operation = async (): Promise<Transport> => {
      try {
        const url = `${prefix}${path}`;
        const response = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json", "AIFP-Merchant-Secret": secret },
          body,
          redirect: "manual",
          signal: controller.signal,
        });
        if (controller.signal.aborted) {
          void response.body?.cancel().catch(() => {});
          return { error: "timeout", permanent: false };
        }
        if (!response.ok || response.redirected || (response.url && response.url !== url)) {
          void response.body?.cancel().catch(() => {});
          const auth = response.status === 401 || response.status === 403;
          return {
            error: auth ? "auth" : response.status >= 500 ? "storage" : "rejected",
            permanent:
              auth || (response.status >= 300 && response.status < 500 && ![408, 429].includes(response.status)),
          };
        }
        reader = response.body?.getReader();
        if (!reader) return { error: "rejected", permanent: false };
        const chunks: Uint8Array[] = [];
        let size = 0;
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          size += chunk.value.byteLength;
          if (size > 8192 || controller.signal.aborted) {
            void reader.cancel().catch(() => {});
            return { error: controller.signal.aborted ? "timeout" : "rejected", permanent: false };
          }
          chunks.push(chunk.value);
        }
        const bytes = new Uint8Array(size);
        let offset = 0;
        for (const chunk of chunks) {
          bytes.set(chunk, offset);
          offset += chunk.byteLength;
        }
        return { body: JSON.parse(new TextDecoder().decode(bytes)), error: "none", permanent: false };
      } catch {
        return { error: controller.signal.aborted ? "timeout" : "network", permanent: false };
      } finally {
        reader?.releaseLock();
      }
    };
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timeout);
    }
  };
  const stopAuth = () => {
    stopped = true;
    // An active batch may already be committed remotely. Reconcile its ack
    // before abandoning the rest, rather than counting delivered facts as lost.
    if (!active) {
      dropped += BigInt(queue.length);
      queue = [];
    }
    clear();
    clearInterval(healthTimer);
  };
  const schedule = () => {
    clear();
    if (closed || stopped || active || !queue.length) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void flush();
      },
      Math.max(0, Math.min(...queue.map((entry) => entry.nextAt)) - Date.now())
    );
    timer.unref?.();
  };
  const flush = (): Promise<GateReporterV2Stats> => {
    if (active) return active;
    clear();
    active = (async () => {
      expire();
      const due = queue.filter((entry) => entry.attempts === 0 || entry.nextAt <= Date.now());
      while (due.length && !stopped) {
        const batch: Entry[] = [];
        let size = Buffer.byteLength('{"version":2,"events":[]}');
        while (
          due.length &&
          batch.length < MAX_BATCH &&
          size + Buffer.byteLength(due[0].facts) + (batch.length ? 1 : 0) <= 65536
        ) {
          const entry = due.shift()!;
          batch.push(entry);
          size += Buffer.byteLength(entry.facts) + (batch.length > 1 ? 1 : 0);
        }
        if (!batch.length) break;
        for (const entry of batch) entry.attempts++;
        const result = await post(
          "/gate-events",
          `{"version":2,"events":[${batch.map((entry) => entry.facts).join(",")}]}`
        );
        if (result.error === "none" && !ackV2(result.body, batch.length)) result.error = "rejected";
        if (!stopped || result.error === "auth") lastError = result.error;
        if (result.error === "auth") {
          stopAuth();
          break;
        }
        for (const entry of batch) {
          if (
            result.error === "none" ||
            result.permanent ||
            stopped ||
            entry.attempts >= MAX_ATTEMPTS ||
            Date.now() - entry.created >= MAX_AGE
          ) {
            queue = queue.filter((queued) => queued !== entry);
            if (result.error === "none") delivered++;
            else dropped++;
          } else {
            retries++;
            entry.nextAt = Date.now() + backoff(entry.attempts);
          }
        }
        if (!stopped && result.error !== "none" && batch.every((entry) => entry.attempts >= MAX_ATTEMPTS))
          lastError = "retry_exhausted";
        // Entries waiting behind a slow attempt still obey the15minute bound.
        const expiredDue = due.filter((entry) => Date.now() - entry.created >= MAX_AGE);
        for (const entry of expiredDue) {
          queue = queue.filter((queued) => queued !== entry);
          due.splice(due.indexOf(entry), 1);
          dropped++;
          lastError = "retry_exhausted";
        }
      }
      if (stopped) {
        dropped += BigInt(queue.length);
        queue = [];
      }
      return stats();
    })().finally(() => {
      active = undefined;
      schedule();
    });
    return active;
  };
  const record = (input: ReportedEvent): boolean => {
    try {
      if (!validReportedEvent(input) || !supported.includes(input.name)) {
        dropped++;
        lastError = "rejected";
        return false;
      }
      // Fixed key order and copied primitives prevent mutable callers changing retries.
      const event: ReportedEvent = {
        id: input.id,
        name: input.name,
        resource: input.resource,
        at: input.at,
        channel: input.channel,
        consent: input.consent,
        ...(input.client_id !== undefined ? { client_id: input.client_id } : {}),
        ...(input.reporting_token !== undefined ? { reporting_token: input.reporting_token } : {}),
        ...(input.outcome !== undefined ? { outcome: input.outcome } : {}),
        ...(input.status !== undefined ? { status: input.status } : {}),
        ...(input.reason !== undefined ? { reason: input.reason } : {}),
      };
      const facts = JSON.stringify(event);
      const existing = queue.find((entry) => entry.event.id === event.id);
      if (existing) {
        if (existing.facts === facts) return true;
        dropped++;
        lastError = "rejected";
        return false;
      }
      // Known pending facts retry before timestamp/credential freshness checks.
      if (
        closed ||
        stopped ||
        Date.parse(event.at) < Date.now() - 86400000 ||
        Date.parse(event.at) > Date.now() + 300000
      ) {
        dropped++;
        lastError = "rejected";
        return false;
      }
      if (!active) expire();
      if (queue.length >= MAX_QUEUE) {
        dropped++;
        lastError = "queue_full";
        return false;
      }
      queue.push({ event, facts, created: Date.now(), attempts: 0, nextAt: Date.now() + DELAY });
      schedule();
      return true;
    } catch {
      dropped++;
      lastError = "rejected";
      return false;
    }
  };
  const health = (): Promise<boolean> => {
    if (healthActive) return healthActive;
    if (closed || stopped) return Promise.resolve(false);
    if (sample && (sample.attempts >= MAX_ATTEMPTS || Date.now() - sample.created >= MAX_AGE)) {
      sample = undefined;
      lastError = "retry_exhausted";
    }
    // The collector attempt cap includes retries, not just new samples.
    if (Date.now() - lastHealthAt < HEALTH_INTERVAL || (sample && sample.nextAt > Date.now()))
      return Promise.resolve(false);
    if (!sample) {
      sequence++;
      sample = {
        value: {
          version: 2,
          producer_id: producerId,
          sequence: counter(sequence),
          at: new Date().toISOString(),
          supported: [...supported],
          pending: queue.length,
          dropped: counter(dropped),
          retries: counter(retries),
          last_error: lastError,
        },
        created: Date.now(),
        attempts: 0,
        nextAt: Date.now(),
      };
    }
    const pending = sample;
    pending.attempts++;
    lastHealthAt = Date.now();
    healthActive = (async () => {
      const result = await post("/reporting/health", JSON.stringify(pending.value));
      if (result.error === "none" && healthAckV2(result.body)) {
        lastSample = pending.value;
        sample = undefined;
        return true;
      }
      lastError = result.error === "none" ? "rejected" : result.error;
      if (result.error === "auth") stopAuth();
      if (result.permanent || pending.attempts >= MAX_ATTEMPTS) {
        sample = undefined;
        if (!result.permanent) lastError = "retry_exhausted";
      } else {
        retries++;
        pending.nextAt = Date.now() + Math.max(HEALTH_INTERVAL, backoff(pending.attempts));
      }
      return false;
    })().finally(() => {
      healthActive = undefined;
    });
    return healthActive;
  };
  const healthTimer = setInterval(() => {
    void health();
  }, 60000);
  healthTimer.unref?.();
  return {
    version: 2,
    record,
    observe(input) {
      try {
        if (
          !exactV2(
            input,
            ["name", "resource", "channel", "consent"],
            ["client_id", "reporting_token", "outcome", "status", "reason"]
          )
        ) {
          dropped++;
          lastError = "rejected";
          return false;
        }
        return record({ ...input, id: randomUUID(), at: new Date().toISOString() });
      } catch {
        dropped++;
        lastError = "rejected";
        return false;
      }
    },
    flush,
    health,
    mintFlow(input) {
      try {
        if (
          closed ||
          stopped ||
          !exactV2(input, ["version", "request_id", "resource", "channel", "consent"], ["client_id"]) ||
          input.version !== 2 ||
          typeof input.request_id !== "string" ||
          !UUID_V2.test(input.request_id) ||
          !resourceV2(input.resource) ||
          !validReportingContext({
            channel: input.channel,
            consent: input.consent,
            ...(Object.hasOwn(input, "client_id") ? { client_id: input.client_id } : {}),
          })
        ) {
          lastError = "rejected";
          return Promise.resolve(null);
        }
        const facts = JSON.stringify({
          version: 2,
          request_id: input.request_id,
          resource: input.resource,
          channel: input.channel,
          consent: input.consent,
          ...(input.client_id !== undefined ? { client_id: input.client_id } : {}),
        });
        const resource = input.resource;
        if (flowActive) {
          if (flowActive.facts === facts) return flowActive.promise;
          lastError = "queue_full";
          return Promise.resolve(null);
        }
        const promise = (async () => {
          for (let attempts = 1; attempts <= MAX_ATTEMPTS && !closed && !stopped; attempts++) {
            const result = await post("/reporting/flows", facts);
            const response = result.body;
            if (
              result.error === "none" &&
              exactV2(response, ["version", "flow_id", "reporting_token", "expires_at", "mode", "resource"]) &&
              response.version === 2 &&
              typeof response.flow_id === "string" &&
              UUID_V2.test(response.flow_id) &&
              typeof response.reporting_token === "string" &&
              TOKEN_V2.test(response.reporting_token) &&
              utcV2(response.expires_at) &&
              Date.parse(response.expires_at) > Date.now() &&
              ["live", "test", "internal"].includes(response.mode as string) &&
              response.resource === resource
            )
              return response as FlowResponse;
            lastError = result.error === "none" ? "rejected" : result.error;
            if (result.error === "auth") stopAuth();
            if (result.permanent) return null;
            if (attempts < MAX_ATTEMPTS) {
              retries++;
              await new Promise<void>((resolve) => setTimeout(resolve, backoff(attempts)));
            }
          }
          if (!closed && !stopped) lastError = "retry_exhausted";
          return null;
        })().finally(() => {
          flowActive = undefined;
        });
        flowActive = { facts, promise };
        return promise;
      } catch {
        lastError = "rejected";
        return Promise.resolve(null);
      }
    },
    close() {
      if (closing) return closing;
      closed = true;
      clear();
      clearInterval(healthTimer);
      closing = (async () => {
        await flush();
        await Promise.all([healthActive, flowActive?.promise]);
        // A concurrent enqueue is impossible after closed; all remaining retries are abandoned.
        dropped += BigInt(queue.length);
        queue = [];
        sample = undefined;
        clear();
        return stats();
      })();
      return closing;
    },
    get stats() {
      return stats();
    },
  };
}
