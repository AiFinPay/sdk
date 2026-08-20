import { describe, expect, it } from "vitest";
import { createGate, DETAIL_QUOTA_EXHAUSTED, DETAIL_RECEIPT_EXPIRED, DETAIL_VERIFY_FAILED, MemoryStore } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req } from "./helpers.js";

async function gateWith(overrides: Record<string, unknown> = {}) {
  const iss = await issuer();
  const gate = createGate({
    merchantId: MERCHANT,
    resource: "/api/search",
    tier: "standard",
    issuer: ISSUER,
    jwks: iss.jwks,
    store: new MemoryStore(),
    ...overrides,
  });
  return { gate, iss };
}

describe("the four answers a gate can give", () => {
  it("402s with a payable challenge when there is no receipt at all", async () => {
    const { gate } = await gateWith();
    const r = await gate(req("/api/search"));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(402);
    // The 402 is the only documentation an agent gets, so it carries the whole
    // purchase path — not just a refusal.
    expect(r.body.error).toBe("AIFP-402");
    expect(r.body.merchant_id).toBe(MERCHANT);
    expect(r.body.resource).toBe("/api/search");
    expect(r.body.unit_weight).toBe(1);
    expect(r.body.unit_price_usd).toBe("0.0005");
    expect(r.body.protocol_fee_bps).toBe(100);
    expect(r.body.how_to_pay?.length).toBe(4);
  });

  it("serves a valid receipt and reports the units left after this call", async () => {
    const { gate, iss } = await gateWith();
    const token = await iss.sign({ unit_quota: 10 });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.aifp.mode).toBe("paid");
    expect(r.aifp.weight).toBe(1);
    expect(r.aifp.used).toBe(1);
    expect(r.aifp.remaining).toBe(9);
    expect(r.headers["AIFP-Quota-Remaining"]).toBe("9");
    expect(r.aifp.agent).toBe("agt_test");
  });

  it("decrements the same batch across calls and 402s the call after the last unit", async () => {
    const { gate, iss } = await gateWith();
    const token = await iss.sign({ unit_quota: 3 });
    const call = () => gate(req("/api/search", { "AIFP-Receipt": token }));

    expect((await call()).status).toBe(200);
    expect((await call()).status).toBe(200);
    const last = await call();
    expect(last.ok).toBe(true);
    if (last.ok) expect(last.headers["AIFP-Quota-Remaining"]).toBe("0");

    const exhausted = await call();
    expect(exhausted.ok).toBe(false);
    if (exhausted.ok) return;
    // Exhausted is 402, not 403: the agent did nothing wrong, it simply has to
    // buy more. A 403 would tell it to give up.
    expect(exhausted.status).toBe(402);
    expect(exhausted.body.detail).toBe(DETAIL_QUOTA_EXHAUSTED);
  });

  it("charges the route's weight, not one unit per call", async () => {
    const { gate, iss } = await gateWith({ tier: "premium" });
    const token = await iss.sign({ unit_quota: 25, tier: "premium" });

    const first = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(first.ok).toBe(true);
    if (first.ok) {
      expect(first.aifp.weight).toBe(10);
      expect(first.aifp.remaining).toBe(15);
    }
  });
});

describe("receipts the gate must refuse", () => {
  it("403s a receipt minted for a different merchant", async () => {
    const { iss } = await gateWith();
    const gate = createGate({
      merchantId: "mrch_other",
      resource: "/api/search",
      issuer: ISSUER,
      jwks: iss.jwks,
      store: new MemoryStore(),
    });
    // Correctly signed by the real issuer — only the audience is wrong. This is
    // the case that stops one merchant's batch being spent at another's API.
    const token = await iss.sign({ aud: MERCHANT, unit_quota: 100 });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.body.detail).toBe(DETAIL_VERIFY_FAILED);
  });

  it("403s a receipt from an unknown issuer", async () => {
    const { gate, iss } = await gateWith();
    const token = await iss.sign({ iss: "https://evil.example", unit_quota: 100 });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });

  it("402s — not 403s — an expired receipt, because expiry is recoverable", async () => {
    const { gate, iss } = await gateWith({ clockToleranceSec: 0 });
    const token = await iss.sign({ unit_quota: 100, expiresInSec: -60 });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(402);
    expect(r.body.detail).toBe(DETAIL_RECEIPT_EXPIRED);
    // and the challenge still tells it how to buy the next batch
    expect(r.body.how_to_pay?.length).toBe(4);
  });

  it("403s a receipt scoped to a different path, naming both paths", async () => {
    const { gate, iss } = await gateWith();
    const token = await iss.sign({ resource: "/api/other", scope: "exact", unit_quota: 100 });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.body.detail).toContain("/api/other");
    expect(r.body.detail).toContain("/api/search");
  });

  it("403s a garbage receipt without leaking the parse error to the agent", async () => {
    const { gate } = await gateWith();
    const r = await gate(req("/api/search", { "AIFP-Receipt": "not.a.jwt" }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.body.detail).toBe(DETAIL_VERIFY_FAILED);
  });

  it("does not spend a unit on a refused call", async () => {
    const store = new MemoryStore();
    const { gate, iss } = await gateWith({ store });
    const token = await iss.sign({ resource: "/api/other", unit_quota: 5, receipt_id: "rcpt_fixed" });

    await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(await store.get("aifp:used:rcpt_fixed")).toBe(null);
  });
});

describe("legacy and open resources", () => {
  it("converts a legacy request `quota` at the tier weight it was priced for", async () => {
    const { gate, iss } = await gateWith({ tier: "complex", weight: 4 });
    // 5 requests × complex(4) = 20 billing units
    const token = await iss.sign({ quota: 5, tier: "complex" });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aifp.unit_quota).toBe(20);
  });

  it("serves a paywall_enabled:false resource without touching any batch", async () => {
    const registry = {
      match: () => ({
        id: "res_000000000000",
        route_pattern: "/public/ping",
        type: "api" as const,
        paywall_enabled: false,
        tier: null,
        unit_weight: null,
        name: null,
        created_at: new Date().toISOString(),
      }),
    };
    const { gate } = await gateWith({ registry, resource: undefined });

    const r = await gate(req("/public/ping"));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.aifp.mode).toBe("open");
    expect(r.headers["AIFP-Paywall"]).toBe("off");
    // A free route must not quietly eat an agent's prepaid units either.
    expect(r.aifp.weight).toBe(0);
  });

  it("keeps an unregistered path PAYWALLED rather than free", async () => {
    const registry = { match: () => null };
    const { gate } = await gateWith({ registry });

    const r = await gate(req("/api/undeclared"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(402);
  });
});
