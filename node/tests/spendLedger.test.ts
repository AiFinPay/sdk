import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemorySpendLedger, FileSpendLedger } from "../src/spendLedger.js";

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

  it("counts an outstanding reservation", async () => {
    const l = make();
    await l.reserve(8, 10, DAY);
    expect(await l.reserve(5, 10, DAY)).toBeNull();
  });

  it("gives budget back on release", async () => {
    const l = make();
    const id = (await l.reserve(9, 10, DAY))!;
    await l.release(id);
    expect(await l.reserve(9, 10, DAY)).toBeTruthy();
  });

  it("keeps committed spend against the cap", async () => {
    const l = make();
    const id = (await l.reserve(9, 10, DAY))!;
    await l.commit(id);
    expect(await l.reserve(9, 10, DAY)).toBeNull();
  });

  it("corrects an estimate to actual cost", async () => {
    const l = make();
    const id = (await l.reserve(9, 10, DAY))!;
    await l.commit(id, 1);
    expect(await l.total(DAY)).toBe(1);
    expect(await l.reserve(8, 10, DAY)).toBeTruthy();
  });

  it("serializes concurrent reservations against one cap", async () => {
    const l = make();
    const results = await Promise.all(Array.from({ length: 20 }, () => l.reserve(1, 5, DAY)));
    expect(results.filter(Boolean)).toHaveLength(5);
  });
});

describe("surviving a restart", () => {
  it("a new ledger on the same file sees settled spend", async () => {
    const first = fileLedger();
    await first.commit((await first.reserve(9, 10, DAY))!);
    const afterRestart = fileLedger();
    expect(await afterRestart.total(DAY)).toBe(9);
    expect(await afterRestart.reserve(9, 10, DAY)).toBeNull();
  });

  it("an orphaned reservation eventually releases", async () => {
    const path = join(dir, "spend.json");
    const l = new FileSpendLedger(path);
    const id = (await l.reserve(9, 10, DAY))!;
    const raw = JSON.parse(await readFile(path, "utf8"));
    raw.find((e: { id: string }) => e.id === id).expiresAt = Date.now() - 1;
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, JSON.stringify(raw));
    expect(await new FileSpendLedger(path).reserve(9, 10, DAY)).toBeTruthy();
  });

  it("an unreadable ledger does not permanently block payments", async () => {
    const path = join(dir, "spend.json");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path, "not json");
    expect(await new FileSpendLedger(path).reserve(1, 10, DAY)).toBeTruthy();
  });
});
