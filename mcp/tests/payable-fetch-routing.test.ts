// payable_fetch must pay BOTH protocols, not just x402.
//
// Two protocols answer a 402 at this tool: the AIFP-1 gateway
// (gateway.aifinpay.io/{slug}/…, quote → settle → receipt → retry, on the
// unified agent as fetchPaid) and x402 facilitators (the X-PAYMENT flow, on the
// wrapped agent as inner.pay). The tool used to call inner.pay only, so an MCP
// agent pointed at a gateway URL — the most common paid surface we run — got
// stuck on a 402 it could not read.
//
// The happy path pays real money on-chain and cannot be exercised here (no
// spend). These tests assert the ROUTING instead, with both payment methods
// stubbed: which one is tried, in what order, and that a budget skip is not
// laundered into a second attempt. That is the whole of what broke.

import { describe, it, expect, vi } from "vitest";
import { runPayableFetch } from "../src/tools/payable-fetch.js";

/** A minimal Response the tool can read status/headers/body off. */
function resp(status: number, bodyText = ""): Response {
  return new Response(bodyText, { status, headers: { "content-type": "text/plain" } });
}

/** A ctx whose two payment paths are spies with scripted return values. */
function makeCtx(opts: {
  fetchPaid?: (url: string) => Promise<Response | null>;
  innerPay?: (url: string) => Promise<Response>;
}) {
  const fetchPaid = vi.fn(opts.fetchPaid ?? (async () => resp(200, "aifp1-paid")));
  const innerPay = vi.fn(opts.innerPay ?? (async () => resp(200, "x402-paid")));
  const ctx = {
    config: { maxAmountUsd: 0.1 },
    agent: {
      evmAddress: "0x5Df154283588623aa23c770c1521F7835861255e",
      solanaAddress: "5Df1CJqFbUBUXhs3rBqvB3vJf2SCyGmnZWnAsRmKQ7wK",
      fetchPaid,
      inner: { pay: innerPay },
    },
  } as never;
  return { ctx, fetchPaid, innerPay };
}

const bodyOf = (r: Awaited<ReturnType<typeof runPayableFetch>>) => {
  const text = (r as { content: { text: string }[] }).content[0].text;
  try {
    return JSON.parse(text).body as string;
  } catch {
    return text;
  }
};

describe("payable_fetch protocol routing", () => {
  it("pays an AIFP-1 gateway URL via fetchPaid, without touching x402", async () => {
    const { ctx, fetchPaid, innerPay } = makeCtx({
      fetchPaid: async () => resp(200, "gateway-content"),
    });
    const out = await runPayableFetch(ctx, { url: "https://gateway.aifinpay.io/acme/x" });
    expect(fetchPaid).toHaveBeenCalledOnce();
    expect(innerPay).not.toHaveBeenCalled();
    expect(bodyOf(out)).toBe("gateway-content");
  });

  it("falls back to x402 when fetchPaid passes a non-AIFP-1 402 through", async () => {
    // fetchPaid is documented to return a 402 it does not recognise untouched.
    const { ctx, fetchPaid, innerPay } = makeCtx({
      fetchPaid: async () => resp(402, "x402-challenge"),
      innerPay: async () => resp(200, "x402-paid"),
    });
    const out = await runPayableFetch(ctx, { url: "https://x402.example/protected" });
    expect(fetchPaid).toHaveBeenCalledOnce();
    expect(innerPay).toHaveBeenCalledOnce();
    expect(bodyOf(out)).toBe("x402-paid");
  });

  it("a forced facilitator skips AIFP-1 entirely", async () => {
    // Forcing a facilitator is an explicit x402 intent; do not spend a request
    // (or worse, a payment) probing AIFP-1 first.
    const { ctx, fetchPaid, innerPay } = makeCtx({});
    await runPayableFetch(ctx, {
      url: "https://x402.example/p",
      facilitator: "coinbase-x402",
    });
    expect(fetchPaid).not.toHaveBeenCalled();
    expect(innerPay).toHaveBeenCalledOnce();
  });

  it("a budget skip is not laundered into an x402 payment", async () => {
    // fetchPaid returns null when a cap is hit and on_limit_exceeded="skip".
    // Trying inner.pay next would pay anyway, defeating the cap the caller set.
    const { ctx, fetchPaid, innerPay } = makeCtx({
      fetchPaid: async () => null,
    });
    const out = await runPayableFetch(ctx, { url: "https://gateway.aifinpay.io/acme/x" });
    expect(fetchPaid).toHaveBeenCalledOnce();
    expect(innerPay).not.toHaveBeenCalled();
    expect((out as { content: { text: string }[] }).content[0].text).toMatch(/skip/i);
  });

  it("returns a non-paywalled 200 straight through", async () => {
    const { ctx, innerPay } = makeCtx({ fetchPaid: async () => resp(200, "free") });
    const out = await runPayableFetch(ctx, { url: "https://free.example/" });
    expect(innerPay).not.toHaveBeenCalled();
    expect(bodyOf(out)).toBe("free");
  });
});
