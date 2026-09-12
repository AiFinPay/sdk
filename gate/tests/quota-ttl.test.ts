import { describe, expect, it } from "vitest";
import { createGate, type GateStore } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req } from "./helpers.js";

/** Records what the gate asked the store to do, so the counter's key and
 *  lifetime can be asserted directly rather than inferred from behaviour. */
function spyStore() {
  const calls: Array<{ key: string; by: number; ttlMs: number }> = [];
  const counters = new Map<string, number>();
  const store: GateStore = {
    async incrBy(key, by, ttlMs) {
      calls.push({ key, by, ttlMs });
      const next = (counters.get(key) ?? 0) + by;
      counters.set(key, next);
      return next;
    },
  };
  return { store, calls };
}

describe("the counter's lifetime is the receipt's lifetime", () => {
  it("keys the counter by receipt_id — not by agent, resource or path", async () => {
    // The receipt_id is the batch. Keying by agent would let one agent's two
    // batches share a counter; keying by resource would let a prefix-scoped
    // batch get a fresh allowance on every path it touches.
    const { store, calls } = spyStore();
    const iss = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwks: iss.jwks,
      store,
    });
    const token = await iss.sign({ unit_quota: 10, receipt_id: "rcpt_abcdef0123456789" });

    await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(calls[0].key).toBe("aifp:used:rcpt_abcdef0123456789");
    expect(calls[0].by).toBe(1);
  });

  it("sets a TTL that matches the receipt's remaining life and never exceeds it", async () => {
    const { store, calls } = spyStore();
    const iss = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwks: iss.jwks,
      store,
    });
    const token = await iss.sign({ unit_quota: 10, expiresInSec: 120 });

    await gate(req("/api/search", { "AIFP-Receipt": token }));
    const ttl = calls[0].ttlMs;
    // A counter that outlives its receipt refuses paid calls forever. One that
    // dies EARLY is worse: the whole batch becomes spendable a second time,
    // and nothing in the request path can see it happen.
    expect(ttl).toBeLessThanOrEqual(120_000);
    expect(ttl).toBeGreaterThan(110_000);
  });

  it("floors the TTL at 1s rather than asking for a non-positive expiry", async () => {
    const { store, calls } = spyStore();
    const iss = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      // Tolerance keeps a just-expired receipt verifiable, which is exactly the
      // window where exp*1000 - now goes negative.
      clockToleranceSec: 60,
      jwks: iss.jwks,
      store,
    });
    const token = await iss.sign({ unit_quota: 10, expiresInSec: -5 });

    await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(calls[0].ttlMs).toBe(1000);
  });

  it("honours a custom keyPrefix so one Redis can hold more than one tenant", async () => {
    const { store, calls } = spyStore();
    const iss = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwks: iss.jwks,
      keyPrefix: "tenant7:",
      store,
    });
    await gate(req("/api/search", { "AIFP-Receipt": await iss.sign({ unit_quota: 2, receipt_id: "rcpt_x" }) }));
    expect(calls[0].key).toBe("tenant7:used:rcpt_x");
  });
});
