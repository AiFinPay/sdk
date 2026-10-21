import { describe, expect, it } from "vitest";
import { DEFAULT_MAX_GAS_POL, validatePaymentConfig } from "../src/config.js";
const valid = {
  paymentsEnabled: true,
  maxAmountUsd: 0.1,
  dailyAmountUsd: 1,
  maxGasPol: "0.05",
  gatewayOrigins: ["https://merchant.example"],
};
describe("operator payment config", () => {
  it("requires owner enablement, both USD limits and bounded gas", () => {
    expect(validatePaymentConfig(valid)).toBe(50_000_000_000_000_000n);
    for (const patch of [
      { paymentsEnabled: false },
      { maxAmountUsd: undefined },
      { dailyAmountUsd: undefined },
      // An empty list is a config bug's shape, never "any origin".
      { gatewayOrigins: [] },
      { devMode: true },
    ])
      expect(() => validatePaymentConfig({ ...valid, ...patch })).toThrow();
  });
  // 2.12.1: a first payment needs no env. Unset origins mean the origin of the
  // URL being fetched (payable-fetch.ts decides per call), and Polygon has a
  // built-in gas cap; another chain still names its own.
  it("accepts unset origins and applies the Polygon gas cap when the owner set none", () => {
    expect(DEFAULT_MAX_GAS_POL).toBe("0.3");
    expect(validatePaymentConfig({ ...valid, gatewayOrigins: undefined })).toBe(50_000_000_000_000_000n);
    expect(validatePaymentConfig({ ...valid, maxGasPol: undefined })).toBe(300_000_000_000_000_000n);
    expect(validatePaymentConfig({ ...valid, maxGasPol: undefined, maxGas: "0.1" })).toBe(100_000_000_000_000_000n);
    expect(() => validatePaymentConfig({ ...valid, maxGasPol: undefined, payChain: "base" })).toThrow(
      /AIFINPAY_MAX_GAS must be a positive decimal/
    );
  });
  it.each([NaN, Infinity, 0, -1])("rejects invalid USD limit %s", (value) => {
    expect(() => validatePaymentConfig({ ...valid, maxAmountUsd: value })).toThrow();
    expect(() => validatePaymentConfig({ ...valid, dailyAmountUsd: value })).toThrow();
  });
  it.each(["0", "-1", "NaN", "1e2", "0.0000000000000000001"])("rejects invalid gas %s", (maxGasPol) => {
    expect(() => validatePaymentConfig({ ...valid, maxGasPol })).toThrow();
  });
  it.each([
    "http://merchant.example",
    "https://merchant.example/path",
    "https://*.example",
    "https://user:pass@example.com",
  ])("rejects unsafe origin %s", (origin) => {
    expect(() => validatePaymentConfig({ ...valid, gatewayOrigins: [origin] })).toThrow(/exact HTTPS origins/);
  });
});
