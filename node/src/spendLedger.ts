// Making a daily spending cap mean something.
//
// The cap was a number compared against a ring buffer in one object's memory.
// Two consequences, both of which defeat it entirely.
//
// A new process starts at zero. An agent that restarts — a crash loop, a
// deploy, a cron that runs it hourly — gets its full daily allowance again each
// time, and the "daily" cap becomes a per-process cap.
//
// And the check was separate from the record: `checkBudget()` read the total,
// the payment happened, and only then was the cost added. Two calls in flight
// at once both read the same total, both passed, and both paid. The cap held
// only for an agent making one call at a time, which is not the kind of agent
// this SDK is for.
//
// So a cap now goes through reserve → commit or release, where the reservation
// is what the next check sees. A reservation that is never resolved — the
// process died mid-payment — expires, because the alternative is an agent that
// loses its budget to a crash and cannot spend again until tomorrow.
//
// Durability is engaged only when a daily cap is actually set. A library that
// writes to a user's disk because it was imported would be rude; one that
// promises a daily limit and forgets it on restart is worse.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** An outstanding or settled amount. */
interface Entry {
  id: string;
  usd: number;
  at: number;
  /** Set while the payment is in flight; cleared when it settles. */
  expiresAt?: number;
}

export interface SpendLedger {
  /**
   * Claim `usd` of the cap, atomically, or refuse.
   *
   * The cap is checked here rather than by the caller because a caller that
   * checks and then reserves has reintroduced the race this exists to close.
   * Returns a reservation id, or null when the window total would exceed `cap`.
   */
  reserve(usd: number, cap: number, windowMs: number): Promise<string | null>;
  /** The payment happened. `actualUsd` corrects the estimate when known. */
  commit(id: string, actualUsd?: number): Promise<void>;
  /** The payment did not happen. Give the budget back now, not at expiry. */
  release(id: string): Promise<void>;
  /** Settled plus outstanding, over the window. */
  total(windowMs: number): Promise<number>;
}

/** How long a reservation survives without being committed or released. */
const RESERVATION_TTL_MS = 5 * 60_000;

function liveTotal(entries: Entry[], windowMs: number, now: number): number {
  const cutoff = now - windowMs;
  return entries
    .filter((e) => e.at >= cutoff && (!e.expiresAt || e.expiresAt > now))
    .reduce((s, e) => s + e.usd, 0);
}

function prune(entries: Entry[], windowMs: number, now: number): Entry[] {
  const cutoff = now - windowMs;
  // Drop what has aged out of the window, and reservations nobody resolved.
  return entries.filter((e) => e.at >= cutoff && (!e.expiresAt || e.expiresAt > now));
}

/**
 * In-process ledger. Correct for one process, forgotten on restart.
 *
 * Kept because it is the right answer when no daily cap is set — there is
 * nothing to remember — and because a test should not need a filesystem.
 */
export class MemorySpendLedger implements SpendLedger {
  private entries: Entry[] = [];

  async reserve(usd: number, cap: number, windowMs: number): Promise<string | null> {
    const now = Date.now();
    this.entries = prune(this.entries, windowMs, now);
    if (liveTotal(this.entries, windowMs, now) + usd > cap) return null;
    const id = randomUUID();
    this.entries.push({ id, usd, at: now, expiresAt: now + RESERVATION_TTL_MS });
    return id;
  }

  async commit(id: string, actualUsd?: number): Promise<void> {
    const e = this.entries.find((x) => x.id === id);
    if (!e) return;
    if (typeof actualUsd === "number" && Number.isFinite(actualUsd)) e.usd = actualUsd;
    delete e.expiresAt;
  }

  async release(id: string): Promise<void> {
    this.entries = this.entries.filter((x) => x.id !== id);
  }

  async total(windowMs: number): Promise<number> {
    return liveTotal(this.entries, windowMs, Date.now());
  }
}

/**
 * A ledger on disk, so a restart does not hand the agent its allowance again.
 *
 * Read-modify-write is guarded by an exclusive lock file, which is atomic on a
 * local filesystem: `open(..., "wx")` either creates the file or fails, with no
 * window in between. That covers several processes on one host, which is what
 * a restart, a cron and a worker pool actually are.
 *
 * It does NOT cover several hosts — a lock file on a network filesystem is not
 * a lock. An agent fleet spanning machines should pass its own SpendLedger
 * backed by something that can answer for all of them; that is why this is an
 * interface rather than a class the SDK insists on.
 */
export class FileSpendLedger implements SpendLedger {
  constructor(private readonly path: string) {}

  /** Default location, one file per agent address. */
  static forAgent(address: string): FileSpendLedger {
    const base = process.env.AIFINPAY_STATE_DIR || join(homedir(), ".aifinpay");
    return new FileSpendLedger(join(base, "spend", `${address.toLowerCase()}.json`));
  }

  private async withLock<T>(fn: (entries: Entry[]) => { entries: Entry[]; result: T }): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;

    // Spin briefly rather than failing: contention here is two of our own
    // calls, and they are milliseconds apart.
    let handle;
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        handle = await open(lockPath, "wx");
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() > deadline) {
          // A lock this old belongs to a process that died holding it. Breaking
          // it risks a lost update; refusing to ever break it means one crash
          // disables the cap permanently, which is worse.
          await unlink(lockPath).catch(() => {});
          continue;
        }
        await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 15)));
      }
    }

    try {
      let entries: Entry[] = [];
      try {
        entries = JSON.parse(await readFile(this.path, "utf8")) as Entry[];
        if (!Array.isArray(entries)) entries = [];
      } catch {
        // Absent or unreadable. Starting from empty is the only option, and it
        // errs toward letting a payment through rather than blocking one — the
        // same direction the old in-memory behaviour erred, every restart.
        entries = [];
      }
      const { entries: next, result } = fn(entries);
      // Write to a sibling and rename: a crash mid-write leaves the previous
      // ledger intact rather than a truncated one.
      const tmp = `${this.path}.${process.pid}.tmp`;
      await writeFile(tmp, JSON.stringify(next), "utf8");
      await rename(tmp, this.path);
      return result;
    } finally {
      await handle.close().catch(() => {});
      await unlink(lockPath).catch(() => {});
    }
  }

  async reserve(usd: number, cap: number, windowMs: number): Promise<string | null> {
    return this.withLock((entries) => {
      const now = Date.now();
      const live = prune(entries, windowMs, now);
      if (liveTotal(live, windowMs, now) + usd > cap) {
        return { entries: live, result: null };
      }
      const id = randomUUID();
      live.push({ id, usd, at: now, expiresAt: now + RESERVATION_TTL_MS });
      return { entries: live, result: id };
    });
  }

  async commit(id: string, actualUsd?: number): Promise<void> {
    await this.withLock((entries) => {
      for (const e of entries) {
        if (e.id === id) {
          if (typeof actualUsd === "number" && Number.isFinite(actualUsd)) e.usd = actualUsd;
          delete e.expiresAt;
        }
      }
      return { entries, result: undefined };
    });
  }

  async release(id: string): Promise<void> {
    await this.withLock((entries) => ({
      entries: entries.filter((e) => e.id !== id),
      result: undefined,
    }));
  }

  async total(windowMs: number): Promise<number> {
    return this.withLock((entries) => {
      const now = Date.now();
      const live = prune(entries, windowMs, now);
      return { entries: live, result: liveTotal(live, windowMs, now) };
    });
  }
}
