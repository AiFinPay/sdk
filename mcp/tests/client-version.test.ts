import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SDK_USER_AGENT, SDK_VERSION } from "@aifinpay/agent";
import type { ToolContext } from "../src/server.js";

const MCP = `aifinpay-mcp/${JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version}`;
const FULL = `${MCP} aifinpay-agent-node/${SDK_VERSION}`;
const origin = "https://merchant.example";
const url = `${origin}/private/data`;
const merchantId = "mrch_offline1";

// Offline network behind the server's fetch: what each request carried, and fixed answers.
const seen: Array<{ method: string; url: string; agent: string | null; receipt: string | null }> = [];
vi.mock("../src/safe-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/safe-fetch.js")>()),
  makeSafeFetch: () =>
    (async (input: string | URL | Request, init?: RequestInit) => {
      const request = new Request(input, init);
      const receipt = request.headers.get("aifp-receipt");
      seen.push({ method: request.method, url: request.url, agent: request.headers.get("user-agent"), receipt });
      if (request.url === url)
        return receipt
          ? new Response("content", { headers: { "content-type": "text/plain" } })
          : Response.json(
              {
                error: "AIFP-402",
                protocol: "AIFP-1",
                merchant_id: merchantId,
                resource: "/private/data",
                unit_weight: 1,
                base_unit_price_usd: "0.0005",
                min_units: 40,
              },
              { status: 402 }
            );
      if (request.url.endsWith("/v1/quote")) return Response.json({ error: "policy_refused" }, { status: 403 });
      if (request.url.includes("coinbase.com"))
        return Response.json({ data: { base: "POL", currency: "USD", amount: "0.2" } });
      return new Response("not found", { status: 404 });
    }) as typeof fetch,
}));

// What the tool hands to track(), before the allow-list drops anything.
const tracked: Array<{ name: string; payload: Record<string, unknown> }> = [];
let realTelemetry: typeof import("../src/telemetry.js");
vi.mock("../src/telemetry.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/telemetry.js")>()),
  track: (name: string, payload: Record<string, unknown> = {}) => {
    tracked.push({ name, payload });
    realTelemetry.track(name, payload);
  },
}));
const FLOW = ["aifp1_challenge_received", "aifp1_receipt_cached_hit", "aifp1_receipt_cached_miss"];
const flowTracked = () => tracked.filter(({ name }) => FLOW.includes(name));

const ENV_KEYS = ["HOME", "AIFINPAY_TELEMETRY", "AIFINPAY_TELEMETRY_URL", "CI", "DO_NOT_TRACK"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  seen.splice(0);
  tracked.splice(0);
  for (const close of closers.splice(0)) await close();
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

async function collector(kind: "ok" | "fail" = "ok") {
  const bodies: string[] = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      bodies.push(body);
      res.statusCode = kind === "ok" ? 204 : 500;
      res.end();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  closers.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      })
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1/agent`,
    bodies,
    events: () =>
      bodies
        .flatMap((body) => JSON.parse(body).events)
        // The server's own start event is not part of a tool call.
        .filter(({ name }: { name: string }) => name !== "wallet_load_succeeded")
        .map(({ name, payload }: { name: string; payload: Record<string, unknown> }) => {
          const { ms: _ms, ...rest } = payload;
          return { name, payload: rest };
        }),
  };
}

/** Fresh modules under this environment, a server with a real agent, and a payable_fetch context on it. */
async function load(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  process.env.HOME = tempDir("aifp-ua-home-");
  Object.assign(process.env, env);
  vi.resetModules();
  const analytics = await import("@aifinpay/analytics");
  realTelemetry = await vi.importActual<typeof import("../src/telemetry.js")>("../src/telemetry.js");
  const { createServer } = await import("../src/server.js");
  const { PaymentStateStore } = await import("../src/payment-state.js");
  const payable = await import("../src/tools/payable-fetch.js");
  const walletHome = tempDir("aifp-ua-wallet-");
  const active = await createServer({ seedHash: "44".repeat(32), walletHome, logFn: () => {} });
  const agent = active.agent;
  const store = new PaymentStateStore(agent.evmAddress, walletHome);
  const ctx = {
    agent,
    log: () => {},
    paymentState: store,
    config: {
      paymentsEnabled: true,
      maxAmountUsd: 0.2,
      dailyAmountUsd: 0.3,
      maxGasPol: "0.05",
      payAsset: "POL",
      walletHome,
      gatewayOrigins: [origin],
      gatewayPathMode: "direct",
    },
  } as unknown as ToolContext;
  const holdReceipt = () => {
    const state = store.read();
    state.receipts = [
      {
        site: `direct:${JSON.stringify([origin, merchantId])}`,
        merchantId,
        receiptId: "rcpt_one",
        jwt: "private-bearer",
        scope: "exact",
        resource: "/private/data",
        unitQuota: 200,
        remaining: 199,
        expiresAt: Date.now() + 3_600_000,
        amountUsd: 0.1,
      },
    ];
    store.save(state);
  };
  const run = async () => JSON.stringify(await payable.runPayableFetch(ctx, { url }));
  return { analytics, agent, ctx, run, holdReceipt };
}

const send = (sink: string) => ({ AIFINPAY_TELEMETRY: "on", AIFINPAY_TELEMETRY_URL: sink });

function expectNothingPrivate(bodies: string[], address: string) {
  const all = bodies.join("\n").toLowerCase();
  for (const secret of ["merchant.example", "private", "/data", merchantId, address.slice(2, 12).toLowerCase()])
    expect(all).not.toContain(secret);
}

describe("User-Agent names the MCP and the SDK", () => {
  it("on the merchant request and the SDK's /v1/quote", async () => {
    const m = await load({ AIFINPAY_TELEMETRY: "off" });
    await m.run();
    expect(seen.map(({ method, url, agent }) => [method, url, agent])).toEqual([
      ["GET", url, FULL],
      ["POST", "https://api.aifinpay.io/v1/quote", FULL],
    ]);
  });

  it("in the merchant request the tool hands the SDK, whatever fetch the agent holds", async () => {
    const m = await load({ AIFINPAY_TELEMETRY: "off" });
    const fetchPaid = vi.fn(async (..._call: unknown[]) => new Response("content"));
    (m.ctx.agent as unknown as { fetchPaid: typeof fetchPaid }).fetchPaid = fetchPaid;
    await m.run();
    expect(new Headers((fetchPaid.mock.calls[0][1] as RequestInit).headers).get("user-agent")).toBe(MCP);
  });

  it("on the receipt-carrying merchant request", async () => {
    const m = await load({ AIFINPAY_TELEMETRY: "off" });
    m.holdReceipt();
    await m.run();
    expect(seen.filter((r) => r.receipt).map((r) => r.agent)).toEqual([FULL]);
  });

  it("on /v1/pay as the SDK sends it, in every header shape and as a Request", async () => {
    const m = await load({ AIFINPAY_TELEMETRY: "off" });
    const fetchImpl = m.agent.inner.fetchImpl;
    const pay = "https://api.aifinpay.io/v1/pay";
    await fetchImpl(pay, { method: "POST", headers: { "User-Agent": SDK_USER_AGENT }, body: "{}" });
    await fetchImpl(pay, { method: "POST", headers: new Headers({ "user-agent": SDK_USER_AGENT }), body: "{}" });
    await fetchImpl(pay, { method: "POST", headers: [["User-Agent", SDK_USER_AGENT]], body: "{}" });
    await fetchImpl(new Request(pay, { method: "POST", headers: { "User-Agent": SDK_USER_AGENT }, body: "{}" }));
    expect(seen.map((r) => r.agent)).toEqual([FULL, FULL, FULL, FULL]);
  });

  it("whole on the MCP's own API request", async () => {
    const m = await load({ AIFINPAY_TELEMETRY: "off" });
    const { readMerchant } = await import("../src/merchant-site.js");
    await readMerchant((input, init) => m.agent.inner.fetchImpl(input, init), "https://api.aifinpay.io", merchantId);
    expect(seen.map(({ url, agent }) => [url, agent])).toEqual([
      [`https://api.aifinpay.io/v1/merchants/${merchantId}`, FULL],
    ]);
  });

  it("not on chain RPC or public price feeds", async () => {
    const m = await load({ AIFINPAY_TELEMETRY: "off" });
    const { independentNativeUsd } = await import("../src/native-price.js");
    const { PAY_CHAINS } = await import("../src/pay-chains.js");
    await independentNativeUsd({
      fetchImpl: (input, init) => m.agent.inner.fetchImpl(input, init),
      chain: PAY_CHAINS.polygon,
      rpc: "https://rpc.example/polygon",
    });
    expect(seen.map((r) => new URL(r.url).host)).toEqual(["rpc.example", "api.coinbase.com"]);
    expect(seen.map((r) => r.agent)).toEqual([null, null]);
  });
});

describe("SDK flow events reach telemetry", () => {
  it("a miss, the 402 and a refused quote, each once, with the status in the failure", async () => {
    const sink = await collector();
    const m = await load(send(sink.url));
    await m.run();
    await m.analytics.shutdown();
    expect(sink.events()).toEqual([
      { name: "aifp1_receipt_cached_miss", payload: {} },
      { name: "aifp1_challenge_received", payload: { outcome: "direct", http_status: 402 } },
      { name: "aifp1_pay_failed", payload: { stage: "quote", error_class: "Aifp1QuoteError", http_status: 403 } },
    ]);
    expect(flowTracked()).toEqual([
      { name: "aifp1_receipt_cached_miss", payload: {} },
      { name: "aifp1_challenge_received", payload: { outcome: "direct", http_status: 402 } },
    ]);
    expectNothingPrivate([...sink.bodies, JSON.stringify(tracked)], m.agent.evmAddress);
  });

  it("a hit on the call that holds a receipt, once, and no challenge", async () => {
    const sink = await collector();
    const m = await load(send(sink.url));
    await m.run();
    m.holdReceipt();
    await m.run();
    await m.analytics.shutdown();
    expect(sink.events().slice(3)).toEqual([{ name: "aifp1_receipt_cached_hit", payload: {} }]);
    expect(flowTracked().slice(2)).toEqual([{ name: "aifp1_receipt_cached_hit", payload: {} }]);
    expectNothingPrivate([...sink.bodies, JSON.stringify(tracked)], m.agent.evmAddress);
  });

  it("a failing collector changes no answer", async () => {
    const answers = async (env: Record<string, string>) => {
      const m = await load(env);
      const refused = await m.run();
      m.holdReceipt();
      const held = await m.run();
      await m.analytics.shutdown();
      return [refused, held].map((text) => text.replace(/expiresAt\D*\d+/g, ""));
    };
    const failing = await collector("fail");
    const control = await answers({ AIFINPAY_TELEMETRY: "off" });
    expect(await answers(send(failing.url))).toEqual(control);
    expect(failing.bodies.length).toBeGreaterThan(0);
  });
});
