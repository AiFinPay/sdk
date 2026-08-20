// ──────────────────────────────────────────────────────────────────────────
// A valid signature is not a licence to spend.
//
// The issuer signs at least two kinds of token with ONE key and ONE audience:
// a quota receipt, which buys calls, and a per-action billing receipt
// (`typ_aifp: "action"`), which is proof that a call was already served and
// already charged. jose verifies both, because verification answers "did we
// sign this", never "what is it for".
//
// Found post-publish, in 0.1.0, so these tests exist to keep it dead. Every one
// of them describes money leaving a merchant, not a policy preference.
// ──────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import { createGate, MemoryStore } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req, signActionReceipt } from "./helpers.js";

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

describe("tokens the issuer signs but the gate must not spend", () => {
  it("refuses an action receipt, which is proof of a PAST charge", async () => {
    const { gate, iss } = await gateWith();
    // Genuinely signed by the issuer, genuinely addressed to this merchant,
    // genuinely for this exact resource. Everything a signature check looks at
    // is correct; it is simply not money.
    const token = await signActionReceipt(iss.privateKey, { resource: "/api/search" });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));

    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.body.detail).toContain("action");
    expect(r.body.detail).toContain("not spendable");
  });

  it("does not serve even the FIRST action receipt", async () => {
    // The regression that mattered. With no `quota` the limit falls back to 1,
    // and with no `receipt_id` the meter counted at `used:undefined` — so the
    // first such request came back 200 and the merchant served a paid call for
    // nothing. An agent is handed one of these on every call it pays for, so
    // the supply is unlimited and free.
    const { gate, iss } = await gateWith();
    const token = await signActionReceipt(iss.privateKey);

    for (let i = 0; i < 3; i++) {
      const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
      expect(r.ok, `call ${i + 1} must not be served`).toBe(false);
    }
  });

  it("refuses an unknown token kind rather than treating it as a quota receipt", async () => {
    // Allow-list, not deny-list: a token type added to the issuer next year must
    // be refused by a gate compiled today. Merchants pin versions for years.
    const { gate, iss } = await gateWith();
    const token = await iss.sign({ typ_aifp: "refund", unit_quota: 100 });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.body.detail).toContain("refund");
  });

  it("accepts a quota receipt that spells its type out explicitly", async () => {
    // The allow-list must not break the day the issuer starts labelling the
    // token it has always issued.
    const { gate, iss } = await gateWith();
    const token = await iss.sign({ typ_aifp: "quota", unit_quota: 5 });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(true);
  });
});

describe("claims the meter cannot work without", () => {
  it("refuses a receipt with no receipt_id instead of metering at used:undefined", async () => {
    const { gate, iss } = await gateWith();
    const token = await iss.sign({ receipt_id: null, unit_quota: 100 });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(403);
    expect(r.body.detail).toContain("receipt_id");
  });

  it("does not let two different id-less receipts share one counter", async () => {
    // The shape of the old bug, which was not merely 'fails open'. Every
    // id-less receipt collapsed onto the single key `used:undefined`, so agent
    // A's request could be refused because agent B had presented a malformed
    // receipt — a cross-agent counter keyed on a value no receipt can own.
    const { gate, iss } = await gateWith();
    const a = await iss.sign({ receipt_id: null, unit_quota: 100 });
    const b = await iss.sign({ receipt_id: null, unit_quota: 100 });

    const ra = await gate(req("/api/search", { "AIFP-Receipt": a }));
    const rb = await gate(req("/api/search", { "AIFP-Receipt": b }));

    // Both refused, and refused for their OWN defect — not because the other
    // one went first.
    expect(ra.ok).toBe(false);
    expect(rb.ok).toBe(false);
    if (ra.ok || rb.ok) return;
    expect(rb.body.detail).toBe(ra.body.detail);
  });

  it("refuses a single-use receipt with no nonce rather than keying on undefined", async () => {
    const { gate, iss } = await gateWith({ replay: "always" });
    const token = await iss.sign({ nonce: null, unit_quota: 100 });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.body.detail).toContain("nonce");
  });
});
