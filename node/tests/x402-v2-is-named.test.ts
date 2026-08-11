// An endpoint we cannot pay must say why, and say the true why.
//
// Our standard-x402 facilitator targets x402 version 1, where the payment data
// is in the 402 body. The live standard is version 2 and puts it in a base64
// `payment-required` response header, leaving the body as `{}`. Tested against
// https://x402.org/protected on 2026-08-10.
//
// Two failures, and the second is the reason this test exists:
//
//   1. StandardX402Facilitator.detect() returns false, correctly — it cannot
//      read a v2 response.
//   2. CoinbaseX402Facilitator.detect() returns TRUE, incorrectly. It looks for
//      a `PAYMENT-REQUIRED` header, and v2 uses `payment-required` — the same
//      header, because HTTP header names are case-insensitive. So the wrong
//      facilitator won, and the agent failed deep inside Coinbase's buildAuth
//      with a message about Coinbase's internals.
//
// Anyone debugging that goes and reads the Coinbase facilitator, which has
// nothing to do with it. The guard in detectFacilitator runs before the loop
// so the error names the real cause.
//
// These assertions are expected to CHANGE when v2 support lands. That is the
// point: implementing v2 should break this test and force the message, the
// docstring and this file to be updated together.

import { describe, it, expect } from "vitest";
import { detectFacilitator } from "../src/facilitators/detect.js";
import { StandardX402Facilitator } from "../src/facilitators/standard-x402.js";
import { UnsupportedFacilitatorError } from "../src/errors.js";

/** A v2 402 in the shape the live standard actually sends. */
function v2Response(): Response {
  const payload = {
    x402Version: 2,
    error: "Payment required",
    resource: { url: "https://example.test/protected" },
    accepts: [
      {
        scheme: "exact",
        network: "eip155:84532",
        amount: "10000",
        asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
        payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
        maxTimeoutSeconds: 300,
        extra: { name: "USDC", version: "2" },
      },
    ],
  };
  return new Response("{}", {
    status: 402,
    headers: { "payment-required": Buffer.from(JSON.stringify(payload)).toString("base64") },
  });
}

describe("x402 version 2 is recognised as unsupported, not mis-detected", () => {
  it("isUnsupportedV2 sees a v2 response", () => {
    expect(StandardX402Facilitator.isUnsupportedV2(v2Response())).toBe(true);
  });

  it("does not fire on our own v1-shaped body", () => {
    // Our own 402s must keep working. A guard that swallowed those would take
    // the whole native flow down.
    const ours = new Response(JSON.stringify({ x402Version: 1, accepts: [] }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
    expect(StandardX402Facilitator.isUnsupportedV2(ours)).toBe(false);
  });

  it("does not fire on a non-402", () => {
    const ok = new Response("{}", { status: 200, headers: { "payment-required": "x" } });
    expect(StandardX402Facilitator.isUnsupportedV2(ok)).toBe(false);
  });

  it("detectFacilitator refuses a v2 endpoint and names the version", async () => {
    await expect(detectFacilitator(v2Response())).rejects.toThrow(UnsupportedFacilitatorError);
    await expect(detectFacilitator(v2Response())).rejects.toThrow(/version 2/);
  });

  it("the refusal beats Coinbase to it", async () => {
    // The specific regression: without the guard running first, Coinbase's
    // detector claims this response and the failure surfaces as its problem.
    let message = "";
    try {
      await detectFacilitator(v2Response());
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).not.toMatch(/coinbase/i);
    expect(message).toMatch(/payment-required/);
  });
});
