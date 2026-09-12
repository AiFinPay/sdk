import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfigFromEnv } from "../src/config.js";

afterEach(() => vi.unstubAllEnvs());

describe("operator gateway origins", () => {
  it("keeps the SDK default when unset or empty", () => {
    for (const value of [undefined, "", " , "]) {
      vi.stubEnv("AIFINPAY_GATEWAY_ORIGINS", value);
      expect(loadConfigFromEnv().gatewayOrigins).toBeUndefined();
    }
  });

  it("accepts only the explicitly listed HTTPS origins", () => {
    vi.stubEnv("AIFINPAY_GATEWAY_ORIGINS", "https://dev.ratersapp.com, https://gateway.aifinpay.io");
    expect(loadConfigFromEnv().gatewayOrigins).toEqual([
      "https://dev.ratersapp.com", "https://gateway.aifinpay.io",
    ]);
  });

  it.each([
    "http://dev.ratersapp.com", "https://*.ratersapp.com", "*",
    "https://dev.ratersapp.com/genres", "https://dev.ratersapp.com?any=true",
    "https://dev.ratersapp.com#fragment", "https://user:pass@dev.ratersapp.com",
  ])("rejects unsafe or non-origin entries: %s", value => {
    vi.stubEnv("AIFINPAY_GATEWAY_ORIGINS", value);
    expect(() => loadConfigFromEnv()).toThrow(/AIFINPAY_GATEWAY_ORIGINS/);
  });
});
