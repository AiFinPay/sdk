import {
  constants,
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { randomUUID } from "node:crypto";
import bs58 from "bs58";
import type { Aifp1CachedReceipt, Aifp1PaymentRecovery } from "@aifinpay/agent";

export interface PendingPayment {
  recovery: Aifp1PaymentRecovery;
  serializedTransaction?: `0x${string}`;
  site: string;
  amountUsd: number;
}
export interface PaymentState {
  version: 1;
  address: string;
  receipts: Aifp1CachedReceipt[];
  pending?: PendingPayment;
  spend: { at: number; usd: number; tx: string; failure?: true }[];
}

export class PaymentStateError extends Error {}

function isSolanaSignature(value: unknown): boolean {
  try {
    return typeof value === "string" && bs58.decode(value).length === 64 && bs58.encode(bs58.decode(value)) === value;
  } catch {
    return false;
  }
}
function isTransactionReference(value: unknown): boolean {
  return typeof value === "string" && (/^0x[0-9a-fA-F]{64}$/.test(value) || isSolanaSignature(value));
}
function validPending(state: PendingPayment): boolean {
  const r = state.recovery;
  if (!r || !Number.isFinite(state.amountUsd) || state.amountUsd <= 0) return false;
  if (r.family === "solana") {
    const p = r.solana;
    if (
      state.serializedTransaction !== undefined ||
      r.chain !== "solana" ||
      !p ||
      p.family !== "solana" ||
      !isSolanaSignature(r.txRef) ||
      p.hash !== r.txRef ||
      !["mainnet", "devnet"].includes(p.network) ||
      typeof p.serializedTransactionBase64 !== "string" ||
      p.serializedTransactionBase64.length > 1644 ||
      !/^[A-Za-z0-9+/]+={0,2}$/.test(p.serializedTransactionBase64)
    )
      return false;
    const bytes = Buffer.from(p.serializedTransactionBase64, "base64");
    return bytes.length > 0 && bytes.toString("base64") === p.serializedTransactionBase64;
  }
  return (
    (r.family === undefined || r.family === "evm") &&
    /^0x[0-9a-fA-F]{64}$/.test(r.txRef) &&
    typeof state.serializedTransaction === "string" &&
    /^0x[0-9a-fA-F]+$/.test(state.serializedTransaction)
  );
}

/** Per-wallet lock and crash-safe private journal. Never print its contents. */
export class PaymentStateStore {
  readonly directory: string;
  private readonly path: string;
  private readonly lockPath: string;
  constructor(address: string, walletHome = join(homedir(), ".aifinpay")) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new PaymentStateError("Invalid payment wallet address");
    this.address = address.toLowerCase();
    this.directory = join(walletHome, "payments", this.address);
    this.durableDirectory(join(walletHome, "payments"));
    this.privateDirectory(join(walletHome, "payments"));
    this.durableDirectory(this.directory);
    this.privateDirectory(this.directory);
    this.path = join(this.directory, "state.json");
    this.lockPath = join(this.directory, "operation.lock");
  }
  readonly address: string;
  private durableDirectory(path: string): void {
    const parent = dirname(path);
    if (parent !== path) this.durableDirectory(parent);
    if (!existsSync(path)) {
      try {
        mkdirSync(path, { mode: 0o700 });
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      }
    }
    // A durable file inside a newly created directory is insufficient: persist
    // every ancestor entry before a prepared payment may be broadcast. An
    // existing entry may be left by a previous failed fsync or another creator.
    for (const directory of [path, parent]) {
      const fd = openSync(directory, constants.O_RDONLY);
      try {
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    }
  }
  private privateDirectory(path: string) {
    const stat = lstatSync(path);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) {
      throw new PaymentStateError("Payment state directory must be private (mode 700) and not a symlink");
    }
  }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    let lock: number;
    try {
      lock = openSync(this.lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    } catch {
      throw new PaymentStateError(
        "Payment operation locked. Another process may be paying; after a crash the owner must reconcile the pending transaction before removing operation.lock. Locks are never automatically stolen."
      );
    }
    try {
      writeFileSync(lock, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
      fsyncSync(lock);
      return await fn();
    } finally {
      closeSync(lock);
      unlinkSync(this.lockPath);
    }
  }
  read(): PaymentState {
    if (!existsSync(this.path)) return { version: 1, address: this.address, receipts: [], spend: [] };
    const stat = lstatSync(this.path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.mode & 0o077 || stat.size > 4_000_000) {
      throw new PaymentStateError("Unsafe payment state file; expected private regular file");
    }
    const state = JSON.parse(readFileSync(this.path, "utf8")) as PaymentState;
    if (
      state.version !== 1 ||
      state.address !== this.address ||
      !Array.isArray(state.receipts) ||
      !Array.isArray(state.spend) ||
      state.spend.some(
        (s) => !Number.isFinite(s.at) || !Number.isFinite(s.usd) || s.usd < 0 ||
          (s.usd === 0 && s.failure !== true) || (s.failure !== undefined && s.failure !== true) || !isTransactionReference(s.tx)
      )
    ) {
      throw new PaymentStateError("Invalid payment state; refusing to reset spent budget");
    }
    if (state.pending && !validPending(state.pending)) {
      throw new PaymentStateError("Invalid pending payment; manual reconciliation required");
    }
    return state;
  }
  save(state: PaymentState): void {
    const temporary = join(this.directory, `.state-${randomUUID()}.tmp`);
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    try {
      writeFileSync(fd, JSON.stringify(state));
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    try {
      renameSync(temporary, this.path);
    } catch (error) {
      unlinkSync(temporary);
      throw error;
    }
    const directory = openSync(this.directory, constants.O_RDONLY);
    try {
      fsyncSync(directory);
    } finally {
      closeSync(directory);
    }
  }
  spent24h(state: PaymentState, now = Date.now()): number {
    return state.spend.filter((s) => s.at >= now - 86_400_000).reduce((sum, s) => sum + s.usd, 0);
  }
}
