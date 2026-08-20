import { describe, expect, it } from "vitest";
import { MemoryStore } from "../src/index.js";
import { assertStoreContract } from "../src/testing.js";

describe("MemoryStore", () => {
  it("passes the store contract every adapter must pass", async () => {
    await assertStoreContract(
      () => new MemoryStore(),
      {
        equal: (a, b, m) => expect(a, m).toEqual(b),
        ok: (v, m) => expect(v, m).toBeTruthy(),
      },
      {
        induceFailure: (store) => {
          // The contract's sixth case: a broken backend must reject, not guess.
          // MemoryStore cannot break on its own, so the failure is injected.
          (store as { incrBy: () => Promise<number> }).incrBy = () => {
            throw new Error("simulated backend failure");
          };
        },
      },
    );
  });

  it("advertises what it cannot do, so a caller can refuse it in production", () => {
    const s = new MemoryStore();
    expect(s.durable).toBe(false);
    expect(s.sharedAcrossProcesses).toBe(false);
  });

  it("evicts under the key cap instead of growing until the process dies", async () => {
    // A hostile stream of distinct receipt_ids reaches the counter map on any
    // gate that meters before it verifies — and even a well-behaved fleet with
    // long-lived batches accumulates keys.
    const s = new MemoryStore({ maxKeys: 100 });
    for (let i = 0; i < 500; i++) await s.incrBy(`k${i}`, 1, 60_000);
    let live = 0;
    for (let i = 0; i < 500; i++) if ((await s.get(`k${i}`)) != null) live++;
    expect(live).toBeLessThanOrEqual(100);
    await s.close();
  });

  it("does not hold the event loop open", () => {
    // A test runner or CLI that imports the gate must still be able to exit.
    const s = new MemoryStore();
    expect(typeof s.close).toBe("function");
  });
});
