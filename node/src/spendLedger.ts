// Daily caps use reserve → confirmed commit or proven nonpayment release.
// Unknown outcomes never expire: a process restart is not evidence of no payment.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

/** Exact trusted purchase context; a quote cannot select the ledger or cap. */
export interface SpendLedgerBinding {
  apiBaseUrl: string;
  paymentIssuer: string;
  payer: string;
  merchantId: string;
  scope: string;
  resource: string;
  networkMode: string;
  chain: string;
  asset: string;
  token: string;
  grossAmount: string;
  quoteId: string;
}
interface Entry {
  id: string;
  usd: number;
  at: number;
  /** Legacy field retained as an unresolved marker; it no longer expires. */
  expiresAt?: number;
  binding?: SpendLedgerBinding;
  txRef?: string;
  receiptPending?: boolean;
}
export interface SpendLedger {
  reserve(usd: number, cap: number, windowMs: number, binding?: SpendLedgerBinding): Promise<string | null>;
  commit(id: string, actualUsd?: number): Promise<void>;
  /** Caller must prove settlement never broadcast or reverted. */
  release(id: string): Promise<void>;
  total(windowMs: number): Promise<number>;
  /** Required by capped v1.4 callers; old custom adapters fail before broadcast. */
  prepare?(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void>;
  assertRecovery?(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void>;
  complete?(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void>;
}
const RESERVATION_MARKER_MS = 5 * 60_000;
const LOCK_TIMEOUT_MS = 5_000;
const BINDING_FIELDS = [
  "apiBaseUrl",
  "paymentIssuer",
  "payer",
  "merchantId",
  "scope",
  "resource",
  "networkMode",
  "chain",
  "asset",
  "token",
  "grossAmount",
  "quoteId",
] as const;
function validBinding(binding: unknown): binding is SpendLedgerBinding {
  return (
    !!binding &&
    typeof binding === "object" &&
    Object.keys(binding).length === BINDING_FIELDS.length &&
    BINDING_FIELDS.every(
      (k) => typeof (binding as SpendLedgerBinding)[k] === "string" && !!(binding as SpendLedgerBinding)[k]
    )
  );
}
function sameBinding(left: SpendLedgerBinding | undefined, right: SpendLedgerBinding): boolean {
  return !!left && BINDING_FIELDS.every((k) => left[k] === right[k]);
}
function purchaseKey(binding: SpendLedgerBinding): string {
  // Exact chain/token binding is retained, but changing rail cannot rebuy unresolved access.
  return createHash("sha256")
    .update(
      JSON.stringify([
        binding.apiBaseUrl,
        binding.paymentIssuer,
        binding.payer,
        binding.merchantId,
        binding.scope,
        binding.resource,
        binding.networkMode,
      ])
    )
    .digest("hex");
}
function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function validateCost(usd: number, cap: number, windowMs: number, binding?: SpendLedgerBinding): void {
  if (
    !finiteNonnegative(usd) ||
    !(Number.isFinite(cap) && cap > 0) ||
    !(Number.isFinite(windowMs) && windowMs > 0) ||
    (binding !== undefined && !validBinding(binding))
  )
    throw new Error("Invalid spending reservation parameters");
}
function prune(entries: Entry[], windowMs: number, now: number): Entry[] {
  // Retain confirmed-but-unreceipted purchases too; never silently remove their guard.
  return entries.filter(
    (e) => e.binding !== undefined || e.expiresAt !== undefined || e.receiptPending === true || e.at >= now - windowMs
  );
}
function liveTotal(entries: Entry[], windowMs: number, now: number): number {
  return entries.filter((e) => e.expiresAt !== undefined || e.at >= now - windowMs).reduce((sum, e) => sum + e.usd, 0);
}
function reserveEntry(entries: Entry[], usd: number, cap: number, windowMs: number, binding?: SpendLedgerBinding) {
  validateCost(usd, cap, windowMs, binding);
  const now = Date.now(),
    live = prune(entries, windowMs, now);
  if (
    binding &&
    live.some(
      (e) =>
        e.binding &&
        (e.expiresAt !== undefined || e.receiptPending === true) &&
        purchaseKey(e.binding) === purchaseKey(binding)
    )
  )
    throw new Error("Unresolved purchase; recover its existing payment before buying again");
  if (liveTotal(live, windowMs, now) + usd > cap) return { entries: live, result: null };
  const id = randomUUID();
  live.push({
    id,
    usd,
    at: now,
    expiresAt: now + RESERVATION_MARKER_MS,
    ...(binding ? { binding: { ...binding } } : {}),
  });
  return { entries: live, result: id };
}
function commitEntry(entries: Entry[], id: string, actualUsd?: number): void {
  if (actualUsd !== undefined && !finiteNonnegative(actualUsd)) throw new Error("Invalid confirmed spending amount");
  const entry = entries.find((e) => e.id === id);
  if (!entry) throw new Error("Spending reservation is missing; reconciliation is required");
  if (actualUsd !== undefined) entry.usd = actualUsd;
  if (entry.expiresAt !== undefined) entry.at = Date.now();
  delete entry.expiresAt;
}
function boundEntry(entries: Entry[], id: string, txRef: string, binding: SpendLedgerBinding): Entry {
  const entry = entries.find((e) => e.id === id);
  if (!entry || !validBinding(binding) || !sameBinding(entry.binding, binding) || entry.txRef !== txRef)
    throw new Error("Recovery disagrees with the original spending reservation");
  return entry;
}
function prepareEntry(entries: Entry[], id: string, txRef: string, binding: SpendLedgerBinding): void {
  const entry = entries.find((e) => e.id === id);
  if (
    !entry ||
    entry.expiresAt === undefined ||
    !sameBinding(entry.binding, binding) ||
    !/^0x[0-9a-fA-F]{64}$/.test(txRef) ||
    (entry.txRef !== undefined && entry.txRef !== txRef)
  )
    throw new Error("Prepared transaction disagrees with the spending reservation");
  entry.txRef = txRef;
  entry.receiptPending = true;
}
function releaseEntries(entries: Entry[], id: string): Entry[] {
  if (entries.some((e) => e.id === id && e.expiresAt === undefined))
    throw new Error("Confirmed spending cannot be released");
  return entries.filter((e) => e.id !== id);
}
function validateEntries(data: unknown): Entry[] {
  if (
    !Array.isArray(data) ||
    data.some(
      (e) =>
        !e ||
        typeof e !== "object" ||
        typeof e.id !== "string" ||
        !e.id ||
        !finiteNonnegative(e.usd) ||
        !finiteNonnegative(e.at) ||
        (e.expiresAt !== undefined && !finiteNonnegative(e.expiresAt)) ||
        (e.binding !== undefined && !validBinding(e.binding)) ||
        (e.txRef !== undefined && (!/^0x[0-9a-fA-F]{64}$/.test(e.txRef) || !e.binding)) ||
        (e.receiptPending !== undefined && (typeof e.receiptPending !== "boolean" || !e.txRef))
    )
  )
    throw new Error("Spending ledger is malformed; refusing to reset the budget");
  if (new Set(data.map((e) => e.id)).size !== data.length)
    throw new Error("Spending ledger contains duplicate reservations");
  return data as Entry[];
}

/** One-process implementation; use one shared instance or the local file ledger. */
export class MemorySpendLedger implements SpendLedger {
  private entries: Entry[] = [];
  async reserve(usd: number, cap: number, windowMs: number, binding?: SpendLedgerBinding): Promise<string | null> {
    const next = reserveEntry(this.entries, usd, cap, windowMs, binding);
    this.entries = next.entries;
    return next.result;
  }
  async commit(id: string, actualUsd?: number): Promise<void> {
    commitEntry(this.entries, id, actualUsd);
  }
  async release(id: string): Promise<void> {
    this.entries = releaseEntries(this.entries, id);
  }
  async total(windowMs: number): Promise<number> {
    return liveTotal(this.entries, windowMs, Date.now());
  }
  async prepare(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void> {
    prepareEntry(this.entries, id, txRef, binding);
  }
  async assertRecovery(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void> {
    boundEntry(this.entries, id, txRef, binding);
  }
  async complete(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void> {
    const entry = boundEntry(this.entries, id, txRef, binding);
    commitEntry(this.entries, id);
    delete entry.receiptPending;
  }
}

/** Shared cap for processes on one local filesystem; never a cross-host lock. */
export class FileSpendLedger implements SpendLedger {
  constructor(private readonly path: string) {}
  static forAgent(address: string): FileSpendLedger {
    const base = process.env.AIFINPAY_STATE_DIR || join(homedir(), ".aifinpay");
    return new FileSpendLedger(join(base, "spend", `${address.toLowerCase()}.json`));
  }
  private async withLock<T>(fn: (entries: Entry[]) => { entries: Entry[]; result: T }): Promise<T> {
    const directoryPath = resolve(dirname(this.path));
    await mkdir(directoryPath, { recursive: true, mode: 0o700 });
    // Another process, or an earlier failed sync, may have just created these
    // entries. Existing directories therefore also need ancestor durability.
    for (let current = directoryPath; ; current = dirname(current)) {
      const directory = await open(current, "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      if (dirname(current) === current) break;
    }
    const lockPath = `${this.path}.lock`;
    let handle;
    const deadline = Date.now() + LOCK_TIMEOUT_MS;
    for (;;) {
      try {
        handle = await open(lockPath, "wx", 0o600);
        break;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        if (Date.now() >= deadline)
          throw new Error("Spending ledger lock is held; stop all users and reconcile before owner lock recovery");
        await new Promise((resolve) => setTimeout(resolve, 5 + Math.floor(Math.random() * 15)));
      }
    }
    const temporary = `${this.path}.${process.pid}.${randomUUID()}.tmp`;
    try {
      let entries: Entry[];
      try {
        entries = validateEntries(JSON.parse(await readFile(this.path, "utf8")));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
        entries = [];
      }
      const { entries: next, result } = fn(entries);
      validateEntries(next);
      const file = await open(temporary, "wx", 0o600);
      try {
        await file.writeFile(JSON.stringify(next), "utf8");
        await file.sync();
      } finally {
        await file.close();
      }
      await rename(temporary, this.path);
      const directory = await open(dirname(this.path), "r");
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
      return result;
    } finally {
      try {
        await unlink(temporary).catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
        });
      } finally {
        try {
          await handle.close();
        } finally {
          // Only this acquired lock is removed, never one guessed stale from age.
          await unlink(lockPath);
        }
      }
    }
  }
  async reserve(usd: number, cap: number, windowMs: number, binding?: SpendLedgerBinding): Promise<string | null> {
    return this.withLock((entries) => reserveEntry(entries, usd, cap, windowMs, binding));
  }
  async commit(id: string, actualUsd?: number): Promise<void> {
    await this.withLock((entries) => {
      commitEntry(entries, id, actualUsd);
      return { entries, result: undefined };
    });
  }
  async release(id: string): Promise<void> {
    await this.withLock((entries) => ({ entries: releaseEntries(entries, id), result: undefined }));
  }
  async total(windowMs: number): Promise<number> {
    return this.withLock((entries) => {
      const live = prune(entries, windowMs, Date.now());
      return { entries: live, result: liveTotal(live, windowMs, Date.now()) };
    });
  }
  async prepare(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void> {
    await this.withLock((entries) => {
      prepareEntry(entries, id, txRef, binding);
      return { entries, result: undefined };
    });
  }
  async assertRecovery(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void> {
    await this.withLock((entries) => {
      boundEntry(entries, id, txRef, binding);
      return { entries, result: undefined };
    });
  }
  async complete(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void> {
    await this.withLock((entries) => {
      const entry = boundEntry(entries, id, txRef, binding);
      commitEntry(entries, id);
      delete entry.receiptPending;
      return { entries, result: undefined };
    });
  }
}
