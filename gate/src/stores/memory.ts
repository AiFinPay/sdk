import { StoreCapacityError } from "../errors.js";
import type { GateStore } from "./types.js";

export interface MemoryStoreOptions {
  /** Hard ceiling on tracked counters. A hostile stream of forged receipt_ids
   *  would otherwise grow this map until the partner's process dies — and the
   *  forged tokens never even have to verify to reach a naive implementation. */
  maxKeys?: number;
  sweepMs?: number;
  /** Set by createGate when it had to invent a store, so the warning below
   *  fires for people who did not choose this, and stays quiet for people who
   *  did. */
  warnIfDefaulted?: boolean;
}

interface Entry {
  v: number;
  expiresAt: number;
}

/**
 * In-process quota counters. Correct on one process, and only on one process.
 *
 * WHY IT IS ATOMIC ANYWAY: `incrBy` reads, adds and writes with no `await`
 * between the read and the write. On a single event loop that whole body runs
 * to completion before any other request resumes, so two concurrent calls are
 * serialized by the runtime and receive distinct post-increment values. This
 * is not luck; it is the reason the method is written as one synchronous block
 * inside an async signature, and why an `await` must never be added into it.
 *
 * WHAT IT CANNOT DO: `pm2 -i 4`, node:cluster, or two pods behind a load
 * balancer give you four independent counters, and a 200-unit batch will serve
 * up to 800 calls. Nothing in the request path can detect that. Use a shared
 * store the moment you run more than one process.
 */
export class MemoryStore implements GateStore {
  readonly durable = false as const;
  readonly sharedAcrossProcesses = false as const;

  private readonly map = new Map<string, Entry>();
  private readonly maxKeys: number;
  private readonly timer: ReturnType<typeof setInterval>;

  constructor(opts: MemoryStoreOptions = {}) {
    this.maxKeys = opts.maxKeys ?? 100_000;
    this.timer = setInterval(() => this.sweep(), opts.sweepMs ?? 60_000);
    // Never hold the event loop open for a cache — a partner's CLI or test
    // process must be able to exit.
    this.timer.unref?.();

    if (opts.warnIfDefaulted && process.env.NODE_ENV === "production") {
      // Exactly one line, at construction, not per request: a warning nobody
      // can find in a log flood is not a warning.
      console.warn(
        "[@aifinpay/gate] MemoryStore meters quota per process — under cluster/PM2/multiple pods " +
          "each worker gets a full copy of every batch. Pass a shared store (redisStore) in production.",
      );
    }
  }

  async incrBy(key: string, by: number, ttlMs: number): Promise<number> {
    // ── no await from here ──────────────────────────────────────────────
    const now = Date.now();
    const cur = this.map.get(key);
    if (cur && cur.expiresAt > now) {
      cur.v += by;
      return cur.v; // TTL untouched: it belongs to the receipt, not the traffic
    }
    if (this.map.size >= this.maxKeys && !this.makeRoom(now)) {
      throw new StoreCapacityError(this.maxKeys);
    }
    this.map.set(key, { v: by, expiresAt: now + ttlMs });
    return by;
    // ── to here ─────────────────────────────────────────────────────────
  }

  async decrBy(key: string, by: number): Promise<number> {
    const e = this.map.get(key);
    if (!e || e.expiresAt <= Date.now()) return 0;
    e.v -= by;
    return e.v;
  }

  async get(key: string): Promise<number | null> {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expiresAt <= Date.now()) {
      this.map.delete(key);
      return null;
    }
    return e.v;
  }

  async close(): Promise<void> {
    clearInterval(this.timer);
    this.map.clear();
    return;
  }

  private sweep(now: number = Date.now()): void {
    for (const [k, e] of this.map) if (e.expiresAt <= now) this.map.delete(k);
  }

  /**
   * Drop expired entries. Returns whether that freed anything.
   *
   * It deliberately stops there. An earlier version, having found nothing
   * expired, deleted the 10% of counters closest to expiry — and deleting a
   * live counter is not an eviction, it is a refund nobody asked for. The
   * counter IS the record of how much of a prepaid batch has been spent; drop
   * it and `incrBy` starts again from zero, so a 200-unit batch that was
   * exhausted becomes 200 fresh units. That is RULE 2 in ./types.ts read
   * backwards: the counter must never die before the receipt.
   *
   * Worse, it was reachable on purpose. Keys are derived from receipt ids, so
   * anyone able to present distinct receipts can push the map to `maxKeys` and
   * choose the moment their own exhausted batch gets forgotten.
   *
   * At capacity with everything live there is no answer this class can compute,
   * so it stops computing one: `incrBy` throws, `onStoreError` decides, and the
   * failure is visible in the merchant's logs instead of in their revenue.
   */
  private makeRoom(now: number): boolean {
    const before = this.map.size;
    this.sweep(now);
    return this.map.size < before;
  }
}
