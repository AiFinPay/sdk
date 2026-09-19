import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { PaymentStateStore } from "../src/payment-state.js";
const dirs: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "aifp-state-"));
  dirs.push(home);
  return new PaymentStateStore("0x" + "12".repeat(20), home);
}
afterEach(() => {
  for (const directory of dirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});
describe("durable payment state", () => {
  it("persists private state atomically and sums only rolling 24h spend", async () => {
    const store = fixture();
    const state = store.read();
    state.spend = [
      { at: Date.now(), usd: 0.1, tx: "0x" + "ab".repeat(32) },
      { at: Date.now() - 90_000_000, usd: 1, tx: "0x" + "cd".repeat(32) },
    ];
    await store.exclusive(async () => {
      store.save(state);
    });
    expect(store.read()).toEqual(state);
    expect(store.spent24h(store.read())).toBe(0.1);
    expect(statSync(store.directory).mode & 0o777).toBe(0o700);
    expect(statSync(join(store.directory, "state.json")).mode & 0o777).toBe(0o600);
  });
  it("refuses concurrent operations and never steals a stale lock", async () => {
    const store = fixture();
    await store.exclusive(async () => {
      await expect(store.exclusive(async () => {})).rejects.toThrow(/locked/);
    });
    writeFileSync(join(store.directory, "operation.lock"), '{"pid":99999999}', { mode: 0o600 });
    await expect(store.exclusive(async () => {})).rejects.toThrow(/locked/);
    expect(readFileSync(join(store.directory, "operation.lock"), "utf8")).toContain("99999999");
  });
  it("refuses malformed or permissive state rather than clearing spent budget", () => {
    const store = fixture();
    store.save(store.read());
    const path = join(store.directory, "state.json");
    chmodSync(path, 0o644);
    expect(() => store.read()).toThrow(/Unsafe/);
    chmodSync(path, 0o600);
    writeFileSync(path, '{"version":1,"spend":[]}');
    expect(() => store.read()).toThrow(/Invalid/);
  });
});
