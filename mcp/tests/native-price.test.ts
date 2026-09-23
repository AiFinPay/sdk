import { describe, expect, it, vi } from "vitest";
import { CHAINLINK_POL_USD_POLYGON, independentPolUsd } from "../src/native-price.js";

// latestRoundData() return data: roundId, answer (8 decimals), startedAt, updatedAt, answeredInRound.
function roundData(answer: bigint, updatedAtS: number): string {
  const w = (v: bigint) => v.toString(16).padStart(64, "0");
  return "0x" + [1n, answer, BigInt(updatedAtS), BigInt(updatedAtS), 1n].map(w).join("");
}
const now = () => Math.floor(Date.now() / 1000);
const RPC = "https://polygon.example/rpc";

function fetchWith(handlers: { rpc?: () => Response; coinbase?: () => Response; coingecko?: () => Response }) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    if (input === RPC) {
      const body = JSON.parse(String(init?.body));
      expect(body.params[0].to).toBe(CHAINLINK_POL_USD_POLYGON);
      expect(body.params[0].data).toBe("0xfeaf968c");
      return handlers.rpc ? handlers.rpc() : new Response("blocked", { status: 403 });
    }
    if (input.startsWith("https://api.coinbase.com/")) {
      return handlers.coinbase ? handlers.coinbase() : Promise.reject(new TypeError("fetch failed"));
    }
    if (input.startsWith("https://api.coingecko.com/")) {
      expect(input).toContain("ids=polygon-ecosystem-token");
      return handlers.coingecko ? handlers.coingecko() : Promise.reject(new TypeError("fetch failed"));
    }
    throw new Error(`unexpected ${input}`);
  });
}

describe("independent POL/USD for payable_fetch", () => {
  it("reads Chainlink over the agent's own RPC first", async () => {
    const f = fetchWith({ rpc: () => Response.json({ result: roundData(10_640_000n, now() - 3) }) });
    const p = await independentPolUsd({ fetchImpl: f, polygonRpc: RPC });
    expect(p.source).toBe("chainlink-polygon");
    expect(p.usd).toBeCloseTo(0.1064, 6);
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("falls back to Coinbase when the feed is stale", async () => {
    const f = fetchWith({
      rpc: () => Response.json({ result: roundData(10_640_000n, now() - 7200) }),
      coinbase: () => Response.json({ data: { base: "POL", currency: "USD", amount: "0.10637" } }),
    });
    const p = await independentPolUsd({ fetchImpl: f, polygonRpc: RPC });
    expect(p.source).toBe("coinbase");
    expect(p.usd).toBe(0.10637);
  });

  it("pays in a sandbox that blocks Coinbase: CoinGecko answers", async () => {
    // The 2026-09-23 failure: api.coinbase.com unreachable, no other source.
    const f = fetchWith({
      coingecko: () =>
        Response.json({ "polygon-ecosystem-token": { usd: 0.106635, last_updated_at: now() - 60 } }),
    });
    const p = await independentPolUsd({ fetchImpl: f, polygonRpc: RPC });
    expect(p.source).toBe("coingecko");
    expect(p.usd).toBe(0.106635);
  });

  it("refuses a stale CoinGecko price rather than use it", async () => {
    const f = fetchWith({
      coingecko: () => Response.json({ "polygon-ecosystem-token": { usd: 0.126, last_updated_at: 1770083820 } }),
    });
    await expect(independentPolUsd({ fetchImpl: f, polygonRpc: RPC })).rejects.toThrow(/price is \d+s old/);
  });

  it("with every source blocked, says what was tried and that nothing was paid", async () => {
    const f = fetchWith({});
    const err = await independentPolUsd({ fetchImpl: f, polygonRpc: RPC }).catch((e) => e as Error);
    expect(err.message).toContain("nothing was paid");
    expect(err.message).toContain("Chainlink on Polygon via polygon.example");
    expect(err.message).toContain("api.coinbase.com");
    expect(err.message).toContain("api.coingecko.com");
  });

  it("without an RPC configured it starts at Coinbase", async () => {
    const f = fetchWith({ coinbase: () => Response.json({ data: { base: "POL", currency: "USD", amount: "0.1" } }) });
    expect((await independentPolUsd({ fetchImpl: f })).source).toBe("coinbase");
  });
});
