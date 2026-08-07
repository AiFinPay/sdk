import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  AiFinPayAgent,
  InsufficientFundsError,
  SPLITTER_DEPLOYMENTS,
  UntrustedPaymentTargetError,
} from "../src/index.js";

// The SDK must never invent a native-token USD price. If a trusted live price
// is available it can enforce the configured/declarative ceiling; if no price
// can be established the signing path fails closed instead of authorizing an
// amount it cannot value.

const SEED = "a".repeat(64);
const polygon = SPLITTER_DEPLOYMENTS.polygon;

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env[polygon.nativeUsdEnv];
});

function stubPriceFeed(body: unknown, ok = true) {
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    if (String(input).includes("/api/price/native")) {
      return new Response(JSON.stringify(body), {
        status: ok ? 200 : 503,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("{}", { status: 404 });
  }) as typeof globalThis.fetch;
}

describe("the native price behind the pre-sign guard", () => {
  it("takes the live feed over a compiled guess", async () => {
    stubPriceFeed({ usd: { POL: 0.073 } });
    const agent = await AiFinPayAgent.fromSeed(SEED);
    const { usd, source } = await (agent as any).nativeUsdFor(polygon);
    expect(usd).toBe(0.073);
    expect(source).toBe("aifinpay price feed");
    expect(usd).not.toBe(0.70);
  });

  it("lets an operator override the feed with a positive finite value", async () => {
    stubPriceFeed({ usd: { POL: 0.073 } });
    process.env[polygon.nativeUsdEnv] = "0.5";
    const agent = await AiFinPayAgent.fromSeed(SEED);
    const { usd, source } = await (agent as any).nativeUsdFor(polygon);
    expect(usd).toBe(0.5);
    expect(source).toBe(polygon.nativeUsdEnv);
  });

  it("returns unknown rather than falling back to a constant", async () => {
    stubPriceFeed({ error: "price_feed_unavailable" }, false);
    const agent = await AiFinPayAgent.fromSeed(SEED);
    const { usd, source } = await (agent as any).nativeUsdFor(polygon);
    expect(Number.isNaN(usd)).toBe(true);
    expect(source).toBe("unknown");
  });

  it("fails closed when a payment cannot be valued", async () => {
    stubPriceFeed({ error: "price_feed_unavailable" }, false);
    const agent = await AiFinPayAgent.fromSeed(SEED);
    agent.setBudget({ per_call_usd: 0.01 });
    expect(() =>
      (agent as any).guardChallengeAmount(Number.NaN, 0.001, "exa"),
    ).toThrow(UntrustedPaymentTargetError);
  });

  it("fails closed when no positive declared cost or operator ceiling exists", async () => {
    const agent = await AiFinPayAgent.fromSeed(SEED);
    expect(() =>
      (agent as any).guardChallengeAmount(0.001, 0, "exa"),
    ).toThrow(UntrustedPaymentTargetError);
  });

  it("still blocks a genuine overcharge when the price is known", async () => {
    const agent = await AiFinPayAgent.fromSeed(SEED);
    agent.setBudget({ per_call_usd: 0.01 });
    expect(() => (agent as any).guardChallengeAmount(5, 0.001, "exa")).toThrow();
  });

  it("allows a known value only when it is within a positive ceiling", async () => {
    const agent = await AiFinPayAgent.fromSeed(SEED);
    agent.setBudget({ per_call_usd: 0.01 });
    expect((agent as any).guardChallengeAmount(0.005, 0.004, "exa")).toBe(true);
  });
});

describe("an agent that cannot pay", () => {
  const clientWith = (balanceWei: bigint) => ({
    getBalance: async () => balanceWei,
    getGasPrice: async () => 30_000_000_000n,
  });

  it("throws InsufficientFundsError instead of a viem internals dump", async () => {
    const agent = await AiFinPayAgent.fromSeed(SEED);
    const err = await (agent as any)
      .assertCanAffordNative(clientWith(0n), polygon, 10n ** 16n)
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(InsufficientFundsError);
    const e = err as InsufficientFundsError;
    expect(e.message).toContain(agent.evmAddress);
    expect(e.message).toContain("POL");
    expect(e.message).toContain("Polygon");
    expect(e.details?.available_wei).toBe("0");
    expect(BigInt(e.details!.needed_wei)).toBeGreaterThan(10n ** 16n);
  });

  it("says nothing when the balance covers payment and gas", async () => {
    const agent = await AiFinPayAgent.fromSeed(SEED);
    await expect(
      (agent as any).assertCanAffordNative(clientWith(10n ** 18n), polygon, 10n ** 16n),
    ).resolves.toBeUndefined();
  });

  it("treats an unreadable RPC as unknown, not as insufficient", async () => {
    const broken = { getBalance: async () => { throw new Error("RPC down"); },
                     getGasPrice: async () => 30_000_000_000n };
    const agent = await AiFinPayAgent.fromSeed(SEED);
    await expect(
      (agent as any).assertCanAffordNative(broken, polygon, 10n ** 16n),
    ).resolves.toBeUndefined();
  });
});
