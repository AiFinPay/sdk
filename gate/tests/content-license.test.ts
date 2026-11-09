// A receipt carries the content licence it was bought under (`lic`, AIFINP-262).
// The gate sends it with the content that receipt unlocked, and only then.
import { describe, expect, it } from "vitest";
import { createGate, licenseHeaders, MemoryStore, receiptLicense } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req } from "./helpers.js";

const LIC = { id: "clic_" + "ab".repeat(12), rev: 2, v: "2.0", sha256: "3".repeat(64), confirmed: true };
const URL_BASE = `https://api.aifinpay.io/v1/merchants/${MERCHANT}/license/2`;

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

describe("content licence delivery", () => {
  it("a paid answer carries the licence from the receipt", async () => {
    const { gate, iss } = await gateWith();
    const token = await iss.sign({ unit_quota: 3, lic: LIC });
    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(true);
    expect(r.headers["AIFP-License"]).toBe(`id=${LIC.id}; rev=2; sha256=${LIC.sha256}; url="${URL_BASE}"`);
    expect(r.headers.Link).toBe(`<${URL_BASE}/text>; rel="license"`);
    if (r.ok) expect(r.aifp.license).toEqual(LIC);
  });

  it("a receipt without a licence adds nothing", async () => {
    const { gate, iss } = await gateWith();
    const r = await gate(req("/api/search", { "AIFP-Receipt": await iss.sign({ unit_quota: 3 }) }));
    expect(r.ok).toBe(true);
    expect(r.headers["AIFP-License"]).toBeUndefined();
    expect(r.headers.Link).toBeUndefined();
    if (r.ok) expect(r.aifp.license).toBeUndefined();
  });

  it("a refusal never carries it", async () => {
    const { gate, iss } = await gateWith();
    const none = await gate(req("/api/search"));
    expect(none.status).toBe(402);
    expect(none.headers["AIFP-License"]).toBeUndefined();
    const other = await iss.sign({ unit_quota: 3, lic: LIC, aud: "mrch_other" });
    const refused = await gate(req("/api/search", { "AIFP-Receipt": other }));
    expect(refused.status).toBe(403);
    expect(refused.headers["AIFP-License"]).toBeUndefined();
    const spent = await iss.sign({ unit_quota: 1, lic: LIC });
    await gate(req("/api/search", { "AIFP-Receipt": spent }));
    const drained = await gate(req("/api/search", { "AIFP-Receipt": spent }));
    expect([402, 403]).toContain(drained.status);
    expect(drained.headers["AIFP-License"]).toBeUndefined();
  });

  it("the URL is the gate's own, whatever the token says", async () => {
    const { gate, iss } = await gateWith({ apiBase: "https://api.example.test/" });
    const token = await iss.sign({ unit_quota: 3, lic: { ...LIC, url: "https://evil.example/x" } });
    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.headers["AIFP-License"]).toContain(`url="https://api.example.test/v1/merchants/${MERCHANT}/license/2"`);
    expect(r.headers["AIFP-License"]).not.toContain("evil");
  });

  it("a malformed claim is ignored, never echoed", () => {
    for (const bad of [
      null,
      "x",
      {},
      { ...LIC, id: "lic_1" },
      { ...LIC, rev: 0 },
      { ...LIC, rev: 1.5 },
      { ...LIC, sha256: "Z".repeat(64) },
    ])
      expect(receiptLicense(bad)).toBeUndefined();
    expect(licenseHeaders("https://api.aifinpay.io", MERCHANT, undefined)).toEqual({});
  });
});
