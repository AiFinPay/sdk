// Making a daily spending cap mean something.
//
// The cap was a number compared against a ring buffer in one object's memory.
// A new process started at zero, and concurrent calls could both pass before
// either recorded spend. Reserve → commit/release closes both failure modes.

import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile, rename, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

interface Entry {
  id: string;
  usd: number;
  at: number;
  expiresAt?: number;
}

export interface SpendLedger {
  reserve(usd: number, cap: number, windowMs: number): Promise<string | null>;
  commit(id: string, actualUsd?: number): Promise<void>;
  release(id: string): Promise<void>;
  total(windowMs: number): Promise<number>;
}

const RESERVATION_TTL_MS = 5 * 60_000;

function liveTotal(entries: Entry[], windowMs: number, now: number): number {
  const cutoff = now - windowMs;
  return entries
    .filter((e) => e.at >= cutoff && (!e.expiresAt || e.expiresAt > now))
    .reduce((s, e) => s + e.usd, 0);
}

function prune(entries: Entry[], windowMs: number, now: number): Entry[] {
  const cutoff = now - windowMs;
  return entries.filter((e) => e.at >= cutoff && (!e.expiresAt || e.expiresAt > now));
}

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

export class FileSpendLedger implements SpendLedger {
  constructor(private readonly path: string) {}

  static forAgent(address: string): FileSpendLedger {
    const base = process.env.AIFINPAY_STATE_DIR || join(homedir(), ".aifinpay");
    return new FileSpendLedger(join(base, "spend", `${address.toLowerCase()}.json`));
  }

  private async withLock<T>(fn: (entries: Entry[]) => { entries: Entry[]; result: T }): Promise<T> {
    await mkdir(dirname(this.path), { recursive: true });
    const lockPath = `${this.path}.lock`;

    let handle;
    const deadline = Date.now() + 5_000;
    for (;;) {
      try {
        handle = await open(lockPath, "wx");
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() > deadline) {
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
        entries = [];
      }
      const { entries: next, result } = fn(entries);
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
      if (liveTotal(live, windowMs, now) + usd > cap) return { entries: live, result: null };
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
    await this.withLock((entries) => ({ entries: entries.filter((e) => e.id !== id), result: undefined }));
  }

  async total(windowMs: number): Promise<number> {
    return this.withLock((entries) => {
      const now = Date.now();
      const live = prune(entries, windowMs, now);
      return { entries: live, result: liveTotal(live, windowMs, now) };
    });
  }
}
