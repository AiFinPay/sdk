import { describe, expect, it } from "vitest";
import {
  BASE_UNIT_PRICE_USD,
  PROTOCOL_FEE_BPS,
  TIER_WEIGHTS,
  UNIT_PRICE_USD,
  minRequestsForTier,
  weightForTier,
} from "../src/index.js";

describe("the tier-weight invariant", () => {
  it("weight === unit price ÷ base price, for every tier", () => {
    // This equality is what makes a widened receipt scope safe: a batch spent
    // across tiers drains at each path's real rate only because every tier
    // costs the same money per billing unit. The server asserts the same thing
    // on its side; if either drifts, agents are over- or under-charged.
    for (const tier of ["standard", "complex", "premium"] as const) {
      const ratio = Number(UNIT_PRICE_USD[tier]) / Number(BASE_UNIT_PRICE_USD);
      expect(TIER_WEIGHTS[tier]).toBe(ratio);
    }
  });

  it("complex is 4 — the stale '6' in older comments would overcharge by 50%", () => {
    expect(TIER_WEIGHTS.complex).toBe(4);
    expect(TIER_WEIGHTS.standard).toBe(1);
    expect(TIER_WEIGHTS.premium).toBe(10);
  });

  it("prices are the protocol's three fixed settings", () => {
    expect(UNIT_PRICE_USD).toEqual({ standard: "0.0005", complex: "0.002", premium: "0.005" });
    expect(PROTOCOL_FEE_BPS).toBe(100);
  });

  it("an unknown or absent tier meters exactly 1 unit per call", () => {
    expect(weightForTier(undefined)).toBe(1);
    expect(weightForTier("enterprise")).toBe(1);
  });

  it("min_requests clears the $0.10 batch floor at every tier", () => {
    expect(minRequestsForTier("standard")).toBe(200);
    expect(minRequestsForTier("complex")).toBe(50);
    expect(minRequestsForTier("premium")).toBe(20);
    for (const tier of ["standard", "complex", "premium"] as const) {
      expect(minRequestsForTier(tier) * Number(UNIT_PRICE_USD[tier])).toBeGreaterThanOrEqual(0.1);
    }
  });
});
