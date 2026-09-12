import { describe, expect, it, vi } from "vitest";
import { MemoryStore, StoreCapacityError } from "../src/index.js";
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

  it("reclaims EXPIRED counters under the key cap instead of growing forever", async () => {
    // Bounded memory is still the goal — a long-lived fleet accumulates keys —
    // but only dead ones may be reclaimed. Here every counter is already dead
    // by the time the cap is reached, so the sweep alone clears the way.
    vi.useFakeTimers();
    try {
      const s = new MemoryStore({ maxKeys: 100 });
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 100; i++) await s.incrBy(`r${round}k${i}`, 1, 60_000);
        vi.advanceTimersByTime(61_000); // every counter in this round expires
      }
      let live = 0;
      for (let round = 0; round < 5; round++) {
        for (let i = 0; i < 100; i++) if ((await s.get(`r${round}k${i}`)) != null) live++;
      }
      expect(live).toBe(0);
      await s.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("THROWS rather than evict a live counter, because that is a silent refund", async () => {
    // This test replaces one that asserted the opposite — it pushed 500 live
    // counters through a cap of 100 and expected 400 of them to be gone. That
    // is the bug written down as the specification, and it shipped in 0.1.0.
    //
    // A counter IS the record of how much of a prepaid batch has been spent.
    // Delete it and `incrBy` starts from zero, so an exhausted 200-unit batch
    // becomes 200 fresh units. The old code deleted whichever counters were
    // closest to expiry — that is, the batches most nearly used up — which is
    // precisely the set where a reset is worth the most to an attacker. And it
    // was reachable on purpose: keys derive from receipt ids, so anyone able to
    // present distinct receipts could push the map to the cap and choose when
    // their own spent batch got forgotten.
    //
    // At capacity with nothing expired there is no right answer, so the store
    // stops inventing one and the merchant's own onStoreError decides.
    const s = new MemoryStore({ maxKeys: 10 });
    for (let i = 0; i < 10; i++) await s.incrBy(`live${i}`, 1, 3_600_000);

    await expect(s.incrBy("overflow", 1, 3_600_000)).rejects.toThrow(StoreCapacityError);

    // …and every existing counter still holds its true spend.
    for (let i = 0; i < 10; i++) expect(await s.get(`live${i}`)).toBe(1);
    await s.close();
  });

  it("keeps serving an ALREADY-tracked batch when full — the cap is on new keys", async () => {
    // Capacity must never refuse a batch the store is already metering.
    // Refusing those would 403 the merchants who paid, which is a worse
    // outcome than the memory ceiling exists to prevent.
    const s = new MemoryStore({ maxKeys: 3 });
    for (let i = 0; i < 3; i++) await s.incrBy(`live${i}`, 1, 3_600_000);

    expect(await s.incrBy("live0", 5, 3_600_000)).toBe(6);
    await expect(s.incrBy("brand_new", 1, 3_600_000)).rejects.toThrow(StoreCapacityError);
    await s.close();
  });

  it("does not hold the event loop open", () => {
    // A test runner or CLI that imports the gate must still be able to exit.
    const s = new MemoryStore();
    expect(typeof s.close).toBe("function");
  });
});
