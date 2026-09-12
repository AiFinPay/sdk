import { describe, expect, it, vi } from "vitest";
import { runAgentQuote } from "../src/tools/agent-quote.js";

function context(body: unknown) {
  return { agent: { inner: { fetchImpl: vi.fn(async () => Response.json(body, { status: 402 })) } } } as never;
}

describe("agent_quote AIFP-1 recognition", () => {
  it("reports gross-inclusive AIFP-1 terms without x402 detection", async () => {
    const out = await runAgentQuote(context({ error: "AIFP-402", protocol: "AIFP-1", merchant_id: "mrch_demo", resource: "/genres" }), { url: "https://gateway.aifinpay.io/demo/genres" });
    expect(JSON.parse((out as any).content[0].text)).toMatchObject({ facilitator: "aifp1", payment_model: "gross-inclusive" });
  });
});
