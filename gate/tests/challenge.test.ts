import { describe, expect, it } from "vitest";
import { buildChallenge } from "../src/index.js";

describe("the 402 body", () => {
  it("carries every field the hosted gateway emits", () => {
    // An agent that meets this merchant for the first time has no docs, no key
    // and no account. This object is the entire onboarding.
    const body = buildChallenge({
      merchantId: "mrch_acme",
      resource: "/api/search",
      tier: "complex",
      weight: 4,
    });

    expect(Object.keys(body).sort()).toEqual(
      [
        "detail",
        "error",
        "how_to_pay",
        "merchant_id",
        "min_requests",
        "no_minimum_fee",
        "no_wallet",
        "protocol",
        "protocol_fee_bps",
        "resource",
        "settlement_terms_from",
        "tier",
        "unit_price_usd",
        "unit_weight",
      ].sort(),
    );
    expect(body.error).toBe("AIFP-402");
    expect(body.protocol).toBe("AIFP-1");
    expect(body.unit_weight).toBe(4);
    expect(body.unit_price_usd).toBe("0.002");
    expect(body.min_requests).toBe(50);
    // 1% of the gross the agent pays, withheld from it — the merchant
    // receives 99%. (Unified-economics ТЗ 2026-08-23; this comment said
    // "on top, never deducted" and described the superseded model.)
    expect(body.protocol_fee_bps).toBe(100);

    // Added 2026-08-27. An external QA pass on a partner integration read this
    // 402 and reported "no chain ID, no token, no merchant address, no expiry"
    // as a protocol defect. It is not — accepted_chains is derived per merchant
    // from pay_to and accepted_assets drops POL when there is no live rate, so
    // a static challenge cannot carry either without sometimes promising a
    // settlement the quote will refuse. But the 402 never said WHERE they were,
    // which made that reading a fair one. Now it does.
    expect(body.settlement_terms_from).toContain("/v1/quote");
    expect(body.settlement_terms_from).toContain("accepted_chains");
    expect(body.settlement_terms_from).toContain("expiry");
    // No per-transaction floor is the reason a $0.0005 call is a product.
    expect(body.no_minimum_fee).toBe(true);
  });

  it("spells the four steps from 402 to 200, with this merchant's own ids", () => {
    const body = buildChallenge({
      merchantId: "mrch_acme",
      resource: "/api/search",
      tier: "standard",
      weight: 1,
    });
    expect(body.how_to_pay?.[0]).toContain('"merchant_id":"mrch_acme"');
    expect(body.how_to_pay?.[0]).toContain("/v1/quote");
    expect(body.how_to_pay?.[2]).toContain("/v1/pay");
    expect(body.how_to_pay?.[3]).toContain("AIFP-Receipt");
  });

  it("lets a merchant with overridden prices pass its own numbers through", () => {
    const body = buildChallenge({
      merchantId: "mrch_acme",
      resource: "/api/search",
      tier: "standard",
      weight: 1,
      unitPriceUsd: "0.005",
      minRequests: 20,
    });
    expect(body.unit_price_usd).toBe("0.005");
    expect(body.min_requests).toBe(20);
  });
});
