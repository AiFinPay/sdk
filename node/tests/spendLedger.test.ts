import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { MemorySpendLedger, FileSpendLedger, type SpendLedgerBinding } from "../src/spendLedger.js";

// The daily cap was a number compared against a ring buffer in one object's
// memory, and it failed in two ways that between them made it decorative.
//
// A restart began at zero, so an agent that crash-loops or runs from cron got
// its whole allowance again each time — a per-process cap wearing the word
// "daily". And the check was separate from the record: read the total, pay,
// then add the cost. Two calls in flight both read the same total, both passed,
// both paid.
//
// These tests are those two failures.

const DAY = 24 * 3600 * 1000;
let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aifp-ledger-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(dir, { recursive: true, force: true });
});
const fileLedger = () => new FileSpendLedger(join(dir, "spend.json"));

describe.each([
  ["in memory", () => new MemorySpendLedger()],
  ["on disk", () => fileLedger()],
])("a cap held %s", (_label, make) => {
  it("refuses the call that would cross it", async () => {
    const l = make();
    expect(await l.reserve(6, 10, DAY)).toBeTruthy();
    expect(await l.reserve(6, 10, DAY)).toBeNull();
  });

  it("counts an outstanding reservation, not just settled spend", async () => {
    // The race: the second call must see the first one's money as gone even
    // though the first has not finished paying.
    const l = make();
    await l.reserve(8, 10, DAY); // reserved, not yet committed
    expect(await l.reserve(5, 10, DAY)).toBeNull();
  });

  it("gives the budget back when the payment does not happen", async () => {
    const l = make();
    const id = (await l.reserve(9, 10, DAY))!;
    await l.release(id);
    expect(await l.reserve(9, 10, DAY)).toBeTruthy();
  });

  it("keeps a committed payment against the cap", async () => {
    const l = make();
    const id = (await l.reserve(9, 10, DAY))!;
    await l.commit(id);
    expect(await l.reserve(9, 10, DAY)).toBeNull();
  });

  it("corrects the estimate when the real cost is known", async () => {
    const l = make();
    const id = (await l.reserve(9, 10, DAY))!;
    await l.commit(id, 1); // it actually cost $1
    expect(await l.total(DAY)).toBe(1);
    expect(await l.reserve(8, 10, DAY)).toBeTruthy();
  });

  it("lets concurrent reservations through only up to the cap", async () => {
    // Twenty callers at once, each wanting $1, against a $5 cap.
    const l = make();
    const results = await Promise.all(Array.from({ length: 20 }, () => l.reserve(1, 5, DAY)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });
});

describe("surviving a restart", () => {
  it("creates private nested ledger directories before making its reservation durable", async () => {
    const path = join(dir, "new-agent", "spend", "spend.json");
    const ledger = new FileSpendLedger(path);
    const id = await ledger.reserve(0.6, 1, DAY);
    expect(id).toBeTruthy();
    expect((await stat(join(dir, "new-agent"))).mode & 0o777).toBe(0o700);
    expect((await stat(join(dir, "new-agent", "spend"))).mode & 0o777).toBe(0o700);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect(await new FileSpendLedger(path).reserve(0.6, 1, DAY)).toBeNull();
  });
  it("a new ledger on the same file sees what the old one spent", async () => {
    // The whole point. In memory this test cannot pass, and did not need to:
    // the old implementation simply forgot.
    const first = fileLedger();
    await first.commit((await first.reserve(9, 10, DAY))!);

    const afterRestart = fileLedger(); // a different object, as a new process would be
    expect(await afterRestart.total(DAY)).toBe(9);
    expect(await afterRestart.reserve(9, 10, DAY)).toBeNull();
  });

  it("an unknown reservation remains reserved after the old TTL and a daily rollover", async () => {
    const path = join(dir, "spend.json");
    const l = new FileSpendLedger(path);
    const id = (await l.reserve(9, 10, DAY))!;
    expect(await l.reserve(9, 10, DAY)).toBeNull();

    // Age the reservation past its TTL, as the clock would.
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.find((e: { id: string }) => e.id === id).expiresAt = Date.now() - 1;
    raw.find((e: { id: string }) => e.id === id).at = Date.now() - 3 * DAY;
    await writeFile(path, JSON.stringify(raw));
    expect(await new FileSpendLedger(path).total(DAY)).toBe(9);
    expect(await new FileSpendLedger(path).reserve(9, 10, DAY)).toBeNull();
  });

  it("corrupt state refuses payment instead of resetting its budget", async () => {
    const path = join(dir, "spend.json");
    await writeFile(path, "not json at all");
    await expect(new FileSpendLedger(path).reserve(1, 10, DAY)).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("not json at all");
  });
});

const binding = (resource = "/one", chain = "polygon"): SpendLedgerBinding => ({
  apiBaseUrl: "https://api.aifinpay.io",
  paymentIssuer: "https://api.aifinpay.io",
  payer: "0x" + "11".repeat(20),
  merchantId: "merchant",
  scope: "exact",
  resource,
  networkMode: "live",
  chain,
  asset: "USDC",
  token: "0x" + "22".repeat(20),
  grossAmount: "600000",
  quoteId: "qt_budget",
});
const hash = "0x" + "ab".repeat(32);

describe.each([
  ["memory", () => new MemorySpendLedger()],
  ["file", () => fileLedger()],
])("bound recovery on %s", (_label, make) => {
  it("first canonical failure after rollover preserves admission time and its immutable fee identity", async () => {
    const ledger = make(),
      admittedAt = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(admittedAt);
    const purchase = {
      ...binding(),
      chain: "solana:mainnet:pinned-program:pinned-idl",
      asset: "SOL",
      token: "11111111111111111111111111111111",
      solanaAdmissionRateUsd: "100",
      solanaMaxFeeLamports: "1000000",
      solanaTransactionFeeLamports: "5000",
    };
    const signature = bs58.encode(new Uint8Array(64).fill(7));
    const id = (await ledger.reserve(0.6, 1, DAY, purchase))!;
    await ledger.prepare(id, signature, purchase);
    clock.mockReturnValue(admittedAt + 3 * DAY);
    expect(await ledger.total(DAY)).toBe(0.6);
    await ledger.finalizeFailure(id, signature, purchase, 0.0005);
    expect(await ledger.total(DAY)).toBe(0);
    await ledger.assertRecovery(id, signature, purchase);
    await expect(ledger.complete(id, signature, purchase)).rejects.toThrow();
    await expect(ledger.release(id)).rejects.toThrow();
    clock.mockReturnValue(admittedAt + 4 * DAY);
    await ledger.finalizeFailure(id, signature, purchase, 0.0005);
    expect(await ledger.total(DAY)).toBe(0);
    if (_label === "file") {
      const entries = JSON.parse(await readFile(join(dir, "spend.json"), "utf8"));
      expect(entries.find((e: { id: string }) => e.id === id)).toMatchObject({
        at: admittedAt,
        usd: 0.0005,
        failure: true,
      });
      await new FileSpendLedger(join(dir, "spend.json")).assertRecovery(id, signature, purchase);
    }
  });
  it("does not expire unresolved reservations when the clock advances", async () => {
    const l = make(),
      now = Date.now();
    const id = (await l.reserve(0.6, 1, DAY, binding()))!;
    await l.prepare(id, hash, binding());
    vi.spyOn(Date, "now").mockReturnValue(now + 3 * DAY);
    expect(await l.total(DAY)).toBe(0.6);
    expect(await l.reserve(0.6, 1, DAY, binding("/other", "bnb"))).toBeNull();
    await expect(l.reserve(0.1, 1, DAY, binding("/one", "bnb"))).rejects.toThrow(/Unresolved/);
  });

  it("keeps receipt-failure guard and immutable recovery identity after confirmed window rollover", async () => {
    const l = make(),
      now = Date.now(),
      purchase = binding();
    const id = (await l.reserve(0.6, 1, DAY, purchase))!;
    await l.prepare(id, hash, purchase);
    await l.commit(id);
    await expect(l.release(id)).rejects.toThrow(/Confirmed/);
    vi.spyOn(Date, "now").mockReturnValue(now + 3 * DAY);
    expect(await l.total(DAY)).toBe(0);
    await expect(l.reserve(0.1, 1, DAY, binding("/one", "bnb"))).rejects.toThrow(/Unresolved/);
    await l.complete(id, hash, purchase);
    await l.reserve(0.1, 1, DAY, binding("/unrelated"));
    await l.total(DAY);
    await l.assertRecovery(id, hash, purchase);
    await l.complete(id, hash, purchase);
    expect(await l.total(DAY)).toBe(0.1);
  });

  it.each(["payer", "chain", "token", "grossAmount", "quoteId"] as const)(
    "rejects recovery with a foreign %s",
    async (field) => {
      const l = make(),
        purchase = binding();
      const id = (await l.reserve(0.6, 1, DAY, purchase))!;
      await l.prepare(id, hash, purchase);
      await expect(l.assertRecovery(id, hash, { ...purchase, [field]: "foreign" })).rejects.toThrow(
        /Recovery disagrees/
      );
      await expect(l.complete(id, "0x" + "cd".repeat(32), purchase)).rejects.toThrow(/Recovery disagrees/);
      expect(await l.total(DAY)).toBe(0.6);
    }
  );
});

describe("durable refusal and shared admission", () => {
  it("two real processes reconcile the same finalized failure once without overwriting a successful debit", async () => {
    const path = join(dir, "spend.json"),
      ledger = new FileSpendLedger(path);
    const purchase = {
      ...binding(),
      chain: "solana:mainnet:pinned-program:pinned-idl",
      asset: "SOL",
      token: "11111111111111111111111111111111",
      solanaAdmissionRateUsd: "100",
      solanaMaxFeeLamports: "1000000",
      solanaTransactionFeeLamports: "5000",
    };
    const signature = bs58.encode(new Uint8Array(64).fill(7)),
      id = (await ledger.reserve(0.6, 1, DAY, purchase))!;
    await ledger.prepare(id, signature, purchase);
    const script =
      "const {FileSpendLedger}=await import(process.argv[1]); await new FileSpendLedger(process.argv[2]).finalizeFailure(process.argv[3],process.argv[4],JSON.parse(process.argv[5]),.0005);";
    await Promise.all(
      Array.from({ length: 2 }, () =>
        promisify(execFile)(process.execPath, [
          "--input-type=module",
          "-e",
          script,
          new URL("../dist/spendLedger.js", import.meta.url).href,
          path,
          id,
          signature,
          JSON.stringify(purchase),
        ])
      )
    );
    expect(await new FileSpendLedger(path).total(DAY)).toBe(0.0005);
    const entries = JSON.parse(await readFile(path, "utf8"));
    expect(entries.filter((e: { id: string }) => e.id === id)).toHaveLength(1);
    await expect(ledger.finalizeFailure(id, signature, purchase, 0.0004)).rejects.toThrow(/immutable/);
    const successful = { ...purchase, resource: "/success", quoteId: "qt_success" },
      success = (await ledger.reserve(0.6, 1, DAY, successful))!;
    await ledger.prepare(success, signature, successful);
    await ledger.commit(success);
    await expect(ledger.finalizeFailure(success, signature, successful, 0.0005)).rejects.toThrow(/successful/);
    expect(await ledger.total(DAY)).toBeCloseTo(0.6005, 10);
  });
  it("two instances admit at most one60cent payment under a dollar cap", async () => {
    const results = await Promise.all([
      fileLedger().reserve(0.6, 1, DAY, binding()),
      fileLedger().reserve(0.6, 1, DAY, binding("/other", "bnb")),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await fileLedger().total(DAY)).toBe(0.6);
    expect((await stat(join(dir, "spend.json"))).mode & 0o777).toBe(0o600);
  });
  it.each(["{}", "null", '[{"id":"one","usd":-1,"at":1}]', '[{"id":"one","usd":1,"at":"yesterday"}]'])(
    "rejects malformed counters %s without overwriting state",
    async (data) => {
      const path = join(dir, "spend.json");
      await writeFile(path, data);
      await expect(new FileSpendLedger(path).reserve(0.1, 1, DAY)).rejects.toThrow(/malformed/);
      expect(await readFile(path, "utf8")).toBe(data);
    }
  );
  it("does not replace a nonfile/unreadable ledger with an empty budget", async () => {
    const path = join(dir, "spend.json");
    const { mkdir } = await import("node:fs/promises");
    await mkdir(path);
    await expect(new FileSpendLedger(path).reserve(0.1, 1, DAY)).rejects.toThrow();
    expect((await stat(path)).isDirectory()).toBe(true);
  });
  it("never steals a live or unknown lock based only on age", async () => {
    const path = join(dir, "spend.json"),
      lock = path + ".lock";
    await writeFile(lock, "another process", { mode: 0o600 });
    const now = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(now)
      .mockReturnValue(now + 6000);
    await expect(new FileSpendLedger(path).reserve(0.1, 1, DAY)).rejects.toThrow(/lock is held/);
    expect(await readFile(lock, "utf8")).toBe("another process");
    await expect(readFile(path, "utf8")).rejects.toMatchObject({ code: "ENOENT" });
  });
});

const quoteBinding: SpendLedgerBinding = {
  apiBaseUrl: "https://api.example",
  paymentIssuer: "https://issuer.example",
  payer: "SolanaCaseSensitivePayer",
  walletIdentity: "one-local-wallet",
  merchantId: "mrch_admission",
  scope: "exact",
  resource: "/admission",
  networkMode: "live",
  chain: "solana:mainnet:program:idl",
  asset: "SOL",
  token: "11111111111111111111111111111111",
  grossAmount: "0",
  quoteId: "quote-admission",
  quoteAdmissionVersion: "1",
};
const admittedQuote = JSON.stringify({ quote_id: "qt_original" });
const monetaryBinding: SpendLedgerBinding = { ...quoteBinding, grossAmount: "1000000", quoteId: "qt_original" };
delete monetaryBinding.quoteAdmissionVersion;
describe.each([
  ["memory", () => new MemorySpendLedger()],
  ["file", () => fileLedger()],
])("quote phase %s", (_name, make) => {
  it("creates one admission under concurrent callers, then atomically converts without a purchase-guard gap", async () => {
    const ledger = make();
    let created = 0;
    const create = async () => {
      created++;
      await Promise.resolve();
      return { requestBody: "same raw JSON", statement: "same statement" };
    };
    const results = await Promise.all(
      Array.from({ length: 5 }, () => ledger.beginQuoteAdmission(quoteBinding, "owner context", create))
    );
    expect(new Set(results.map((e) => e.id)).size).toBe(1);
    expect(created).toBe(1);
    const original = results[0]!;
    expect(await ledger.total(DAY)).toBe(0);
    await expect(
      ledger.reserve(0.6, 1, DAY, { ...monetaryBinding, chain: "polygon", payer: "0xOther", token: "0xToken" })
    ).rejects.toThrow("Unresolved purchase");
    await ledger.adoptQuoteAdmission(original.id, quoteBinding, "owner context", admittedQuote);
    expect(await ledger.reserve(0.6, 1, DAY, monetaryBinding, original.id)).toBe(original.id);
    expect(await ledger.total(DAY)).toBe(0.6);
    await expect(ledger.beginQuoteAdmission(quoteBinding, "owner context", create)).rejects.toThrow("Unresolved");
    expect(created).toBe(1);
    await expect(
      ledger.closeQuoteAdmission(original.id, quoteBinding, "owner context", "expired-unbroadcast", admittedQuote)
    ).rejects.toThrow();
    await ledger.release(original.id); // an explicit proven prebroadcast failure retains the original admission, not a new nonce.
    const resumed = await ledger.beginQuoteAdmission(quoteBinding, "owner context", create);
    expect(resumed.id).toBe(original.id);
    expect(resumed.quoteJson).toBe(admittedQuote);
    expect(resumed.wasReserved).toBe(true);
    await expect(
      ledger.closeQuoteAdmission(original.id, quoteBinding, "owner context", "expired-unbroadcast", admittedQuote)
    ).rejects.toThrow();
    expect(created).toBe(1);
  });
  it("preserves pending admission on cap refusal and refuses changed quote or owner context", async () => {
    const ledger = make(),
      create = async () => ({ requestBody: "raw", statement: "statement" });
    const e = await ledger.beginQuoteAdmission(quoteBinding, "owner", create);
    await ledger.adoptQuoteAdmission(e.id, quoteBinding, "owner", admittedQuote);
    expect(await ledger.reserve(0.6, 0.5, DAY, monetaryBinding, e.id)).toBeNull();
    await expect(
      ledger.adoptQuoteAdmission(e.id, quoteBinding, "owner", JSON.stringify({ quote_id: "different" }))
    ).rejects.toThrow("immutable");
    await expect(ledger.beginQuoteAdmission(quoteBinding, "changed owner", create)).rejects.toThrow();
    await expect(ledger.reserve(0.6, 1, DAY, { ...monetaryBinding, quoteId: "different" }, e.id)).rejects.toThrow();
    expect((await ledger.beginQuoteAdmission(quoteBinding, "owner", create)).id).toBe(e.id);
  });
});
it("two real processes persist one prequote authorization; restart and day rollover do not rotate it", async () => {
  const run = promisify(execFile),
    path = join(dir, "shared-admission.json");
  const source = `import { FileSpendLedger } from './dist/index.js'; import { randomUUID } from 'node:crypto';
    const ledger = new FileSpendLedger(process.argv[1]);
    const e = await ledger.beginQuoteAdmission(JSON.parse(process.argv[2]), 'owner', async () => ({requestBody:randomUUID(),statement:'owner signature'}));
    process.stdout.write(JSON.stringify(e));`;
  const rows = await Promise.all(
    Array.from({ length: 2 }, () =>
      run(process.execPath, ["--input-type=module", "-e", source, path, JSON.stringify(quoteBinding)], {
        cwd: process.cwd(),
      })
    )
  );
  const a = JSON.parse(rows[0]!.stdout),
    b = JSON.parse(rows[1]!.stdout);
  expect(a).toEqual(b);
  vi.spyOn(Date, "now").mockReturnValue(Date.now() + 3 * DAY);
  const restart = await new FileSpendLedger(path).beginQuoteAdmission(quoteBinding, "owner", async () => {
    throw Error("must not create");
  });
  expect(restart).toEqual(a);
  expect(JSON.parse(await readFile(path, "utf8"))).toHaveLength(1);
});
