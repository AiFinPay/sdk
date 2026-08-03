import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  AiFinPayAgent,
  InsufficientFundsError,
  SPLITTER_DEPLOYMENTS,
} from "../src/index.js";

// Two failures that shared a cause: the SDK preferred a number compiled into
// itself over admitting it did not know one.
//
// The pre-sign guard converted a challenge's wei into USD using
// `nativeUsdDefault`, which said POL was $0.70 while it traded near $0.073.
// Every quote therefore looked about ten times its real cost, and payments
// above roughly half a cent were rejected with BudgetCapExceededError before
// any money moved — an error naming the bridge for a fault in this table.
//
// Separately, an agent with no POL got viem's ContractFunctionExecutionError:
// several paragraphs on how `gas * gas fee + value` is computed, for the one
// condition an operator fixes in seconds. InsufficientFundsError had been
// exported since the first release and thrown nowhere, so every
// `catch (e instanceof InsufficientFundsError)` was dead code.

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
  it("takes the live feed over the value compiled into the SDK", async () => {
    stubPriceFeed({ usd: { POL: 0.073 } });
    const agent = await AiFinPayAgent.fromSeed(SEED);
    const { usd, source } = await (agent as any).nativeUsdFor(polygon);
    expect(usd).toBe(0.073);
    expect(source).toBe("aifinpay price feed");
    // The specific number that blocked real payments.
    expect(usd).not.toBe(0.70);
  });

  it("lets an operator override the feed", async () => {
    stubPriceFeed({ usd: { POL: 0.073 } });
    process.env[polygon.nativeUsdEnv] = "0.5";
    const agent = await AiFinPayAgent.fromSeed(SEED);
    const { usd, source } = await (agent as any).nativeUsdFor(polygon);
    expect(usd).toBe(0.5);
    expect(source).toBe(polygon.nativeUsdEnv);
  });

  it("admits it does not know rather than falling back to a constant", async () => {
    stubPriceFeed({ error: "price_feed_unavailable" }, false);
    const agent = await AiFinPayAgent.fromSeed(SEED);
    const { usd, source } = await (agent as any).nativeUsdFor(polygon);
    expect(Number.isNaN(usd)).toBe(true);
    expect(source).toBe("unknown");
  });

  it("does not block a payment on a price it could not obtain", async () => {
    stubPriceFeed({ error: "price_feed_unavailable" }, false);
    const agent = await AiFinPayAgent.fromSeed(SEED);
    agent.setBudget({ per_call_usd: 0.01 });
    // NaN in means "no basis to judge", and a guard with no basis must let the
    // caller proceed — blocking on an unjustified number is the original bug.
    const allowed = (agent as any).guardChallengeAmount(Number.NaN, 0.001, "exa");
    expect(allowed).toBe(true);
  });

  it("still blocks a genuine overcharge when the price is known", async () => {
    const agent = await AiFinPayAgent.fromSeed(SEED);
    agent.setBudget({ per_call_usd: 0.01 });
    // $5.00 demanded against a $0.001 declared cost is not a rounding dispute.
    expect(() => (agent as any).guardChallengeAmount(5, 0.001, "exa")).toThrow();
  });
});

describe("an agent that cannot pay", () => {
  // A client that answers the two reads the check makes, and nothing else.
  const clientWith = (balanceWei: bigint) => ({
    getBalance: async () => balanceWei,
    getGasPrice: async () => 30_000_000_000n, // 30 gwei
  });

  it("throws InsufficientFundsError instead of a viem internals dump", async () => {
    const agent = await AiFinPayAgent.fromSeed(SEED);
    const err = await (agent as any)
      .assertCanAffordNative(clientWith(0n), polygon, 10n ** 16n)
      .then(() => null, (e: unknown) => e);

    expect(err).toBeInstanceOf(InsufficientFundsError);
    const e = err as InsufficientFundsError;
    // The things an operator needs: which address, which chain, how much.
    expect(e.message).toContain(agent.evmAddress);
    expect(e.message).toContain("POL");
    expect(e.message).toContain("Polygon");
    expect(e.details?.available_wei).toBe("0");
    expect(BigInt(e.details!.needed_wei)).toBeGreaterThan(10n ** 16n); // payment + gas
  });

  it("says nothing when the balance covers payment and gas", async () => {
    const agent = await AiFinPayAgent.fromSeed(SEED);
    await expect(
      (agent as any).assertCanAffordNative(clientWith(10n ** 18n), polygon, 10n ** 16n),
    ).resolves.toBeUndefined();
  });

  it("treats an unreadable RPC as unknown, not as insufficient", async () => {
    // Otherwise a flaky endpoint reports the agent as broke, and the operator
    // funds an address that was never short.
    const broken = { getBalance: async () => { throw new Error("RPC down"); },
                     getGasPrice: async () => 30_000_000_000n };
    const agent = await AiFinPayAgent.fromSeed(SEED);
    await expect(
      (agent as any).assertCanAffordNative(broken, polygon, 10n ** 16n),
    ).resolves.toBeUndefined();
  });
});
