// A payment prompt that states an amount without the terms is one a careful
// agent should refuse and a careless one over-pays on.
//
// Agent-flow audit, point 6: the 402/quote answers "1.06 POL" and leaves the
// agent to work out FOR WHAT — how many requests, which paths, until when, at
// what fee. describeQuote assembles the fields the quote already carries into
// the sentence a reasonable payer needs before signing.
import { describe, it, expect } from "vitest";
import { describeQuote, type Aifp1Quote } from "../src/index.js";

const BASE: Aifp1Quote = {
  quote_id: "qt_1", merchant_id: "mrch_raters", resource: "/api/agent/genres",
  scope: "exact", tier: "standard", unit_price: "0.0005",
  requests: 200, units: 200, unit_quota: 200, amount: "0.10", currency: "USD",
  accepted_assets: ["POL"], accepted_chains: ["polygon"], pay_to: { evm: "0x11" },
  native_settlement: {
    asset: "POL", decimals: 18, rate_usd: "0.20",
    total_wei: "1055375555391386000", merchant_wei: "1044821799837472120",
    treasury_wei: "10553755553913860", creator_wei: "0",
  },
  settlement: {
    batch_units: "200", total_units: "100000", gross_units: "100000",
    payer_total_units: "100000", merchant_units: "99000",
    protocol_fee_units: "1000", creator_units: "0", fee_on_top: false,
  },
  nonce: "n1", expires_at: "2026-09-04T13:00:00Z",
};

describe("describeQuote", () => {
  it("says what, how much, how many, where, and until when — in one line", () => {
    const s = describeQuote(BASE);
    expect(s.headline).toContain("1.055375555391386 POL");   // the on-chain figure, not raw wei
    expect(s.headline).toContain("$0.10");                   // and the USD, so both are visible
    expect(s.headline).toContain("200 requests");
    expect(s.headline).toContain("/api/agent/genres");
    expect(s.headline).toContain("2026-09-04T13:00:00Z");
  });

  it("states the fee as a rate, from the split — not just the total", () => {
    // 1000 of 100000 units = 100 bps = 1%. An agent seeing only the total can't
    // tell a 1% fee from a 50% one.
    const s = describeQuote(BASE);
    expect(s.fee_bps).toBe(100);
    expect(s.headline).toContain("1.00% fee");
  });

  it("makes scope legible — the field the wildcard bug proved everyone misreads", () => {
    expect(describeQuote(BASE).headline).toContain("/api/agent/genres");         // exact: the path
    const prefix = describeQuote({ ...BASE, scope: "prefix", resource: "/api/agent" });
    expect(prefix.headline).toContain("any path under /api/agent");
    const merchant = describeQuote({ ...BASE, scope: "merchant" });
    expect(merchant.headline).toContain("anything on mrch_raters");
  });

  it("converts wei with no float — the on-chain amount is exact", () => {
    // 1000000000000000000 wei = exactly 1 POL, not 0.9999999.
    const s = describeQuote({ ...BASE, native_settlement: { ...BASE.native_settlement!, total_wei: "1000000000000000000" } });
    expect(s.pay).toEqual({ amount: "1", asset: "POL" });
  });

  it("falls back to the USD amount when there is no native settlement", () => {
    const { native_settlement, ...noNative } = BASE;
    const s = describeQuote(noNative as Aifp1Quote);
    expect(s.pay).toBeNull();
    expect(s.headline).toContain("$0.10");
    expect(s.headline).not.toContain("POL");
  });

  it("singular 'request' for a one-call batch", () => {
    expect(describeQuote({ ...BASE, requests: 1 }).headline).toMatch(/1 request\b/);
  });
});
