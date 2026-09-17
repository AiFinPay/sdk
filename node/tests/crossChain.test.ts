import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { bridgeQuote, EVM_CHAINS, USDC_NATIVE, AiFinPayAgent } from "../src/index.js";

// ── LiFi quote response fixture — modeled after a real Base→Polygon USDC
//    call captured from li.quest/v1/quote. Trimmed to the fields the SDK
//    actually consumes. Source amount = 1.0 USDC (1_000_000 base units),
//    minimum output = 0.9931 USDC after the Stargate bridge fee.
// ─────────────────────────────────────────────────────────────────────
const fakeLifiQuote = {
  estimate: {
    fromAmount: "1000000",
    toAmount: "993100",
    toAmountMin: "988135",
    feeCosts: [{ amountUSD: "0.0069", name: "Stargate bridge fee" }],
    gasCosts: [{ amountUSD: "0.0021" }],
    executionDuration: 60,
  },
  transactionRequest: {
    to: "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae",
    data: "0xabcdef00",
    value: "0x0",
    gasLimit: "0x186a0",
    chainId: EVM_CHAINS.base,
  },
  tool: "stargate",
  toolDetails: { name: "Stargate" },
  action: {
    fromChainId: EVM_CHAINS.base,
    toChainId: EVM_CHAINS.polygon,
    fromToken: { address: USDC_NATIVE.base },
    toToken: { address: USDC_NATIVE.polygon },
  },
};

let originalFetch: typeof globalThis.fetch;
let capturedUrls: string[] = [];

beforeEach(() => {
  originalFetch = globalThis.fetch;
  capturedUrls = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input.toString();
    capturedUrls.push(url);
    if (url.startsWith("https://li.quest/v1/quote")) {
      return new Response(JSON.stringify(fakeLifiQuote), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not mocked", { status: 404 });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("bridgeQuote (low-level)", () => {
  it("builds the LiFi /quote URL with correct chain ids + token addresses + amount", async () => {
    await bridgeQuote({
      fromChain: "base",
      toChain: "polygon",
      fromToken: USDC_NATIVE.base,
      toToken: USDC_NATIVE.polygon,
      fromAmount: "1000000",
      fromAddress: "0x0000000000000000000000000000000000000001",
    });

    expect(capturedUrls).toHaveLength(1);
    const u = new URL(capturedUrls[0]!);
    expect(u.origin + u.pathname).toBe("https://li.quest/v1/quote");
    expect(u.searchParams.get("fromChain")).toBe(String(EVM_CHAINS.base));
    expect(u.searchParams.get("toChain")).toBe(String(EVM_CHAINS.polygon));
    expect(u.searchParams.get("fromToken")?.toLowerCase()).toBe(USDC_NATIVE.base.toLowerCase());
    expect(u.searchParams.get("toToken")?.toLowerCase()).toBe(USDC_NATIVE.polygon.toLowerCase());
    expect(u.searchParams.get("fromAmount")).toBe("1000000");
    expect(u.searchParams.get("integrator")).toBe("aifinpay");
  });

  it("parses LiFi response into BridgeQuote shape with bridge + gas costs separated", async () => {
    const q = await bridgeQuote({
      fromChain: "base",
      toChain: "polygon",
      fromToken: USDC_NATIVE.base,
      toToken: USDC_NATIVE.polygon,
      fromAmount: "1000000",
      fromAddress: "0x0000000000000000000000000000000000000001",
    });

    expect(q.from.chain).toBe("base");
    expect(q.to.chain).toBe("polygon");
    expect(q.to.amount).toBe("993100");
    expect(q.to.amount_min).toBe("988135");
    expect(q.fees.bridge_usd).toBeCloseTo(0.0069, 6);
    expect(q.fees.gas_usd).toBeCloseTo(0.0021, 6);
    expect(q.fees.total_usd).toBeCloseTo(0.009, 6);
    expect(q.eta_seconds).toBe(60);
    expect(q.bridge_tool).toBe("Stargate");
    expect(q.raw_quote).toBeDefined();
  });

  it("propagates a 4xx from LiFi as an AiFinPayError with detail", async () => {
    globalThis.fetch = (async () => new Response("no route found", { status: 404 })) as typeof globalThis.fetch;

    await expect(
      bridgeQuote({
        fromChain: "base",
        toChain: "polygon",
        fromToken: USDC_NATIVE.base,
        toToken: USDC_NATIVE.polygon,
        fromAmount: "1",
        fromAddress: "0x0000000000000000000000000000000000000001",
      })
    ).rejects.toThrow(/LiFi \/quote returned 404/);
  });
});

describe("AiFinPayAgent.bridgeQuote (high-level USDC convenience)", () => {
  it("converts amount_usdc → 6-decimal base units and uses native USDC on both chains", async () => {
    const agent = await AiFinPayAgent.new({ telemetry: false });

    const q = await agent.bridgeQuote({
      fromChain: "base",
      toChain: "polygon",
      amount_usdc: 1.0,
    });

    // Verify mocked fetch was called with correct USDC base-unit amount
    expect(capturedUrls).toHaveLength(1);
    const u = new URL(capturedUrls[0]!);
    expect(u.searchParams.get("fromAmount")).toBe("1000000");
    expect(u.searchParams.get("fromToken")?.toLowerCase()).toBe(USDC_NATIVE.base.toLowerCase());
    expect(u.searchParams.get("toToken")?.toLowerCase()).toBe(USDC_NATIVE.polygon.toLowerCase());
    expect(u.searchParams.get("fromAddress")?.toLowerCase()).toBe(agent.evmAddress.toLowerCase());

    // Verify parsed quote
    expect(q.from.chain).toBe("base");
    expect(q.to.chain).toBe("polygon");
    expect(q.bridge_tool).toBe("Stargate");
  });

  it("rejects when neither amount_usdc nor fromAmount is provided", async () => {
    const agent = await AiFinPayAgent.new({ telemetry: false });

    await expect(
      agent.bridgeQuote({
        fromChain: "base",
        toChain: "polygon",
        // intentionally no amount
      })
    ).rejects.toThrow(/provide either amount_usdc OR fromAmount/);
  });

  it("rounds fractional USDC amounts to base units correctly", async () => {
    const agent = await AiFinPayAgent.new({ telemetry: false });

    await agent.bridgeQuote({
      fromChain: "base",
      toChain: "polygon",
      amount_usdc: 2.5, // → 2_500_000 base units
    });

    const u = new URL(capturedUrls[0]!);
    expect(u.searchParams.get("fromAmount")).toBe("2500000");
  });
});

// ── A rate limit is not a failed bridge ──────────────────────────────────
//
// LiFi allows callers without an API key 75 requests per two hours, and this
// SDK sends no key. bridgeWaitForArrival used to poll every 5s for up to 30
// minutes — up to 360 requests for one transfer — and treated every non-2xx
// answer exactly like "not arrived yet". So a Circle CCTP transfer, which this
// module's own comment says takes 15-25 minutes on Polygon, would exhaust the
// quota around minute six, read every subsequent 429 as in-flight, and then
// report that the transfer had not finalised. For a transfer that had.
//
// These assert the distinction the old code could not make: refusing to answer
// and answering "not yet" are different facts.
describe("bridgeWaitForArrival under a rate limit", () => {
  const TX = "0x" + "ab".repeat(32) as `0x${string}`;

  const answer = (status: number, body: unknown = {}, headers: Record<string, string> = {}) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });

  it("reports a persistent 429 as unreadable, not as a transfer that did not arrive", async () => {
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return answer(429, { message: "rate limited" }, { "retry-after": "0" });
    }) as typeof fetch;

    const { bridgeWaitForArrival } = await import("../src/crossChain.js");
    await expect(
      bridgeWaitForArrival(TX, { pollIntervalMs: 1, timeoutMs: 5_000 }),
    ).rejects.toThrow(/cannot READ/);

    // and it says why, and where to look, rather than declaring a failure
    await expect(
      bridgeWaitForArrival(TX, { pollIntervalMs: 1, timeoutMs: 5_000 }),
    ).rejects.toThrow(/RATE LIMIT|75 requests per two hours/);

    // it also stops early rather than spending the whole window on 429s
    expect(calls).toBeLessThan(20);
  });

  it("does not claim the transfer failed — the wording is about observation", async () => {
    globalThis.fetch = (async () => answer(429, {})) as typeof fetch;
    const { bridgeWaitForArrival } = await import("../src/crossChain.js");
    const err = await bridgeWaitForArrival(TX, { pollIntervalMs: 1, timeoutMs: 3_000 }).catch(
      (e) => e as Error,
    );
    expect(err.message).toMatch(/NOT evidence that it failed/);
    expect(err.message).not.toMatch(/did not finalise/);
  });

  it("a transient 429 followed by DONE still returns done", async () => {
    let n = 0;
    globalThis.fetch = (async () => {
      n += 1;
      if (n <= 2) return answer(429, {}, { "retry-after": "0" });
      return answer(200, { status: "DONE", receiving: { txHash: "0xdest" } });
    }) as typeof fetch;

    const { bridgeWaitForArrival } = await import("../src/crossChain.js");
    const out = await bridgeWaitForArrival(TX, { pollIntervalMs: 1, timeoutMs: 10_000 });
    expect(out.status).toBe("done");
    expect(out.dest_tx).toBe("0xdest");
  });

  it("a sustained network failure surfaces instead of being swallowed", async () => {
    globalThis.fetch = (async () => {
      throw new TypeError("fetch failed");
    }) as typeof fetch;
    const { bridgeWaitForArrival } = await import("../src/crossChain.js");
    await expect(
      bridgeWaitForArrival(TX, { pollIntervalMs: 1, timeoutMs: 5_000 }),
    ).rejects.toThrow(/cannot REACH LiFi/);
  });

  it("the default poll interval fits the quota it is given", async () => {
    // 30 minutes at 5s is 360 requests against a budget of 75. The default has
    // to be a number that does not guarantee exhaustion; this fails if someone
    // lowers it back for responsiveness without reading the header.
    const src = await import("node:fs").then((fs) =>
      fs.readFileSync(new URL("../src/crossChain.ts", import.meta.url), "utf8"),
    );
    const m = src.match(/DEFAULT_POLL_INTERVAL_MS = ([\d_]+)/);
    expect(m).toBeTruthy();
    const ms = Number(m![1].replace(/_/g, ""));
    expect(30 * 60 * 1000 / ms).toBeLessThanOrEqual(90);
  });
});
