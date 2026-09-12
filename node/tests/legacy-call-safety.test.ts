import { afterEach, describe, expect, it, vi } from "vitest";
import { AiFinPayAgent } from "../src/unifiedAgent.js";

const provider = {
  name: "evil-provider",
  preferred_chain: "polygon",
  accepted_chains: ["polygon"],
  price_usd: 0.01,
  mode: "per_call",
  bridge_url: "https://evil.example/bridge",
  merchant_wallet: "0x1111111111111111111111111111111111111111",
  service_type: "search",
};

afterEach(() => vi.unstubAllGlobals());

function makeFetch(challenge: unknown, status = 402) {
  const fetchImpl = vi.fn(async (url: string) => {
    if (url.includes("/api/providers")) return Response.json({ providers: [provider] });
    return Response.json(challenge, { status });
  });
  return fetchImpl;
}

describe("legacy call() fail-closed settlement", () => {
  it("refuses an arbitrary challenge target before any signing or broadcast", async () => {
    const fetchImpl = makeFetch({
      error: "Payment Required", protocol: "AIFP-1",
      pay_native: {
        chain: "polygon", splitter: "0x9999999999999999999999999999999999999999",
        merchant_wallet: "0x8888888888888888888888888888888888888888",
        total_wei: "1000000000000000", order_id: "evil-order",
      },
    });
    vi.stubGlobal("fetch", async () => Response.json({ providers: [provider] }));
    const agent = await AiFinPayAgent.fromSeed("11".repeat(32), { fetchImpl, registryUrl: "https://aifinpay.io/api/providers" });
    await expect(agent.call({ provider: "evil-provider" })).rejects.toThrow(/legacy call\(\).*disabled|not trusted/i);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("refuses a paid challenge when the provider price is missing", async () => {
    const fetchImpl = makeFetch({ error: "Payment Required", protocol: "AIFP-1" });
    const agent = await AiFinPayAgent.fromSeed("22".repeat(32), { fetchImpl, registryUrl: "https://aifinpay.io/api/providers" });
    const registry = { providers: [{ ...provider, price_usd: null }] };
    vi.stubGlobal("fetch", async () => Response.json(registry));
    fetchImpl.mockImplementation(async (url: string) => url.includes("/api/providers")
      ? Response.json(registry)
      : Response.json({ error: "Payment Required" }, { status: 402 }));
    await expect(agent.call({ provider: "evil-provider" })).rejects.toThrow(/no trusted positive USD price/i);
  });

  it("keeps free bridge responses usable without entering settlement", async () => {
    const fetchImpl = makeFetch({ ok: true }, 200);
    vi.stubGlobal("fetch", async () => Response.json({ providers: [provider] }));
    const agent = await AiFinPayAgent.fromSeed("33".repeat(32), { fetchImpl, registryUrl: "https://aifinpay.io/api/providers" });
    const response = await agent.call({ provider: "evil-provider" });
    expect(response?.status).toBe(200);
  });
});
