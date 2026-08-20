// The load-bearing test. Everything else in this package is a convenience;
// this is the property a merchant is trusting us with.
import { describe, expect, it } from "vitest";
import { createGate, MemoryStore, type GateStore } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req } from "./helpers.js";

describe("a prepaid batch cannot be overspent under concurrency", () => {
  it("serves exactly unit_quota calls out of a burst, and hands out each remaining count once", async () => {
    const iss = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwks: iss.jwks,
      store: new MemoryStore(),
    });
    const token = await iss.sign({ unit_quota: 5 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => gate(req("/api/search", { "AIFP-Receipt": token }))),
    );

    const served = results.filter((r) => r.ok);
    const refused = results.filter((r) => !r.ok);
    expect(served.length).toBe(5);
    expect(refused.length).toBe(15);
    for (const r of refused) {
      if (r.ok) continue;
      expect(r.status).toBe(402);
      expect(r.body.detail).toBe("quota exhausted — prepay the next batch");
    }

    // No two winners may believe they got the same unit. If this set has a
    // duplicate, two responses went out against one paid unit.
    const remaining = served.map((r) => (r.ok ? Number(r.headers["AIFP-Quota-Remaining"]) : -1)).sort((a, b) => b - a);
    expect(remaining).toEqual([4, 3, 2, 1, 0]);
  });

  it("stops on the call that would CROSS the limit, not the one that lands on it", async () => {
    const iss = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/heavy",
      tier: "complex",
      weight: 3,
      issuer: ISSUER,
      jwks: iss.jwks,
      store: new MemoryStore(),
    });
    // 10 units at weight 3: used goes 3, 6, 9 — all ≤ 10 — and the fourth call
    // lands on 12, which is over. Three served, not four, and not two.
    const token = await iss.sign({ resource: "/api/heavy", unit_quota: 10 });

    const results = await Promise.all(
      Array.from({ length: 6 }, () => gate(req("/api/heavy", { "AIFP-Receipt": token }))),
    );
    expect(results.filter((r) => r.ok).length).toBe(3);
  });

  it("a check-then-increment store fails this same harness — which is why the contract is post-increment", async () => {
    // Deliberately wrong adapter: it reads, yields to the event loop, then
    // writes. This is what "just use get and set" looks like, and it is the
    // most natural thing for someone to write against a store whose SDK has no
    // atomic add.
    const counters = new Map<string, number>();
    const racyStore: GateStore = {
      async incrBy(key, by) {
        const cur = counters.get(key) ?? 0;
        await new Promise((r) => setImmediate(r)); // the window every request walks through
        counters.set(key, cur + by);
        return cur + by;
      },
    };

    const iss = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwks: iss.jwks,
      store: racyStore,
    });
    const token = await iss.sign({ unit_quota: 5 });

    const results = await Promise.all(
      Array.from({ length: 20 }, () => gate(req("/api/search", { "AIFP-Receipt": token }))),
    );
    // 20 calls served against a 5-unit batch: a 300% giveaway, silent, with a
    // 200 on every one of them.
    expect(results.filter((r) => r.ok).length).toBeGreaterThan(5);
  });
});
