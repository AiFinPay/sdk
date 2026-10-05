import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
