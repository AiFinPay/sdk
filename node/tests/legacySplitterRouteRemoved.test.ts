import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Replaces splitterVersionDetect.test.ts.
 *
 * That test asserted the precedence between a server-declared splitter version
 * and on-chain detection — the mechanism that let a 402 challenge steer the SDK
 * onto a v1.1 `payMatic` or v1.2 `payNative` ABI. The remediation removed the
 * mechanism: settlement is v1.3 fee-on-top only, against a splitter resolved
 * from the verified registry rather than from the challenge.
 *
 * The old test cannot be updated, because the behaviour it described is the
 * behaviour that was removed. This asserts the removal instead, so the legacy
 * route cannot reappear during a later merge without a test turning red.
 */
const source = readFileSync(new URL("../src/unifiedAgent.ts", import.meta.url), "utf8");

describe("legacy splitter route stays removed", () => {
  it("has no server-steered version selection", () => {
    expect(source).not.toMatch(/detectSplitterVersion/);
    // The old shape: take the challenge's version, else detect it.
    expect(source).not.toMatch(/splitter_version[\s\S]{0,200}\?\?\s*await this\.detect/);
    expect(source).not.toMatch(/splitterVersion\s*\?\?\s*await this\.detect/);
  });

  it("has no v1.1 fee-inclusive entrypoint", () => {
    expect(source).not.toMatch(/functionName:\s*"payMatic"/);
    expect(source).not.toMatch(/SPLITTER_PAY_MATIC_ABI/);
  });

  it("settles only through the validated v1.3 fee-on-top path", () => {
    const writes = source.match(/functionName:\s*"pay\w+"/g) ?? [];
    expect(writes.length).toBeGreaterThan(0);
    for (const write of writes) expect(write).toBe('functionName: "payNative"');
    // Every settlement is preceded by registry validation of the quote.
    expect(source).toMatch(/validateQuotedNativePayment/);
    expect(source).toMatch(/validateRuntimePaymentTarget/);
  });

  it("routes the AIFP-1 flow through the same validated settlement", () => {
    // fetchPaid must not gain its own writeContract call.
    const wiring = source.slice(source.indexOf("async fetchPaid("));
    expect(wiring).toMatch(/this\.settleSplitterNative\(/);
    expect(wiring.slice(0, wiring.indexOf("return aifp1Fetch"))).not.toMatch(/writeContract/);
  });
});
