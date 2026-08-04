import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySpendLedger, FileSpendLedger } from "../src/spendLedger.js";

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
beforeEach(async () => { dir = await mkdtemp(join(tmpdir(), "aifp-ledger-")); });
afterEach(async () => { await rm(dir, { recursive: true, force: true }); });
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
    await l.reserve(8, 10, DAY);          // reserved, not yet committed
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
    await l.commit(id, 1);               // it actually cost $1
    expect(await l.total(DAY)).toBe(1);
    expect(await l.reserve(8, 10, DAY)).toBeTruthy();
  });

  it("lets concurrent reservations through only up to the cap", async () => {
    // Twenty callers at once, each wanting $1, against a $5 cap.
    const l = make();
    const results = await Promise.all(
      Array.from({ length: 20 }, () => l.reserve(1, 5, DAY)),
    );
    expect(results.filter(Boolean)).toHaveLength(5);
  });
});

describe("surviving a restart", () => {
  it("a new ledger on the same file sees what the old one spent", async () => {
    // The whole point. In memory this test cannot pass, and did not need to:
    // the old implementation simply forgot.
    const first = fileLedger();
    await first.commit((await first.reserve(9, 10, DAY))!);

    const afterRestart = fileLedger();          // a different object, as a new process would be
    expect(await afterRestart.total(DAY)).toBe(9);
    expect(await afterRestart.reserve(9, 10, DAY)).toBeNull();
  });

  it("a reservation orphaned by a crash does not hold the budget forever", async () => {
    // A process that dies between reserving and paying must not cost the agent
    // the rest of its day.
    const path = join(dir, "spend.json");
    const l = new FileSpendLedger(path);
    const id = (await l.reserve(9, 10, DAY))!;
    expect(await l.reserve(9, 10, DAY)).toBeNull();

    // Age the reservation past its TTL, as the clock would.
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.find((e: { id: string }) => e.id === id).expiresAt = Date.now() - 1;
    await new FileSpendLedger(path).release("nothing");   // forces a rewrite through the lock
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify(raw));

    expect(await new FileSpendLedger(path).reserve(9, 10, DAY)).toBeTruthy();
  });

  it("an unreadable ledger does not block payments", async () => {
    // Erring toward letting a payment through is the same direction the old
    // behaviour erred on every restart, and the alternative is an agent that a
    // corrupt file stops permanently.
    const path = join(dir, "spend.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "not json at all");
    expect(await new FileSpendLedger(path).reserve(1, 10, DAY)).toBeTruthy();
  });
});
