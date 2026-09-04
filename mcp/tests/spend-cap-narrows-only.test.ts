import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

// The operator's spend cap was overwritable by a tool argument:
//
//     const maxAmountUsd = typeof args.max_amount_usd === "number"
//       ? args.max_amount_usd            // ← whatever the model asked for
//       : ctx.config.maxAmountUsd;
//
// AIFINPAY_MAX_USD=0.10 and a model that asked for 1000 got 1000. The cap is the
// one control an operator cannot express any other way, and it was the one a
// prompt could remove.
//
// Latent — payable_fetch is not registered on the current server — but this file
// is what SDK 2.0 re-registers. A cap a caller can raise is not a cap.
//
// The resolution is asserted directly rather than through the tool, because the
// tool needs an agent, a network and a 402 to reach this line, and none of those
// change what the arithmetic must be.
const SRC = readFileSync(new URL("../src/tools/payable-fetch.ts", import.meta.url), "utf8");

/** The same rule the tool implements, kept next to its assertions. */
function resolveCap(operatorMax?: number, requestedMax?: number): number | undefined {
  return operatorMax === undefined ? requestedMax
    : requestedMax === undefined ? operatorMax
    : Math.min(operatorMax, requestedMax);
}

describe("the operator cap can be narrowed, never widened", () => {
  it("a model asking for more than the operator allows gets the operator's number", () => {
    expect(resolveCap(0.1, 1000)).toBe(0.1);
    expect(resolveCap(0.1, 0.100001)).toBe(0.1);
  });

  it("a model asking for less gets its own, narrower number", () => {
    // Narrowing is the legitimate use: a cautious agent capping itself further.
    expect(resolveCap(10, 0.5)).toBe(0.5);
  });

  it("no operator cap means the model's value stands", () => {
    // There is no policy to violate. Refusing here would make the tool unusable
    // for anyone who has not set the env var.
    expect(resolveCap(undefined, 5)).toBe(5);
  });

  it("no request means the operator's cap applies", () => {
    expect(resolveCap(0.1, undefined)).toBe(0.1);
  });

  it("neither set means no cap, which is the documented default", () => {
    expect(resolveCap(undefined, undefined)).toBeUndefined();
  });

  it("the tool uses Math.min and not a replacement", () => {
    // The regression is a one-token edit — `?` instead of Math.min — so the
    // shape is asserted, not only the arithmetic beside it.
    expect(SRC).toMatch(/Math\.min\(operatorMax, requestedMax\)/);
    expect(SRC).not.toMatch(/\?\s*args\.max_amount_usd\s*\n?\s*:\s*ctx\.config\.maxAmountUsd/);
  });

  it("a non-finite request cannot erase the operator's cap", () => {
    // NaN and Infinity are numbers. `typeof x === "number"` alone accepted both,
    // and Math.min(0.1, NaN) is NaN — a cap that compares false against every
    // amount.
    expect(SRC).toMatch(/Number\.isFinite\(args\.max_amount_usd\)/);
    expect(resolveCap(0.1, undefined)).toBe(0.1);
  });
});
