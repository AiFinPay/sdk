import { describe, expect, it } from "vitest";
import { DEFAULT_TELEMETRY_URL, modeFromEnv, runtimeEnabled, urlFromEnv } from "../src/env.js";

describe("opt-in contract", () => {
  it("defaults to off", () => {
    expect(modeFromEnv({})).toBe("off");
    expect(runtimeEnabled(modeFromEnv({}))).toBe(false);
  });

  it.each(["off", "on", "read-only", "install"] as const)("accepts %s", (mode) => {
    expect(modeFromEnv({ AIFINPAY_TELEMETRY: ` ${mode.toUpperCase()} ` })).toBe(mode);
  });

  it("treats anything unrecognised as off", () => {
    for (const value of ["1", "true", "yes", "enabled", "onn", ""]) {
      expect(modeFromEnv({ AIFINPAY_TELEMETRY: value })).toBe("off");
    }
  });

  it("allows runtime events only in on and read-only; install does not leak into runtime", () => {
    expect(runtimeEnabled("on")).toBe(true);
    expect(runtimeEnabled("read-only")).toBe(true);
    expect(runtimeEnabled("install")).toBe(false);
    expect(runtimeEnabled("off")).toBe(false);
  });
});

describe("destination", () => {
  it("defaults to the AiFinPay gateway", () => {
    expect(urlFromEnv({})).toBe(DEFAULT_TELEMETRY_URL);
    expect(DEFAULT_TELEMETRY_URL).toBe("https://telemetry.aifinpay.io/v1/agent");
  });

  it("honours an https override and loopback http", () => {
    expect(urlFromEnv({ AIFINPAY_TELEMETRY_URL: "https://staging.example.com/v1/agent" })).toBe(
      "https://staging.example.com/v1/agent"
    );
    expect(urlFromEnv({ AIFINPAY_TELEMETRY_URL: "http://127.0.0.1:4001/v1/agent" })).toBe(
      "http://127.0.0.1:4001/v1/agent"
    );
  });

  it("disables sending for an unusable override instead of falling back", () => {
    for (const bad of ["http://example.com/v1/agent", "ftp://x", "not a url", "https://user:pw@example.com/"]) {
      expect(urlFromEnv({ AIFINPAY_TELEMETRY_URL: bad })).toBeNull();
    }
  });
});
