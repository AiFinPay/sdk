import { afterEach, describe, expect, it, vi } from "vitest";
import { createGate, DETAIL_QUOTA_EXHAUSTED, MemoryStore, type GateStore, type Tier } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req } from "./helpers.js";

// Bugs found by the coverage pass on the Python port (AiFinPay/sdk#96), which
// this package shares: python-gate/tests/test_regressions.py holds the twins.

async function mount(resource: string, tier: Tier, store: GateStore, extra: Record<string, unknown> = {}) {
  const iss = await issuer();
  return createGate({ merchantId: MERCHANT, resource, tier, issuer: ISSUER, jwks: iss.jwks, store, ...extra });
}

const paid = (token: string) => ({ "AIFP-Receipt": token });

afterEach(() => vi.useRealTimers());

describe("P1: a spent batch stays spent inside the clock tolerance", () => {
  it("does not refill 10 s after exp, while the verifier still accepts the receipt", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const iss = await issuer();
    const gate = await mount("/api/search", "standard", new MemoryStore());
    const token = await iss.sign({ unit_quota: 2, expiresInSec: 60 });

    const statuses = [];
    for (let i = 0; i < 3; i++) statuses.push((await gate(req("/api/search", paid(token)))).status);
    expect(statuses).toEqual([200, 200, 402]);

    vi.setSystemTime(Date.now() + 70_000); // 10 s past exp, inside the 30 s tolerance
    const later = await gate(req("/api/search", paid(token)));
    expect(later.ok).toBe(false);
  });
});

describe("P5: an unknown mount tier is refused", () => {
  it("throws instead of pricing the mount as standard", async () => {
    await expect(mount("/api/x", "Premium" as Tier, new MemoryStore())).rejects.toThrow(/tier must be one of/);
  });
});

describe("P6: a call that does not fit does not consume the units that remain", () => {
  it("leaves all 5 remaining units spendable after a 10-unit call is refused", async () => {
    const store = new MemoryStore();
    const standard = await mount("/api/a", "standard", store);
    const premium = await mount("/api/premium", "premium", store);
    const iss = await issuer();
    const token = await iss.sign({ resource: "/api/*", unit_quota: 10 });

    for (let i = 0; i < 5; i++) expect((await standard(req("/api/a", paid(token)))).status).toBe(200);
    const refused = await premium(req("/api/premium", paid(token)));
    expect([refused.status, refused.body?.detail]).toEqual([402, DETAIL_QUOTA_EXHAUSTED]);

    const remaining = [];
    for (let i = 0; i < 5; i++) remaining.push((await standard(req("/api/a", paid(token)))).aifp?.remaining);
    expect(remaining).toEqual([4, 3, 2, 1, 0]);
    expect((await standard(req("/api/a", paid(token)))).status).toBe(402);
  });

  it("never serves more units than were paid for under concurrent mixed weights", async () => {
    const store = new MemoryStore();
    const standard = await mount("/api/a", "standard", store);
    const premium = await mount("/api/premium", "premium", store);
    const iss = await issuer();
    const token = await iss.sign({ resource: "/api/*", unit_quota: 25, receipt_id: "rcpt_mixed" });

    const results = await Promise.all(
      Array.from({ length: 300 }, (_, i) =>
        i % 3 === 0 ? premium(req("/api/premium", paid(token))) : standard(req("/api/a", paid(token)))
      )
    );
    const spent = results.filter((r) => r.ok).reduce((n, r) => n + (r.aifp?.weight ?? 0), 0);
    expect(spent).toBeLessThanOrEqual(25);
    expect(await store.get("aifp:used:rcpt_mixed")).toBe(spent);
  });

  it("keeps a single-use receipt usable after it was refused for weight", async () => {
    const store = new MemoryStore();
    const standard = await mount("/api/a", "standard", store);
    const premium = await mount("/api/premium", "premium", store);
    const iss = await issuer();
    const token = await iss.sign({ resource: "/api/*", unit_quota: 1 });

    expect((await premium(req("/api/premium", paid(token)))).status).toBe(402);
    expect((await standard(req("/api/a", paid(token)))).ok).toBe(true);
    expect((await standard(req("/api/a", paid(token)))).status).toBe(403);
  });
});

/** Fails once, on the quota counter, after the nonce was recorded. */
class UsedCounterBlip extends MemoryStore {
  failed = false;
  async incrBy(key: string, by: number, ttlMs: number): Promise<number> {
    if (key.includes(":used:") && !this.failed) {
      this.failed = true;
      throw new Error("redis blip");
    }
    return super.incrBy(key, by, ttlMs);
  }
}

describe("P7: a store blip after the nonce check does not burn a single-use receipt", () => {
  it("lets the agent's retry through when the gate fails closed", async () => {
    const gate = await mount("/api/search", "standard", new UsedCounterBlip());
    const token = await (await issuer()).sign({ unit_quota: 1 });
    expect((await gate(req("/api/search", paid(token)))).status).toBe(503);
    expect((await gate(req("/api/search", paid(token)))).ok).toBe(true);
    expect((await gate(req("/api/search", paid(token)))).status).toBe(403);
  });

  it("keeps the nonce spent when a fail-open gate served the call", async () => {
    const gate = await mount("/api/search", "standard", new UsedCounterBlip(), { onStoreError: "open" });
    const token = await (await issuer()).sign({ unit_quota: 1 });
    const served = await gate(req("/api/search", paid(token)));
    expect([served.ok, served.headers["AIFP-Meter"]]).toEqual([true, "degraded"]);
    expect((await gate(req("/api/search", paid(token)))).status).toBe(403);
  });
});
