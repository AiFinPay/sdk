// Daily caps use reserve → confirmed commit or proven nonpayment release.
// Unknown outcomes never expire: a process restart is not evidence of no payment.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, open, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import bs58 from "bs58";

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
  /** Trusted factory identity shared by EVM/Solana payer keys. */
  walletIdentity?: string;
  /** Independently sourced pre-sign rate/cap, bound only for Solana accounting. */
  solanaAdmissionRateUsd?: string;
  solanaMaxFeeLamports?: string;
  solanaTransactionFeeLamports?: string;
  /** Makes older parsers refuse the durable pre-quote phase. */
  quoteAdmissionVersion?: "1";
}
export interface QuoteAdmission {
  id: string;
  ownerContext: string;
  requestBody: string;
  statement: string;
  quoteJson?: string;
  phase: "pending" | "monetary" | "terminal";
  terminal?: "not-admitted" | "expired-unbroadcast";
  wasReserved?: true;
  originalBinding: SpendLedgerBinding;
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
  failure?: true;
  quoteAdmission?: QuoteAdmission;
}
export interface SpendLedger {
  reserve(
    usd: number,
    cap: number,
    windowMs: number,
    binding?: SpendLedgerBinding,
    admissionId?: string
  ): Promise<string | null>;
  beginQuoteAdmission?(
    binding: SpendLedgerBinding,
    ownerContext: string,
    create: () => Promise<{ requestBody: string; statement: string }>
  ): Promise<QuoteAdmission>;
  adoptQuoteAdmission?(id: string, binding: SpendLedgerBinding, ownerContext: string, quoteJson: string): Promise<void>;
  closeQuoteAdmission?(
    id: string,
    binding: SpendLedgerBinding,
    ownerContext: string,
    terminal: "not-admitted" | "expired-unbroadcast",
    quoteJson?: string
  ): Promise<void>;
  commit(id: string, actualUsd?: number): Promise<void>;
  /** Caller must prove settlement never broadcast or reverted. */
  release(id: string): Promise<void>;
  total(windowMs: number): Promise<number>;
  /** Required by capped v1.4 callers; old custom adapters fail before broadcast. */
  prepare?(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void>;
  assertRecovery?(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void>;
  complete?(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void>;
  /** Exact canonical finalized failure only; retains an immutable fee-only ID. */
  finalizeFailure?(id: string, txRef: string, binding: SpendLedgerBinding, feeUsd: number): Promise<void>;
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
  const b = binding as SpendLedgerBinding;
  const optional = [
    "walletIdentity",
    "solanaAdmissionRateUsd",
    "solanaMaxFeeLamports",
    "solanaTransactionFeeLamports",
    "quoteAdmissionVersion",
  ];
  return (
    !!binding &&
    typeof binding === "object" &&
    Object.keys(binding).every(
      (k) => BINDING_FIELDS.includes(k as (typeof BINDING_FIELDS)[number]) || optional.includes(k)
    ) &&
    (!Object.hasOwn(binding, "walletIdentity") ||
      (typeof (binding as SpendLedgerBinding).walletIdentity === "string" &&
        !!(binding as SpendLedgerBinding).walletIdentity)) &&
    (b.quoteAdmissionVersion === undefined ||
      (b.quoteAdmissionVersion === "1" &&
        b.chain.startsWith("solana:") &&
        b.grossAmount === "0" &&
        b.quoteId === "quote-admission")) &&
    ((b.solanaAdmissionRateUsd === undefined &&
      b.solanaMaxFeeLamports === undefined &&
      b.solanaTransactionFeeLamports === undefined) ||
      (b.chain?.startsWith("solana:") &&
        typeof b.solanaAdmissionRateUsd === "string" &&
        /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,18})?$/.test(b.solanaAdmissionRateUsd) &&
        Number(b.solanaAdmissionRateUsd) > 0 &&
        Number(b.solanaAdmissionRateUsd) < 100000 &&
        typeof b.solanaMaxFeeLamports === "string" &&
        /^[1-9][0-9]*$/.test(b.solanaMaxFeeLamports) &&
        typeof b.solanaTransactionFeeLamports === "string" &&
        /^(?:0|[1-9][0-9]*)$/.test(b.solanaTransactionFeeLamports) &&
        BigInt(b.solanaTransactionFeeLamports) <= BigInt(b.solanaMaxFeeLamports))) &&
    BINDING_FIELDS.every(
      (k) => typeof (binding as SpendLedgerBinding)[k] === "string" && !!(binding as SpendLedgerBinding)[k]
    )
  );
}
function sameBinding(left: SpendLedgerBinding | undefined, right: SpendLedgerBinding): boolean {
  return (
    !!left &&
    left.walletIdentity === right.walletIdentity &&
    left.quoteAdmissionVersion === right.quoteAdmissionVersion &&
    left.solanaAdmissionRateUsd === right.solanaAdmissionRateUsd &&
    left.solanaMaxFeeLamports === right.solanaMaxFeeLamports &&
    left.solanaTransactionFeeLamports === right.solanaTransactionFeeLamports &&
    BINDING_FIELDS.every((k) => left[k] === right[k])
  );
}
function purchaseKey(binding: SpendLedgerBinding): string {
  // Exact chain/token binding is retained, but changing rail cannot rebuy unresolved access.
  return createHash("sha256")
    .update(
      JSON.stringify([
        binding.apiBaseUrl,
        binding.paymentIssuer,
        binding.walletIdentity ?? binding.payer,
        binding.merchantId,
        binding.scope,
        binding.resource,
        binding.networkMode,
      ])
    )
    .digest("hex");
}
function admissionAccessKey(binding: SpendLedgerBinding): string {
  // An unknown admission cannot be bypassed by changing live/test or rail.
  return purchaseKey({ ...binding, networkMode: "quote-access" });
}
function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}
function validateCost(usd: number, cap: number, windowMs: number, binding?: SpendLedgerBinding): void {
  if (
    !finiteNonnegative(usd) ||
    !(Number.isFinite(cap) && cap > 0) ||
    !(Number.isFinite(windowMs) && windowMs > 0) ||
    (binding !== undefined && !validBinding(binding)) ||
    binding?.quoteAdmissionVersion !== undefined
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
function reserveEntry(
  entries: Entry[],
  usd: number,
  cap: number,
  windowMs: number,
  binding?: SpendLedgerBinding,
  admissionId?: string
) {
  validateCost(usd, cap, windowMs, binding);
  const now = Date.now(),
    live = prune(entries, windowMs, now);
  const admission = admissionId ? live.find((e) => e.id === admissionId) : undefined;
  if (
    admissionId &&
    (!admission?.quoteAdmission ||
      admission.quoteAdmission.phase !== "pending" ||
      !admission.quoteAdmission.quoteJson ||
      !binding ||
      !sameAdmissionPurchase(admission.quoteAdmission.originalBinding, binding) ||
      JSON.parse(admission.quoteAdmission.quoteJson).quote_id !== binding.quoteId ||
      admission.txRef ||
      admission.usd !== 0)
  )
    throw new Error("Monetary reservation disagrees with the durable quote admission");
  if (
    binding &&
    live.some(
      (e) =>
        e.id !== admissionId &&
        e.binding &&
        (e.expiresAt !== undefined || e.receiptPending === true) &&
        (purchaseKey(e.binding) === purchaseKey(binding) ||
          (e.quoteAdmission && admissionAccessKey(e.quoteAdmission.originalBinding) === admissionAccessKey(binding)))
    )
  )
    throw new Error("Unresolved purchase; recover its existing payment before buying again");
  if (liveTotal(live, windowMs, now) + usd > cap) return { entries: live, result: null };
  if (admission) {
    admission.usd = usd;
    admission.at = now;
    admission.binding = { ...binding! };
    admission.quoteAdmission!.phase = "monetary";
    admission.quoteAdmission!.wasReserved = true;
    return { entries: live, result: admission.id };
  }
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
  if (entry.quoteAdmission && entry.quoteAdmission.phase !== "monetary")
    throw new Error("Quote admission is not a monetary reservation");
  if (entry.failure && actualUsd !== undefined && actualUsd !== entry.usd)
    throw new Error("Finalized failure debit is immutable");
  if (actualUsd !== undefined) entry.usd = actualUsd;
  if (entry.expiresAt !== undefined) entry.at = Date.now();
  delete entry.expiresAt;
}
function boundEntry(
  entries: Entry[],
  id: string,
  txRef: string,
  binding: SpendLedgerBinding,
  allowFailure = false
): Entry {
  const entry = entries.find((e) => e.id === id);
  if (
    !entry ||
    (entry.failure && !allowFailure) ||
    !validBinding(binding) ||
    !sameBinding(entry.binding, binding) ||
    entry.txRef !== txRef
  )
    throw new Error("Recovery disagrees with the original spending reservation");
  return entry;
}
function finalizeFailureEntry(
  entries: Entry[],
  id: string,
  txRef: string,
  binding: SpendLedgerBinding,
  feeUsd: number
): void {
  const entry = entries.find((e) => e.id === id);
  if (
    !entry ||
    !validBinding(binding) ||
    !sameBinding(entry.binding, binding) ||
    entry.txRef !== txRef ||
    !binding.solanaAdmissionRateUsd ||
    !binding.solanaMaxFeeLamports ||
    !finiteNonnegative(feeUsd) ||
    feeUsd > entry.usd
  )
    throw new Error("Finalized failure disagrees with the original spending reservation");
  if (entry.failure) {
    if (entry.usd !== feeUsd) throw new Error("Finalized failure debit is immutable");
    return;
  }
  if (entry.expiresAt === undefined) throw new Error("Confirmed successful spending cannot become a failed debit");
  // A late proof does not move the original admission into a new daily window.
  // The immutable identity survives indefinitely; only its original timestamp
  // decides whether this proven fee is counted in the current spending window.
  entry.usd = feeUsd;
  delete entry.expiresAt;
  entry.failure = true;
  delete entry.receiptPending;
}
function validTxRef(txRef: string, binding: SpendLedgerBinding): boolean {
  if (!binding.chain.startsWith("solana:")) return /^0x[0-9a-fA-F]{64}$/.test(txRef);
  try {
    return bs58.decode(txRef).length === 64 && bs58.encode(bs58.decode(txRef)) === txRef;
  } catch {
    return false;
  }
}
function prepareEntry(entries: Entry[], id: string, txRef: string, binding: SpendLedgerBinding): void {
  const entry = entries.find((e) => e.id === id);
  if (
    !entry ||
    (entry.quoteAdmission && entry.quoteAdmission.phase !== "monetary") ||
    entry.expiresAt === undefined ||
    !sameBinding(entry.binding, binding) ||
    !validTxRef(txRef, binding) ||
    (entry.txRef !== undefined && entry.txRef !== txRef)
  )
    throw new Error("Prepared transaction disagrees with the spending reservation");
  entry.txRef = txRef;
  entry.receiptPending = true;
}
function releaseEntries(entries: Entry[], id: string): Entry[] {
  if (entries.some((e) => e.id === id && e.expiresAt === undefined))
    throw new Error("Confirmed spending cannot be released");
  const entry = entries.find((e) => e.id === id);
  if (entry?.quoteAdmission) {
    if (entry.quoteAdmission.phase !== "monetary") throw new Error("Quote admission requires proof-bound closure");
    // A proven prebroadcast failure can retry its original admission, never a new nonce.
    entry.usd = 0;
    entry.binding = { ...entry.quoteAdmission.originalBinding };
    entry.quoteAdmission.phase = "pending";
    delete entry.txRef;
    delete entry.receiptPending;
    return entries;
  }
  return entries.filter((e) => e.id !== id);
}
function sameAdmissionPurchase(original: SpendLedgerBinding, binding: SpendLedgerBinding): boolean {
  return (
    purchaseKey(original) === purchaseKey(binding) &&
    ["payer", "chain", "asset", "token", "walletIdentity"].every(
      (k) => original[k as keyof SpendLedgerBinding] === binding[k as keyof SpendLedgerBinding]
    )
  );
}
function validAdmission(a: unknown): a is QuoteAdmission {
  const x = a as QuoteAdmission;
  return (
    !!x &&
    typeof x === "object" &&
    typeof x.id === "string" &&
    !!x.id &&
    typeof x.ownerContext === "string" &&
    !!x.ownerContext &&
    x.ownerContext.length <= 65536 &&
    typeof x.requestBody === "string" &&
    !!x.requestBody &&
    x.requestBody.length <= 65536 &&
    typeof x.statement === "string" &&
    !!x.statement &&
    x.statement.length <= 65536 &&
    (x.quoteJson === undefined ||
      (typeof x.quoteJson === "string" && !!x.quoteJson && x.quoteJson.length <= 1048576)) &&
    ["pending", "monetary", "terminal"].includes(x.phase) &&
    (x.wasReserved === undefined || x.wasReserved === true) &&
    validBinding(x.originalBinding) &&
    x.originalBinding.quoteAdmissionVersion === "1" &&
    (x.phase === "terminal" ? ["not-admitted", "expired-unbroadcast"].includes(x.terminal!) : x.terminal === undefined)
  );
}
async function beginAdmission(
  entries: Entry[],
  binding: SpendLedgerBinding,
  ownerContext: string,
  create: () => Promise<{ requestBody: string; statement: string }>
): Promise<QuoteAdmission> {
  if (!validBinding(binding) || binding.quoteAdmissionVersion !== "1")
    throw new Error("Invalid quote admission binding");
  const existing = entries.find(
    (e) =>
      e.binding &&
      (e.expiresAt !== undefined || e.receiptPending) &&
      (purchaseKey(e.binding) === purchaseKey(binding) ||
        (e.quoteAdmission && admissionAccessKey(e.quoteAdmission.originalBinding) === admissionAccessKey(binding)))
  );
  if (existing) {
    if (
      !existing.quoteAdmission ||
      existing.quoteAdmission.phase !== "pending" ||
      !sameBinding(existing.binding, binding) ||
      existing.quoteAdmission.ownerContext !== ownerContext
    )
      throw new Error("Unresolved purchase or changed owner context; reconcile the original admission");
    return structuredClone(existing.quoteAdmission);
  }
  const id = randomUUID(),
    result: QuoteAdmission = {
      id,
      ownerContext,
      ...(await create()),
      phase: "pending",
      originalBinding: { ...binding },
    };
  if (!validAdmission(result)) throw new Error("Malformed quote admission");
  entries.push({
    id,
    usd: 0,
    at: Date.now(),
    expiresAt: Date.now() + RESERVATION_MARKER_MS,
    binding: { ...binding },
    quoteAdmission: result,
  });
  return structuredClone(result);
}
function boundAdmission(entries: Entry[], id: string, binding: SpendLedgerBinding, context: string): QuoteAdmission {
  const entry = entries.find((e) => e.id === id);
  if (
    !entry?.quoteAdmission ||
    !sameBinding(entry.binding, binding) ||
    entry.quoteAdmission.ownerContext !== context ||
    entry.txRef ||
    entry.usd !== 0
  )
    throw new Error("Quote admission phase or owner binding mismatch");
  return entry.quoteAdmission;
}
function adoptAdmission(
  entries: Entry[],
  id: string,
  binding: SpendLedgerBinding,
  context: string,
  quoteJson: string
): void {
  const a = boundAdmission(entries, id, binding, context);
  if (a.phase !== "pending" || (a.quoteJson !== undefined && a.quoteJson !== quoteJson))
    throw new Error("Original quote admission is immutable");
  a.quoteJson = quoteJson;
  if (!validAdmission(a)) throw new Error("Malformed adopted quote");
}
function closeAdmission(
  entries: Entry[],
  id: string,
  binding: SpendLedgerBinding,
  context: string,
  terminal: "not-admitted" | "expired-unbroadcast",
  quoteJson?: string
): void {
  const a = boundAdmission(entries, id, binding, context);
  if (a.phase === "terminal" && a.terminal === terminal && a.quoteJson === quoteJson) return;
  if (
    a.phase !== "pending" ||
    a.wasReserved ||
    a.quoteJson !== quoteJson ||
    (terminal === "not-admitted" ? quoteJson !== undefined : !quoteJson)
  )
    throw new Error("Ambiguous admission cannot be closed without original nonbroadcast evidence");
  a.phase = "terminal";
  a.terminal = terminal;
  delete entries.find((e) => e.id === id)!.expiresAt;
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
        (e.quoteAdmission !== undefined &&
          (!validAdmission(e.quoteAdmission) ||
            e.quoteAdmission.id !== e.id ||
            (e.quoteAdmission.phase !== "monetary" &&
              (!sameBinding(e.binding, e.quoteAdmission.originalBinding) ||
                e.usd !== 0 ||
                e.txRef ||
                e.receiptPending)) ||
            (e.quoteAdmission.phase === "terminal") !==
              (e.expiresAt === undefined && e.quoteAdmission.phase !== "monetary"))) ||
        (e.binding?.quoteAdmissionVersion !== undefined && !e.quoteAdmission) ||
        (e.txRef !== undefined && (!e.binding || !validTxRef(e.txRef, e.binding))) ||
        (e.receiptPending !== undefined && (typeof e.receiptPending !== "boolean" || !e.txRef)) ||
        (e.failure !== undefined &&
          (e.failure !== true ||
            e.expiresAt !== undefined ||
            e.receiptPending !== undefined ||
            !e.binding?.solanaAdmissionRateUsd ||
            !e.txRef))
    )
  )
    throw new Error("Spending ledger is malformed; refusing to reset the budget");
  if (new Set(data.map((e) => e.id)).size !== data.length)
    throw new Error("Spending ledger contains duplicate reservations");
  const pendingKeys = data
    .filter((e) => e.quoteAdmission && (e.expiresAt !== undefined || e.receiptPending))
    .map((e) => admissionAccessKey(e.quoteAdmission.originalBinding));
  if (new Set(pendingKeys).size !== pendingKeys.length)
    throw new Error("Spending ledger contains duplicate quote admissions");
  return data as Entry[];
}

/** One-process implementation; use one shared instance or the local file ledger. */
export class MemorySpendLedger implements SpendLedger {
  private entries: Entry[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private serial<T>(fn: () => T | Promise<T>): Promise<T> {
    const task = this.tail.then(fn);
    this.tail = task.catch(() => undefined);
    return task;
  }
  reserve(
    usd: number,
    cap: number,
    windowMs: number,
    binding?: SpendLedgerBinding,
    admissionId?: string
  ): Promise<string | null> {
    return this.serial(() => {
      const next = reserveEntry(this.entries, usd, cap, windowMs, binding, admissionId);
      this.entries = next.entries;
      return next.result;
    });
  }
  commit(id: string, actualUsd?: number): Promise<void> {
    return this.serial(() => commitEntry(this.entries, id, actualUsd));
  }
  release(id: string): Promise<void> {
    return this.serial(() => {
      this.entries = releaseEntries(this.entries, id);
    });
  }
  total(windowMs: number): Promise<number> {
    return this.serial(() => liveTotal(this.entries, windowMs, Date.now()));
  }
  prepare(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void> {
    return this.serial(() => prepareEntry(this.entries, id, txRef, binding));
  }
  assertRecovery(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void> {
    return this.serial(() => {
      boundEntry(this.entries, id, txRef, binding, true);
    });
  }
  complete(id: string, txRef: string, binding: SpendLedgerBinding): Promise<void> {
    return this.serial(() => {
      const entry = boundEntry(this.entries, id, txRef, binding);
      commitEntry(this.entries, id);
      delete entry.receiptPending;
    });
  }
  finalizeFailure(id: string, txRef: string, binding: SpendLedgerBinding, feeUsd: number): Promise<void> {
    return this.serial(() => finalizeFailureEntry(this.entries, id, txRef, binding, feeUsd));
  }
  beginQuoteAdmission(
    binding: SpendLedgerBinding,
    context: string,
    create: () => Promise<{ requestBody: string; statement: string }>
  ): Promise<QuoteAdmission> {
    return this.serial(() => beginAdmission(this.entries, binding, context, create));
  }
  adoptQuoteAdmission(id: string, binding: SpendLedgerBinding, context: string, quoteJson: string): Promise<void> {
    return this.serial(() => adoptAdmission(this.entries, id, binding, context, quoteJson));
  }
  closeQuoteAdmission(
    id: string,
    binding: SpendLedgerBinding,
    context: string,
    terminal: "not-admitted" | "expired-unbroadcast",
    quoteJson?: string
  ): Promise<void> {
    return this.serial(() => closeAdmission(this.entries, id, binding, context, terminal, quoteJson));
  }
}

/** Shared cap for processes on one local filesystem; never a cross-host lock. */
export class FileSpendLedger implements SpendLedger {
  constructor(private readonly path: string) {}
  static forAgent(address: string): FileSpendLedger {
    const base = process.env.AIFINPAY_STATE_DIR || join(homedir(), ".aifinpay");
    return new FileSpendLedger(join(base, "spend", `${address.toLowerCase()}.json`));
  }
  private async withLock<T>(
    fn: (entries: Entry[]) => { entries: Entry[]; result: T } | Promise<{ entries: Entry[]; result: T }>
  ): Promise<T> {
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
      const { entries: next, result } = await fn(entries);
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
  async reserve(
    usd: number,
    cap: number,
    windowMs: number,
    binding?: SpendLedgerBinding,
    admissionId?: string
  ): Promise<string | null> {
    return this.withLock((entries) => reserveEntry(entries, usd, cap, windowMs, binding, admissionId));
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
      boundEntry(entries, id, txRef, binding, true);
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
  async finalizeFailure(id: string, txRef: string, binding: SpendLedgerBinding, feeUsd: number): Promise<void> {
    await this.withLock((entries) => {
      finalizeFailureEntry(entries, id, txRef, binding, feeUsd);
      return { entries, result: undefined };
    });
  }
  async beginQuoteAdmission(
    binding: SpendLedgerBinding,
    context: string,
    create: () => Promise<{ requestBody: string; statement: string }>
  ): Promise<QuoteAdmission> {
    return this.withLock(async (entries) => ({
      entries,
      result: await beginAdmission(entries, binding, context, create),
    }));
  }
  async adoptQuoteAdmission(
    id: string,
    binding: SpendLedgerBinding,
    context: string,
    quoteJson: string
  ): Promise<void> {
    await this.withLock((entries) => {
      adoptAdmission(entries, id, binding, context, quoteJson);
      return { entries, result: undefined };
    });
  }
  async closeQuoteAdmission(
    id: string,
    binding: SpendLedgerBinding,
    context: string,
    terminal: "not-admitted" | "expired-unbroadcast",
    quoteJson?: string
  ): Promise<void> {
    await this.withLock((entries) => {
      closeAdmission(entries, id, binding, context, terminal, quoteJson);
      return { entries, result: undefined };
    });
  }
}
