import { describe, expect, it } from "vitest";
import {
  Agent,
  AiFinPayFacilitator,
  CoinbaseX402Facilitator,
  FacilitatorNotImplementedError,
  PaymentTooExpensiveError,
  UnsupportedFacilitatorError,
  detectFacilitator,
} from "../src/index.js";

function makeResp(status: number, init: { headers?: Record<string, string>; body?: unknown } = {}): Response {
  const headers = new Headers(init.headers);
  let body: BodyInit | null = null;
  if (init.body !== undefined) {
    if (typeof init.body === "object" && init.body !== null) {
      body = JSON.stringify(init.body);
      if (!headers.has("content-type")) {
        headers.set("content-type", "application/json");
      }
    } else {
      body = String(init.body);
    }
  }
  return new Response(body, { status, headers });
}

describe("detection", () => {
  it("AiFinPay matches the protocol field", async () => {
    const r = makeResp(402, {
      body: {
        error: "Payment Required",
        protocol: "AiFinPay v5.3",
        manifesto: "/manifesto.json",
        treasury_vault: "AnbjcK3uD…",
        agreement_hash: "27b28e…df19c699",
        "x-nonce": "abc-123",
      },
    });
    expect(await AiFinPayFacilitator.detect(r)).toBe(true);
    expect((await detectFacilitator(r)).name).toBe("aifinpay");
  });

  it("AiFinPay fallback fingerprint without protocol field", async () => {
    const r = makeResp(402, {
      body: {
        agreement_hash: "27b28e…df19c699",
        treasury_vault: "AnbjcK3uD…",
      },
    });
    expect(await AiFinPayFacilitator.detect(r)).toBe(true);
  });

  it("AiFinPay does not match non-402", async () => {
    const r = makeResp(200, { body: { protocol: "AiFinPay v5.3" } });
    expect(await AiFinPayFacilitator.detect(r)).toBe(false);
  });

  it("AiFinPay does not match random 402 body", async () => {
    const r = makeResp(402, { body: { error: "pay up" } });
    expect(await AiFinPayFacilitator.detect(r)).toBe(false);
  });

  it("Coinbase x402 matches PAYMENT-REQUIRED header", async () => {
    const spec = { accepts: [{ scheme: "exact", priceUsd: 0.05 }] };
    const enc = Buffer.from(JSON.stringify(spec)).toString("base64");
    const r = makeResp(402, { headers: { "PAYMENT-REQUIRED": enc } });
    expect(CoinbaseX402Facilitator.detect(r)).toBe(true);
    expect((await detectFacilitator(r)).name).toBe("coinbase-x402");
  });

  it("unknown 402 raises UnsupportedFacilitatorError", async () => {
    const r = makeResp(402, { body: { random: "shape" } });
    await expect(detectFacilitator(r)).rejects.toBeInstanceOf(UnsupportedFacilitatorError);
  });

  it("override forces facilitator", async () => {
    const r = makeResp(402, { body: { random: "shape" } });
    expect((await detectFacilitator(r, "aifinpay")).name).toBe("aifinpay");
  });

  it("override unknown name raises", async () => {
    const r = makeResp(402);
    await expect(detectFacilitator(r, "not-real")).rejects.toBeInstanceOf(UnsupportedFacilitatorError);
  });
});

describe("Coinbase adapter behavior", () => {
  it("raises NotImplemented on buildAuth", async () => {
    const spec = { accepts: [{ scheme: "exact", priceUsd: 0.01 }] };
    const enc = Buffer.from(JSON.stringify(spec)).toString("base64");
    const r = makeResp(402, { headers: { "PAYMENT-REQUIRED": enc } });
    const agent = Agent.new();
    await expect(new CoinbaseX402Facilitator().buildAuth(r, agent, {})).rejects.toBeInstanceOf(
      FacilitatorNotImplementedError
    );
  });

  it("budget cap blocks expensive payment before NotImplemented", async () => {
    const spec = { accepts: [{ scheme: "exact", priceUsd: 5.0 }] };
    const enc = Buffer.from(JSON.stringify(spec)).toString("base64");
    const r = makeResp(402, { headers: { "PAYMENT-REQUIRED": enc } });
    const agent = Agent.new();
    await expect(
      new CoinbaseX402Facilitator().buildAuth(r, agent, {
        maxAmountUsd: 0.1,
      })
    ).rejects.toBeInstanceOf(PaymentTooExpensiveError);
  });

  it("malformed PAYMENT-REQUIRED raises Unsupported", async () => {
    const r = makeResp(402, { headers: { "PAYMENT-REQUIRED": "not-base64!!" } });
    const agent = Agent.new();
    await expect(new CoinbaseX402Facilitator().buildAuth(r, agent, {})).rejects.toBeInstanceOf(
      UnsupportedFacilitatorError
    );
  });
});

describe("Agent ergonomics", () => {
  it("keypair round-trips via secretB58", () => {
    const a = Agent.new();
    const a2 = Agent.fromSecretB58(a.secretB58);
    expect(a2.address).toBe(a.address);
  });
});
