import { describe, expect, it, vi } from "vitest";
import {
  Agent,
  AiFinPayFacilitator,
  CoinbaseX402Facilitator,
  FacilitatorNotImplementedError,
  PaymentTooExpensiveError,
  UnsupportedFacilitatorError,
  UntrustedPaymentTargetError,
  detectFacilitator,
} from "../src/index.js";

function makeResp(
  status: number,
  init: { headers?: Record<string, string>; body?: unknown; url?: string } = {},
): Response {
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
  const response = new Response(body, { status, headers });
  if (init.url) Object.defineProperty(response, "url", { value: init.url });
  return response;
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
    await expect(detectFacilitator(r)).rejects.toBeInstanceOf(
      UnsupportedFacilitatorError,
    );
  });

  it("override forces facilitator", async () => {
    const r = makeResp(402, { body: { random: "shape" } });
    expect((await detectFacilitator(r, "aifinpay")).name).toBe("aifinpay");
  });

  it("override unknown name raises", async () => {
    const r = makeResp(402);
    await expect(detectFacilitator(r, "not-real")).rejects.toBeInstanceOf(
      UnsupportedFacilitatorError,
    );
  });
});

describe("AiFinPay native auth origin binding", () => {
  it("refuses a hostile 402 origin before obtaining a nonce or signing", async () => {
    const r = makeResp(402, {
      url: "https://evil.example/paid",
      body: { protocol: "AiFinPay v5.3", "x-nonce": "attacker-nonce" },
    });
    const agent = Agent.new({ baseUrl: "https://aifinpay.io" });
    const fetchSpy = vi.spyOn(agent, "fetchImpl");

    await expect(new AiFinPayFacilitator().buildAuth(r, agent, {})).rejects.toBeInstanceOf(
      UntrustedPaymentTargetError,
    );
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("ignores responder nonces and obtains nonce only from the configured AiFinPay origin", async () => {
    const r = makeResp(402, {
      url: "https://aifinpay.io/paid",
      body: { protocol: "AiFinPay v5.3", "x-nonce": "attacker-nonce" },
    });
    const agent = Agent.new({
      baseUrl: "https://aifinpay.io",
      fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe("https://aifinpay.io/nonce");
        return new Response(JSON.stringify({ nonce: "trusted-nonce" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch,
    });

    const auth = await new AiFinPayFacilitator().buildAuth(r, agent, {});
    expect(auth.headers?.["x-nonce"]).toBe("trusted-nonce");
    expect(auth.headers?.["x-nonce"]).not.toBe("attacker-nonce");
  });
});

describe("Coinbase adapter behavior", () => {
  it("raises NotImplemented on buildAuth", async () => {
    const spec = { accepts: [{ scheme: "exact", priceUsd: 0.01 }] };
    const enc = Buffer.from(JSON.stringify(spec)).toString("base64");
    const r = makeResp(402, { headers: { "PAYMENT-REQUIRED": enc } });
    const agent = Agent.new();
    await expect(
      new CoinbaseX402Facilitator().buildAuth(r, agent, {}),
    ).rejects.toBeInstanceOf(FacilitatorNotImplementedError);
  });

  it("budget cap blocks expensive payment before NotImplemented", async () => {
    const spec = { accepts: [{ scheme: "exact", priceUsd: 5.0 }] };
    const enc = Buffer.from(JSON.stringify(spec)).toString("base64");
    const r = makeResp(402, { headers: { "PAYMENT-REQUIRED": enc } });
    const agent = Agent.new();
    await expect(
      new CoinbaseX402Facilitator().buildAuth(r, agent, {
        maxAmountUsd: 0.1,
      }),
    ).rejects.toBeInstanceOf(PaymentTooExpensiveError);
  });

  it("malformed PAYMENT-REQUIRED raises Unsupported", async () => {
    const r = makeResp(402, { headers: { "PAYMENT-REQUIRED": "not-base64!!" } });
    const agent = Agent.new();
    await expect(
      new CoinbaseX402Facilitator().buildAuth(r, agent, {}),
    ).rejects.toBeInstanceOf(UnsupportedFacilitatorError);
  });
});

describe("standard x402 target validation", () => {
  it("detects the format but refuses to sign server-selected asset/domain/payTo", async () => {
    const r = makeResp(402, {
      body: {
        x402Version: 1,
        accepts: [{
          scheme: "exact",
          network: "base",
          asset: "0x1111111111111111111111111111111111111111",
          payTo: "0x2222222222222222222222222222222222222222",
          maxAmountRequired: "1000000",
          extra: { name: "Attacker Token", version: "999" },
        }],
      },
    });
    const facilitator = await detectFacilitator(r);
    expect(facilitator.name).toBe("x402");
    const agent = Agent.new();
    const account = vi.spyOn(agent, "evmAccount");
    await expect(facilitator.buildAuth(r, agent, {})).rejects.toBeInstanceOf(
      UntrustedPaymentTargetError,
    );
    expect(account).not.toHaveBeenCalled();
  });
});

describe("Agent ergonomics", () => {
  it("keypair round-trips via secretB58", () => {
    const a = Agent.new();
    const a2 = Agent.fromSecretB58(a.secretB58);
    expect(a2.address).toBe(a.address);
  });
});
