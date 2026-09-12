import { describe, expect, it, vi } from "vitest";
import { runAgentQuote } from "../src/tools/agent-quote.js";

function ctxFor(body: unknown, status = 402, headers?: Record<string, string>) {
  return {
    agent: {
      inner: { fetchImpl: vi.fn(async () => new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json", ...headers },
      })) },
    },
  } as never;
}

describe("agent_quote protocol detection", () => {
  it("recognises an AIFP-1 gateway challenge without calling x402 detection", async () => {
    const out = await runAgentQuote(ctxFor({
      error: "AIFP-402",
      protocol: "AIFP-1",
      merchant_id: "mrch_demo",
      resource: "/reports/q1",
      unit_weight: 2,
      base_unit_price_usd: "0.0005",
    }), { url: "https://gateway.aifinpay.io/demo/reports/q1" });
    const text = (out as { content: { text: string }[] }).content[0].text;
    expect(JSON.parse(text)).toMatchObject({
      facilitator: "aifp1",
      status: 402,
      payment_model: "gross-inclusive",
      merchant_terms: { merchant_id: "mrch_demo" },
    });
  });

  it("keeps ordinary x402 detection unchanged", async () => {
    const encoded = Buffer.from(JSON.stringify({ accepts: [{ scheme: "exact", priceUsd: 1 }] })).toString("base64");
    const out = await runAgentQuote(ctxFor(null, 402, { "PAYMENT-REQUIRED": encoded }), {
      url: "https://x402.example/protected",
    });
    const text = (out as { content: { text: string }[] }).content[0].text;
    expect(JSON.parse(text).facilitator).toBe("coinbase-x402");
  });
});
