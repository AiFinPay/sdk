import { describe, expect, it } from "vitest";
import { DEFAULT_TELEMETRY_URL, modeFromEnv, resolveMode, runtimeEnabled, urlFromEnv } from "../src/env.js";

describe("consent contract", () => {
  type Row = [label: string, env: Record<string, string>, mode: string, byDefault: boolean];
  const rows: Row[] = [
    ["unset", {}, "on", true],
    ["empty", { AIFINPAY_TELEMETRY: "" }, "on", true],
    ["blank", { AIFINPAY_TELEMETRY: "  " }, "on", true],
    ["on", { AIFINPAY_TELEMETRY: " ON " }, "on", false],
    ["read-only", { AIFINPAY_TELEMETRY: "Read-Only" }, "read-only", false],
    ["off", { AIFINPAY_TELEMETRY: "OFF" }, "off", false],
    ["0", { AIFINPAY_TELEMETRY: "0" }, "off", false],
    ["false", { AIFINPAY_TELEMETRY: "False" }, "off", false],
    ["no", { AIFINPAY_TELEMETRY: "NO" }, "off", false],
    ["install", { AIFINPAY_TELEMETRY: "install" }, "install", false],
    ["unrecognised 1", { AIFINPAY_TELEMETRY: "1" }, "off", false],
    ["unrecognised true", { AIFINPAY_TELEMETRY: "true" }, "off", false],
    ["unrecognised yes", { AIFINPAY_TELEMETRY: "yes" }, "off", false],
    ["typo", { AIFINPAY_TELEMETRY: "onn" }, "off", false],
    ["DO_NOT_TRACK=1", { DO_NOT_TRACK: "1" }, "off", false],
    ["DO_NOT_TRACK=true", { DO_NOT_TRACK: "TRUE" }, "off", false],
    ["DO_NOT_TRACK=0", { DO_NOT_TRACK: "0" }, "on", true],
    ["DO_NOT_TRACK empty", { DO_NOT_TRACK: "" }, "on", true],
    ["CI=true", { CI: "true" }, "off", false],
    ["CI=1", { CI: "1" }, "off", false],
    ["CI=any", { CI: "github" }, "off", false],
    ["CI=false", { CI: "false" }, "on", true],
    ["CI=0", { CI: "0" }, "on", true],
    ["CI empty", { CI: "" }, "on", true],
    ["install under CI", { AIFINPAY_TELEMETRY: "install", CI: "true" }, "off", false],
    ["install under DO_NOT_TRACK", { AIFINPAY_TELEMETRY: "install", DO_NOT_TRACK: "1" }, "off", false],
    ["on wins over DO_NOT_TRACK and CI", { AIFINPAY_TELEMETRY: "on", DO_NOT_TRACK: "1", CI: "true" }, "on", false],
    [
      "read-only wins over DO_NOT_TRACK and CI",
      { AIFINPAY_TELEMETRY: "read-only", DO_NOT_TRACK: "true", CI: "1" },
      "read-only",
      false,
    ],
  ];

  it.each(rows)("%s", (_label, env, mode, byDefault) => {
    expect(resolveMode(env)).toEqual({ mode, byDefault });
    expect(modeFromEnv(env)).toBe(mode);
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
    expect(DEFAULT_TELEMETRY_URL).toBe("https://api.aifinpay.io/v1/agent");
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
