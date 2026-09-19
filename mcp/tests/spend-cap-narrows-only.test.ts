import { describe, expect, it } from "vitest";
import { validatePaymentConfig } from "../src/config.js";
const valid = {
  paymentsEnabled: true,
  maxAmountUsd: 0.1,
  dailyAmountUsd: 1,
  maxGasPol: "0.05",
  gatewayOrigins: ["https://merchant.example"],
};
describe("operator payment config", () => {
  it("requires owner enablement, both USD limits, explicit origins and bounded gas", () => {
    expect(validatePaymentConfig(valid)).toBe(50_000_000_000_000_000n);
    for (const patch of [
      { paymentsEnabled: false },
      { maxAmountUsd: undefined },
      { dailyAmountUsd: undefined },
      { maxGasPol: undefined },
      { gatewayOrigins: undefined },
      { gatewayOrigins: [] },
      { devMode: true },
    ])
      expect(() => validatePaymentConfig({ ...valid, ...patch })).toThrow();
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
    expect(() => validatePaymentConfig({ ...valid, gatewayOrigins: [origin] })).toThrow();
  });
});
