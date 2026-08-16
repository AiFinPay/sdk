// x402 protocol v2 interoperability tests.
//
// v2 HTTP transport carries PaymentRequired as base64 JSON in the
// PAYMENT-REQUIRED response header. The retry carries PaymentPayload as base64
// JSON in PAYMENT-SIGNATURE. EVM networks use CAIP-2 and exact payment signs an
// EIP-3009 TransferWithAuthorization.

import { describe, it, expect } from "vitest";
import type { Agent } from "../src/agent.js";
import { detectFacilitator } from "../src/facilitators/detect.js";
import { StandardX402Facilitator } from "../src/facilitators/standard-x402.js";
import { UnsupportedFacilitatorError } from "../src/errors.js";

const requirement = {
  scheme: "exact",
  network: "eip155:84532",
  amount: "10000",
  asset: "0x036CbD53842c5426634e7929541eC2318f3dCF7e",
  payTo: "0x209693Bc6afc0C5328bA36FaF03C514EF312287C",
  maxTimeoutSeconds: 300,
  extra: { name: "USDC", version: "2", decimals: 6 },
};

function v2Response(accepts: Array<Record<string, unknown>> = [requirement]): Response {
  const payload = {
    x402Version: 2,
    error: "PAYMENT-SIGNATURE header is required",
    resource: {
      url: "https://example.test/protected",
      description: "test resource",
      mimeType: "application/json",
    },
    accepts,
    extensions: {},
  };
  return new Response("{}", {
    status: 402,
    headers: { "payment-required": Buffer.from(JSON.stringify(payload)).toString("base64") },
  });
}

function decode(header: string) {
  return JSON.parse(Buffer.from(header, "base64").toString("utf8"));
}

function fakeAgent(captured: Array<Record<string, unknown>> = []): Agent {
  return {
    evmAccount: async () => ({
      address: "0x857b06519E91e3A54538791bDbb0E22373e36b66",
      signTypedData: async (input: Record<string, unknown>) => {
        captured.push(input);
        return `0x${"ab".repeat(65)}` as `0x${string}`;
      },
    }),
  } as unknown as Agent;
}

describe("standard x402 version 2", () => {
  it("detects a v2 PAYMENT-REQUIRED response before the Coinbase compatibility adapter", async () => {
    expect(await StandardX402Facilitator.detect(v2Response())).toBe(true);
    expect(StandardX402Facilitator.isUnsupportedV2(v2Response())).toBe(false);
    const facilitator = await detectFacilitator(v2Response());
    expect(facilitator).toBeInstanceOf(StandardX402Facilitator);
    expect(facilitator.name).toBe("x402");
  });

  it("builds the canonical v2 PAYMENT-SIGNATURE payload and CAIP-2 EIP-3009 domain", async () => {
    const captured: Array<Record<string, unknown>> = [];
    const facilitator = new StandardX402Facilitator();
    const auth = await facilitator.buildAuth(v2Response(), fakeAgent(captured), { maxAmountUsd: 0.02 });

    expect(auth.headers?.["X-PAYMENT"]).toBeUndefined();
    const header = auth.headers?.["PAYMENT-SIGNATURE"];
    expect(header).toBeTruthy();
    const payload = decode(header!);

    expect(payload.x402Version).toBe(2);
    expect(payload.accepted).toEqual(requirement);
    expect(payload.resource.url).toBe("https://example.test/protected");
    expect(payload.extensions).toEqual({});
    expect(payload.payload.signature).toMatch(/^0x[0-9a-f]+$/i);
    expect(payload.payload.authorization.from).toBe("0x857b06519E91e3A54538791bDbb0E22373e36b66");
    expect(payload.payload.authorization.to).toBe(requirement.payTo);
    expect(payload.payload.authorization.value).toBe("10000");
    expect(payload.payload.authorization.validAfter).toBe("0");
    expect(BigInt(payload.payload.authorization.validBefore)).toBeGreaterThan(BigInt(Math.floor(Date.now() / 1000)));
    expect(payload.payload.authorization.nonce).toMatch(/^0x[0-9a-f]{64}$/i);

    expect(captured).toHaveLength(1);
    const typed = captured[0] as { domain: Record<string, unknown>; primaryType: string; message: Record<string, unknown> };
    expect(typed.domain.chainId).toBe(84532);
    expect(typed.domain.verifyingContract).toBe(requirement.asset);
    expect(typed.domain.name).toBe("USDC");
    expect(typed.domain.version).toBe("2");
    expect(typed.primaryType).toBe("TransferWithAuthorization");
    expect(typed.message.to).toBe(requirement.payTo);
    expect(typed.message.value).toBe(10000n);
  });

  it("fails closed for non-EVM v2 offers until their exact scheme is implemented", async () => {
    const svm = {
      scheme: "exact",
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      amount: "1000",
      asset: "TokenMint",
      payTo: "Recipient",
      maxTimeoutSeconds: 60,
    };
    const facilitator = new StandardX402Facilitator();
    await expect(facilitator.buildAuth(v2Response([svm]), fakeAgent(), {}))
      .rejects.toThrow(UnsupportedFacilitatorError);
  });

  it("rejects malformed CAIP-2 and invalid EVM fields", async () => {
    const malformed = { ...requirement, network: "base", payTo: "not-an-address" };
    const facilitator = new StandardX402Facilitator();
    await expect(facilitator.buildAuth(v2Response([malformed]), fakeAgent(), {}))
      .rejects.toThrow(/no supported EVM|invalid/i);
  });

  it("enforces maxAmountUsd only when it can safely identify USDC", async () => {
    const facilitator = new StandardX402Facilitator();
    await expect(facilitator.buildAuth(v2Response(), fakeAgent(), { maxAmountUsd: 0.001 }))
      .rejects.toThrow(/cap/i);

    const unknown = { ...requirement, extra: { name: "UNKNOWN", version: "1" } };
    await expect(facilitator.buildAuth(v2Response([unknown]), fakeAgent(), { maxAmountUsd: 10 }))
      .rejects.toThrow(/cannot be safely enforced/i);
  });

  it("retains legacy v1 body detection for backwards compatibility", async () => {
    const legacy = new Response(JSON.stringify({ x402Version: 1, accepts: [] }), {
      status: 402,
      headers: { "content-type": "application/json" },
    });
    expect(await StandardX402Facilitator.detect(legacy)).toBe(true);
  });

  it("does not detect a non-402 even if it carries PAYMENT-REQUIRED", async () => {
    const ok = new Response("{}", { status: 200, headers: { "payment-required": "e30=" } });
    expect(await StandardX402Facilitator.detect(ok)).toBe(false);
  });
});
