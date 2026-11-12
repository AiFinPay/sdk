import { describe, expect, it } from "vitest";
import { MAX_TREASURY_BPS, protocolFeeUnits, quotedFeeBps } from "../src/feeBps.js";

describe("quotedFeeBps", () => {
  it("reads the fee from fee_bps or fee_policy", () => {
    expect(quotedFeeBps({ fee_bps: 250 })).toBe(250);
    expect(quotedFeeBps({ fee_policy: { treasury_bps: 175 } })).toBe(175);
    expect(quotedFeeBps({ fee_bps: 320, fee_policy: { treasury_bps: 320 } })).toBe(320);
    expect(quotedFeeBps({ fee_bps: MAX_TREASURY_BPS })).toBe(MAX_TREASURY_BPS);
  });
  it.each([
    ["absent", {}],
    ["zero", { fee_bps: 0 }],
    ["above the contract cap", { fee_bps: MAX_TREASURY_BPS + 1 }],
    ["fractional", { fee_bps: 1.5 }],
    ["a string", { fee_bps: "100" }],
    ["contradictory", { fee_bps: 100, fee_policy: { treasury_bps: 250 } }],
    ["a bad policy beside a good fee_bps", { fee_bps: 100, fee_policy: { treasury_bps: -1 } }],
  ])("refuses a fee that is %s", (_name, quote) => {
    expect(quotedFeeBps(quote)).toBeUndefined();
  });
  it("splits with integer floor", () => {
    expect(protocolFeeUnits(100_000n, 250)).toBe(2_500n);
    expect(protocolFeeUnits(399n, 250)).toBe(9n);
  });
});
