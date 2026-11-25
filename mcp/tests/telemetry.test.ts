import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Aifp1GatewayRetiredError, Aifp1ReceiptCache } from "@aifinpay/agent";
import type { ToolContext } from "../src/server.js";

vi.mock("../src/safe-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/safe-fetch.js")>()),
  makeSafeFetch: () => (async () => Response.json({ receipts: [] })) as typeof fetch,
}));

const ENV_KEYS = ["HOME", "AIFINPAY_TELEMETRY", "AIFINPAY_TELEMETRY_URL", "CI", "DO_NOT_TRACK"] as const;
const savedEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
const dirs: string[] = [];
const closers: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
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

type Collector = { url: string; bodies: string[]; events: () => Array<{ name: string; payload: any }> };

async function collector(kind: "ok" | "fail" | "hang" = "ok"): Promise<Collector> {
  const bodies: string[] = [];
  const server = createHttpServer((req, res) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      bodies.push(body);
      if (kind === "hang") return;
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
    events: () => bodies.flatMap((body) => JSON.parse(body).events),
  };
}

/** Fresh modules under exactly this environment; CI and DO_NOT_TRACK are cleared unless given. */
async function load(env: Partial<Record<(typeof ENV_KEYS)[number], string>>) {
  for (const key of ENV_KEYS) delete process.env[key];
  const home = tempDir("aifp-telemetry-home-");
  process.env.HOME = home;
  Object.assign(process.env, env);
  vi.resetModules();
  return {
    home,
    analytics: await import("@aifinpay/analytics"),
    telemetry: await import("../src/telemetry.js"),
    payable: await import("../src/tools/payable-fetch.js"),
    state: await import("../src/payment-state.js"),
    server: await import("../src/server.js"),
  };
}
type Loaded = Awaited<ReturnType<typeof load>>;

const address = "0x" + "12".repeat(20);
const tx = ("0x" + "ab".repeat(32)) as `0x${string}`;
const origin = "https://merchant.example";
const site = `direct:${JSON.stringify([origin, "merchant_one"])}`;
const receipt = {
  site,
  merchantId: "merchant_one",
  receiptId: "receipt_one",
  jwt: "private-bearer",
  scope: "exact" as const,
  resource: "/private/data",
  unitQuota: 200,
  remaining: 199,
  expiresAt: Date.now() + 3_600_000,
  amountUsd: 0.1,
};
const prepared = {
  apiBaseUrl: "https://api.aifinpay.io",
  paymentIssuer: "https://api.aifinpay.io",
  quote: {
    payer: address,
    settlement_call: { chain: "polygon", splitter_version: "1.4" },
    quote_id: "quote_one",
    merchant_id: "merchant_one",
    amount: "0.1",
    native_settlement: { total_wei: "1000000000000000000" },
  },
  txRef: tx,
  asset: "POL",
  chain: "polygon",
  serializedTransaction: "0xdeadbeef",
};
const args = { url: origin + "/private/data?q=secret" };

class V14SettlementError extends Error {
  override name = "V14SettlementError";
  constructor(public readonly code: string) {
    super(code);
  }
}

function fixture(m: Loaded, config: Record<string, unknown> = {}) {
  const walletHome = tempDir("aifp-telemetry-wallet-");
  const store = new m.state.PaymentStateStore(address, walletHome);
  const cache = new Aifp1ReceiptCache();
  const fetchPaid = vi.fn(async (..._call: any[]): Promise<Response | null> => new Response("content"));
  const recoverPaidPayment = vi.fn(async () => ({
    merchant_id: receipt.merchantId,
    receipt_id: receipt.receiptId,
    receipt: receipt.jwt,
    scope: receipt.scope,
    resource: receipt.resource,
    unit_quota: receipt.unitQuota,
    expires_at: new Date(receipt.expiresAt).toISOString(),
  }));
  const price = vi.fn(async () => Response.json({ data: { base: "POL", currency: "USD", amount: "0.1" } }));
  const ctx = {
    config: {
      paymentsEnabled: true,
      maxAmountUsd: 0.2,
      dailyAmountUsd: 0.3,
      maxGasPol: "0.05",
      walletHome,
      gatewayOrigins: [origin],
      gatewayPathMode: "direct",
      ...config,
    },
    paymentState: store,
    log: vi.fn(),
    agent: {
      evmAddress: address,
      aifp1Receipts: cache,
      fetchPaid,
      recoverPaidPayment,
      getReceiptCacheSummary: () => cache.list().map(({ jwt, ...entry }) => entry),
      inner: { fetchImpl: price, pay: vi.fn() },
    },
  } as unknown as ToolContext;
  return { ctx, store, cache, fetchPaid, recoverPaidPayment };
}

const payAndHold = (f: ReturnType<typeof fixture>) =>
  f.fetchPaid.mockImplementation(async (_url, _init, options) => {
    await options.nativeUsdPrice();
    await options.v14.onPrepared(prepared);
    f.cache.put(receipt);
    return new Response("content");
  });

const send = (url: string) => ({ AIFINPAY_TELEMETRY: "on", AIFINPAY_TELEMETRY_URL: url });

const quoted = { name: "aifp1_quote_obtained", payload: { network: "polygon", asset: "POL", usd_bucket: "<1" } };
const paid = { name: "aifp1_pay_succeeded", payload: { network: "polygon", asset: "POL", usd_bucket: "<1" } };

// Each row of the event table: set up the stage, then the exact events it must produce.
const ROWS: Array<{
  row: string;
  setup: (m: Loaded) => { ctx: ToolContext; args?: Record<string, unknown> };
  events: Array<{ name: string; payload: Record<string, unknown> }>;
}> = [
  {
    row: "not set up",
    setup: (m) => {
      const f = fixture(m);
      f.ctx.paymentState = undefined;
      return f;
    },
    events: [{ name: "aifp1_pay_failed", payload: { stage: "setup" } }],
  },
  {
    row: "site not approved by the owner",
    setup: (m) => ({ ...fixture(m), args: { url: "https://other.example/private?q=1" } }),
    events: [{ name: "budget_cap_exceeded", payload: { stage: "site" } }],
  },
  {
    row: "paid and receipt held",
    setup: (m) => {
      const f = fixture(m);
      payAndHold(f);
      return f;
    },
    events: [quoted, paid],
  },
  {
    row: "per-payment limit",
    setup: (m) => {
      const f = fixture(m, { maxAmountUsd: 0.05 });
      payAndHold(f);
      return f;
    },
    events: [quoted, { name: "budget_cap_exceeded", payload: { stage: "per_payment" } }],
  },
  {
    row: "daily limit",
    setup: (m) => {
      const f = fixture(m);
      const state = f.store.read();
      state.spend = [{ at: Date.now(), usd: 0.25, tx }];
      f.store.save(state);
      payAndHold(f);
      return f;
    },
    events: [quoted, { name: "budget_cap_exceeded", payload: { stage: "daily" } }],
  },
  {
    row: "SDK skipped the payment for the owner budget",
    setup: (m) => {
      const f = fixture(m);
      f.fetchPaid.mockResolvedValue(null);
      return f;
    },
    events: [{ name: "budget_cap_exceeded", payload: { stage: "per_payment" } }],
  },
  {
    row: "gas cap",
    setup: (m) => {
      const f = fixture(m);
      f.fetchPaid.mockRejectedValue(new V14SettlementError("V14_GAS_BUDGET_EXCEEDED"));
      return f;
    },
    events: [{ name: "budget_cap_exceeded", payload: { stage: "gas" } }],
  },
  {
    row: "failed at the quote",
    setup: (m) => {
      const f = fixture(m);
      f.fetchPaid.mockRejectedValue(new Error(`quote refused for ${origin}/private`));
      return f;
    },
    events: [{ name: "aifp1_pay_failed", payload: { stage: "quote", error_class: "Error" } }],
  },
  {
    row: "retired gateway",
    setup: (m) => {
      const f = fixture(m);
      f.fetchPaid.mockRejectedValue(new Aifp1GatewayRetiredError(origin));
      return f;
    },
    events: [
      {
        name: "aifp1_pay_failed",
        payload: { stage: "quote", error_class: "Aifp1GatewayRetiredError", http_status: 410 },
      },
    ],
  },
  {
    row: "failed verifying the site",
    setup: (m) => {
      const f = fixture(m, { gatewayOrigins: undefined });
      payAndHold(f);
      return f;
    },
    events: [
      quoted,
      { name: "aifp1_pay_failed", payload: { stage: "verify_site", error_class: "UnverifiedMerchantSiteError" } },
    ],
  },
  {
    row: "failed at settlement",
    setup: (m) => {
      const f = fixture(m);
      f.fetchPaid.mockRejectedValue(new V14SettlementError("V14_PAUSED"));
      return f;
    },
    events: [{ name: "aifp1_pay_failed", payload: { stage: "settle", error_class: "V14SettlementError" } }],
  },
  {
    row: "failed after the payment was recorded",
    setup: (m) => {
      const f = fixture(m);
      f.fetchPaid.mockImplementation(async (_url, _init, options) => {
        await options.nativeUsdPrice();
        await options.v14.onPrepared(prepared);
        throw new Error("unknown submission result");
      });
      return f;
    },
    events: [quoted, { name: "aifp1_pay_failed", payload: { stage: "pay", error_class: "Error" } }],
  },
  {
    row: "paid, then the content retry failed",
    setup: (m) => {
      const f = fixture(m);
      f.fetchPaid.mockImplementation(async (_url, _init, options) => {
        await options.nativeUsdPrice();
        await options.v14.onPrepared(prepared);
        f.cache.put(receipt);
        throw new Error("content network failure");
      });
      return f;
    },
    events: [quoted, paid, { name: "aifp1_pay_failed", payload: { stage: "retry", error_class: "Error" } }],
  },
  {
    row: "recovered an earlier payment",
    setup: (m) => {
      const f = fixture(m);
      const state = f.store.read();
      state.pending = { recovery: prepared, serializedTransaction: "0xdeadbeef", site, amountUsd: 0.1 } as any;
      state.spend = [{ at: Date.now(), usd: 0.1, tx }];
      f.store.save(state);
      return f;
    },
    events: [
      { name: "aifp1_recovery_attempted", payload: {} },
      { name: "aifp1_recovery_succeeded", payload: {} },
    ],
  },
  {
    row: "recovery failed",
    setup: (m) => {
      const f = fixture(m);
      const state = f.store.read();
      state.pending = { recovery: prepared, serializedTransaction: "0xdeadbeef", site, amountUsd: 0.1 } as any;
      f.store.save(state);
      f.recoverPaidPayment.mockRejectedValue(new Error("not confirmed"));
      return f;
    },
    events: [
      { name: "aifp1_recovery_attempted", payload: {} },
      { name: "aifp1_recovery_failed", payload: { error_class: "Error" } },
    ],
  },
];

const withoutMs = (events: Array<{ name: string; payload: any }>) =>
  events.map(({ name, payload }) => {
    const { ms, ...rest } = payload;
    if (ms !== undefined) expect(Number.isInteger(ms) && ms >= 0).toBe(true);
    return { name, payload: rest };
  });

function expectNothingPrivate(bodies: string[]) {
  const all = bodies.join("\n");
  for (const secret of ["merchant.example", "private", "secret", address.slice(2, 10), "deadbeef", tx.slice(2, 10)])
    expect(all).not.toContain(secret);
}

describe("payable_fetch telemetry, one event per stage", () => {
  it.each(ROWS)("$row", async ({ setup, events }) => {
    const sink = await collector();
    const m = await load(send(sink.url));
    const { ctx, args: own } = setup(m);
    await m.payable.runPayableFetch(ctx, own ?? args);
    await m.analytics.shutdown();
    expect(withoutMs(sink.events())).toEqual(events);
    expectNothingPrivate(sink.bodies);
  });
});

describe("server telemetry", () => {
  async function connect(m: Loaded, config: Record<string, unknown>) {
    const active = await m.server.createServer({ logFn: () => {}, ...config });
    const client = new Client({ name: "telemetry-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await active.server.connect(right);
    await client.connect(left);
    closers.push(async () => {
      await client.close();
      await active.server.close();
    });
    return client;
  }

  it("reports the wallet load and the first tool call of the process, once", async () => {
    const sink = await collector();
    const m = await load(send(sink.url));
    const client = await connect(m, { seedHash: "44".repeat(32), walletHome: tempDir("aifp-telemetry-wallet-") });
    await client.callTool({ name: "agent_address", arguments: {} });
    await client.callTool({ name: "agent_address", arguments: {} });
    await m.analytics.shutdown();
    expect(sink.events().map(({ name, payload }) => ({ name, payload }))).toEqual([
      { name: "wallet_load_succeeded", payload: {} },
      {
        name: "agent_sdk_first_invocation",
        payload: { mcp_version: m.telemetry.MCP_VERSION, persistent_wallet: true },
      },
    ]);
  });

  it("reports an ephemeral start as a non-persistent first call and no wallet load", async () => {
    const sink = await collector();
    const m = await load(send(sink.url));
    const client = await connect(m, { walletHome: tempDir("aifp-telemetry-wallet-") });
    await client.callTool({ name: "agent_address", arguments: {} });
    await m.analytics.shutdown();
    expect(sink.events().map(({ name, payload }) => ({ name, payload }))).toEqual([
      {
        name: "agent_sdk_first_invocation",
        payload: { mcp_version: m.telemetry.MCP_VERSION, persistent_wallet: false },
      },
    ]);
  });

  it("tells a keystore that cannot be decrypted from one that cannot be loaded", async () => {
    const sink = await collector();
    const m = await load(send(sink.url));
    const walletHome = tempDir("aifp-telemetry-wallet-");
    writeFileSync(join(walletHome, "agent.json"), JSON.stringify({ enc: "scrypt-aes-256-gcm" }), { mode: 0o600 });
    await expect(m.server.createServer({ walletHome, logFn: () => {} })).rejects.toThrow(/Encrypted keystore/);
    await expect(
      m.server.createServer({ agentsFile: join(walletHome, "missing.json"), logFn: () => {} })
    ).rejects.toThrow(/does not exist/);
    await m.analytics.shutdown();
    expect(sink.events().map(({ name, payload }) => ({ name, payload }))).toEqual([
      { name: "wallet_decrypt_failed", payload: { error_class: "Error" } },
      { name: "wallet_load_failed", payload: { error_class: "Error" } },
    ]);
    expectNothingPrivate(sink.bodies);
  });
});

describe("turning it off", () => {
  it.each([{ AIFINPAY_TELEMETRY: "off" }, { DO_NOT_TRACK: "1" }, { CI: "true" }])(
    "%o: no network call and no file written",
    async (env) => {
      const m = await load(env);
      const fetchSpy = vi.fn(async () => new Response(null, { status: 204 }));
      vi.stubGlobal("fetch", fetchSpy);
      m.telemetry.track("agent_sdk_first_invocation", { mcp_version: "1.0.0" });
      const f = fixture(m);
      payAndHold(f);
      await m.payable.runPayableFetch(f.ctx, args);
      await m.analytics.shutdown();
      expect(fetchSpy).not.toHaveBeenCalled();
      expect(existsSync(join(m.home, ".aifinpay"))).toBe(false);
    }
  );

  it("unset sends and stores the install id", async () => {
    const sink = await collector();
    const m = await load({ AIFINPAY_TELEMETRY_URL: sink.url });
    m.telemetry.track("agent_sdk_first_invocation", { mcp_version: "1.0.0" });
    await m.analytics.shutdown();
    expect(sink.events().map(({ name }) => name)).toEqual(["agent_sdk_first_invocation"]);
    expect(existsSync(join(m.home, ".aifinpay", ".telemetry-id"))).toBe(true);
  });
});

describe("telemetry never changes a tool's answer", () => {
  const scenarios: Array<[string, (m: Loaded) => ReturnType<typeof fixture>]> = [
    [
      "paid",
      (m) => {
        const f = fixture(m);
        payAndHold(f);
        return f;
      },
    ],
    [
      "failed at the quote",
      (m) => {
        const f = fixture(m);
        f.fetchPaid.mockRejectedValue(new Error("quote refused"));
        return f;
      },
    ],
  ];

  it.each(scenarios)("%s: same bytes with a failing or hanging collector, and no wait", async (_name, setup) => {
    const run = async (env: Record<string, string>) => {
      const m = await load(env);
      const started = Date.now();
      const result = await m.payable.runPayableFetch(setup(m).ctx, args);
      return { text: JSON.stringify(result), ms: Date.now() - started, m };
    };
    const off = await run({ AIFINPAY_TELEMETRY: "off" });
    const failing = await collector("fail");
    const withFailing = await run(send(failing.url));
    await withFailing.m.analytics.shutdown();
    expect(failing.bodies.length).toBeGreaterThan(0);
    const hanging = await collector("hang");
    const withHanging = await run(send(hanging.url));
    expect(withFailing.text).toBe(off.text);
    expect(withHanging.text).toBe(off.text);
    // Against the same run with telemetry off: an awaited send would add the 1.5 s timeout.
    expect(withHanging.ms - off.ms).toBeLessThan(1000);
  });

  it("writes nothing to stdout, the JSON-RPC channel", async () => {
    const run = async (env: Record<string, string>) => {
      const m = await load(env);
      const out: string[] = [];
      const err: string[] = [];
      vi.spyOn(process.stdout, "write").mockImplementation((chunk: any) => (out.push(String(chunk)), true));
      vi.spyOn(process.stderr, "write").mockImplementation((chunk: any) => (err.push(String(chunk)), true));
      try {
        const active = await m.server.createServer({
          seedHash: "44".repeat(32),
          walletHome: tempDir("aifp-telemetry-wallet-"),
          logFn: () => {},
        });
        const client = new Client({ name: "telemetry-test", version: "1" });
        const [left, right] = InMemoryTransport.createLinkedPair();
        await active.server.connect(right);
        await client.connect(left);
        await client.callTool({ name: "agent_address", arguments: {} });
        const f = fixture(m);
        payAndHold(f);
        await m.payable.runPayableFetch(f.ctx, args);
        await m.analytics.shutdown();
        await client.close();
        await active.server.close();
      } finally {
        vi.restoreAllMocks();
      }
      return { out: out.join(""), err: err.join("") };
    };
    const sink = await collector();
    const on = await run({ AIFINPAY_TELEMETRY_URL: sink.url });
    const off = await run({ AIFINPAY_TELEMETRY: "off" });
    expect(sink.events().length).toBeGreaterThan(0);
    expect(on.err).toContain("AIFINPAY_TELEMETRY=off");
    expect(on.out).toBe(off.out);
  });
});

describe("payload allow-list", () => {
  it("drops URLs, addresses, receipts and passphrases before the package sees them", async () => {
    const sink = await collector();
    const m = await load(send(sink.url));
    const url = "https://merchant.example/private/path?q=secret";
    const solana = "7Np41oeYqPefeNQEHSv1UDhYrehxin3NStELsSKCT4K2";
    const jwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ2VudCJ9.c2lnbmF0dXJlLXNlY3JldA";
    const passphrase = "correct horse battery staple";
    m.telemetry.track("aifp1_pay_failed", {
      url,
      resource: url,
      stage: url,
      network: solana,
      asset: passphrase,
      error_class: jwt,
      tool: address,
      outcome: url,
      http_status: url,
      receipt: jwt,
      passphrase,
      address,
      merchant: "merchant_one",
    });
    m.telemetry.track("aifp1_pay_failed", { stage: "quote", network: "polygon", asset: "USDC", http_status: 402 });
    await m.analytics.shutdown();
    const all = sink.bodies.join("\n");
    for (const secret of [
      "merchant.example",
      "private",
      "secret",
      solana.slice(0, 4),
      solana.slice(-4),
      address.slice(2, 6),
      address.slice(-4),
      "eyJ",
      "horse",
      "merchant_one",
    ])
      expect(all).not.toContain(secret);
    expect(sink.events().map(({ payload }) => payload)).toEqual([
      {},
      { stage: "quote", network: "polygon", asset: "USDC", http_status: 402 },
    ]);
  });

  it("buckets amounts instead of sending them", async () => {
    const m = await load({ AIFINPAY_TELEMETRY: "off" });
    expect([0.05, 0.1, 0.99, 1, 4.99, 5, 20].map(m.telemetry.usdBucket)).toEqual([
      "<0.1",
      "<1",
      "<1",
      "<5",
      "<5",
      ">=5",
      ">=5",
    ]);
    expect(m.telemetry.usdBucket(NaN)).toBeUndefined();
  });
});
