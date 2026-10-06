import { randomUUID } from "node:crypto";
import type { GateEvent } from "./types.js";

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
