import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiFinPayAgent } from "@aifinpay/agent";

// The SDK's own report (POST /api/telemetry) fires after a paid call and after
// a call() the bridge answered without a 402; the second needs no chain, so it
// probes whether the agent the server built would report at all.
const provider = {
  name: "offline-provider",
  preferred_chain: "polygon",
  accepted_chains: ["polygon"],
  price_usd: 0.01,
  mode: "per_call",
  bridge_url: "https://bridge.example",
  merchant_wallet: "0x1111111111111111111111111111111111111111",
  service_type: "search",
};
const requests = vi.hoisted(() => [] as string[]);
const network = vi.hoisted(
  () =>
    (async (input: RequestInfo | URL) => {
      const url = input instanceof Request ? input.url : String(input);
      requests.push(url);
      if (new URL(url).pathname === "/api/providers") return Response.json({ providers: [provider] });
      return Response.json({ ok: true });
    }) as typeof fetch
);
vi.mock("../src/safe-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/safe-fetch.js")>()),
  makeSafeFetch: () => network,
}));
const { createServer } = await import("../src/server.js");

const reports = () => requests.filter((url) => new URL(url).pathname === "/api/telemetry");
const dirs: string[] = [];

// The MCP's own events: an unusable URL stops them, the stub keeps anything else offline.
beforeEach(() => {
  vi.stubEnv("AIFINPAY_TELEMETRY_URL", "http://unusable.invalid/");
  vi.stubGlobal("fetch", network);
});
afterEach(() => {
  requests.length = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function serverAgent(seeded: boolean) {
  const home = mkdtempSync(join(tmpdir(), "aifp-sdk-telemetry-"));
  dirs.push(home);
  const active = await createServer({
    ...(seeded ? { seedHash: "55".repeat(32) } : {}),
    walletHome: home,
    logFn: () => {},
  });
  return { agent: active.agent, close: () => active.server.close() };
}

describe("the MCP never sends the SDK's /api/telemetry report", () => {
  it("the probe is live: an agent built without the option reports", async () => {
    vi.stubEnv("AIFINPAY_TELEMETRY", undefined);
    vi.stubEnv("DO_NOT_TRACK", undefined);
    const agent = await AiFinPayAgent.fromSeed("55".repeat(32), { fetchImpl: network });
    expect((await agent.call({ provider: provider.name }))?.status).toBe(200);
    expect(reports()).toHaveLength(1);
  });

  it.each([
    { env: "unset", value: undefined, wallet: "persistent" },
    { env: "unset", value: undefined, wallet: "ephemeral" },
    { env: "off", value: "off", wallet: "persistent" },
    { env: "off", value: "off", wallet: "ephemeral" },
  ])("AIFINPAY_TELEMETRY $env, $wallet wallet: no report", async ({ value, wallet }) => {
    vi.stubEnv("AIFINPAY_TELEMETRY", value);
    vi.stubEnv("DO_NOT_TRACK", undefined);
    const { agent, close } = await serverAgent(wallet === "persistent");
    try {
      expect((await agent.call({ provider: provider.name }))?.status).toBe(200);
      expect(requests.some((url) => url.startsWith(provider.bridge_url))).toBe(true);
      expect(reports()).toEqual([]);
    } finally {
      await close();
    }
  });
});
