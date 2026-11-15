// A linked agent reports a non-secret summary of its local settings to the owner's dashboard, signed by its own key.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";
import type { ToolContext } from "../src/server.js";

// The cross-repo fixture: aifinpay-web tests the same string.
const FIXTURE =
  '["AiFinPay agent local settings v1","https://api.aifinpay.io","0x00000000000000000000000000000000000000aa",1763222400,{"mcp_version":"2.17.0","payments_enabled":true,"site_origins":["https://news.example"],"max_usd":5,"daily_usd":20,"pay_chain":"polygon","pay_asset":"USDC"}]';
const KEYS = ["mcp_version", "payments_enabled", "site_origins", "max_usd", "daily_usd", "pay_chain", "pay_asset"];
const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;
const PRIVATE_KEY = `0x${"5c".repeat(32)}` as const;
const signer = privateKeyToAccount(PRIVATE_KEY);
const lower = signer.address.toLowerCase();
const config = {
  paymentsEnabled: true,
  maxAmountUsd: 5,
  dailyAmountUsd: 20,
  gatewayOrigins: ["https://news.example"],
  payAsset: "USDC",
};
const policy = { per_tx_cap_usd: 2.5, daily_cap_usd: 10, merchant_allowlist: null, expires_at: null, paused: false };

type Report = (init?: RequestInit) => Response | Promise<Response>;
const stored: Report = () => Response.json({ stored: true, reported_at: 1763222400 });
const OUTCOMES: Record<string, Report> = {
  "200": stored,
  "404": () => Response.json({ error: "agent_not_claimed" }, { status: 404 }),
  "409": () => Response.json({ error: "local_settings_stale" }, { status: 409 }),
  "500": () => new Response("boom", { status: 500 }),
  timeout: () => Promise.reject(new DOMException("The operation was aborted due to timeout", "TimeoutError")),
  "network error": () => Promise.reject(new TypeError("fetch failed")),
};

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

/** A fresh module graph, as in a new server process. */
async function fresh() {
  vi.resetModules();
  return {
    ...(await import("../src/local-settings.js")),
    ...(await import("../src/tools/payment-setup-status.js")),
    ...(await import("../src/tools/agent-claim-self.js")),
  };
}

/** The backend, the pay chain's RPC and a price source; `report` answers the local-settings route. */
function backend(report: Report, policyAnswer: Response | Record<string, unknown> = { claimed: true, policy }) {
  return vi.fn(async (input: string, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith("/local-settings")) return report(init);
    if (url.endsWith("/policy"))
      return policyAnswer instanceof Response ? policyAnswer.clone() : Response.json(policyAnswer);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (body?.method === "eth_getBalance")
      return Response.json({ jsonrpc: "2.0", id: 1, result: "0x" + (10n ** 18n).toString(16) });
    if (body?.method === "eth_call") return new Response("no feed", { status: 500 });
    if (url.includes("coinbase")) return Response.json({ data: { base: "POL", currency: "USD", amount: "0.20" } });
    return new Response("unexpected", { status: 500 });
  });
}
type Backend = ReturnType<typeof backend>;
const reports = (f: Backend) => f.mock.calls.filter(([url]) => String(url).endsWith("/local-settings"));
const sentBody = (f: Backend, n = 0) => JSON.parse(String(reports(f)[n][1]?.body));
const structured = (result: unknown) => (result as { structuredContent?: unknown }).structuredContent;

function ctx(
  f: Backend,
  overrides: Record<string, unknown> = {},
  account: { address: string; signMessage: unknown } = signer
): ToolContext {
  return {
    config: { walletHome: mkdtempSync(join(tmpdir(), "aifp-mcp-local-")), ...config, ...overrides },
    walletSource: "legacy-keystore",
    log: vi.fn(),
    agent: { evmAddress: account.address, evmAccount: account, inner: { fetchImpl: f } },
  } as unknown as ToolContext;
}

describe("local settings report", () => {
  it("reproduces the cross-repo fixture byte for byte, keys in the contract's order", async () => {
    const m = await fresh();
    const settings = m.localSettings({ ...config, payChain: "polygon" })!;
    expect(Object.keys(settings)).toEqual(KEYS);
    const statement = m.localSettingsStatement(
      "https://api.aifinpay.io",
      "0x00000000000000000000000000000000000000aa",
      1763222400,
      { ...settings, mcp_version: "2.17.0" }
    );
    expect(statement).toBe(FIXTURE);
  });

  it("POSTs exactly the signed settings, with both agent headers, signed by the agent's own key", async () => {
    const m = await fresh();
    const f = backend(stored);
    const before = Math.floor(Date.now() / 1000);
    await m.reportLocalSettings(ctx(f));
    expect(reports(f)).toHaveLength(1);
    const [[url, init]] = reports(f);
    expect(url).toBe(`https://api.aifinpay.io/v1/agents/${lower}/local-settings`);
    expect(init?.method).toBe("POST");
    expect(init?.redirect).toBe("manual");
    const headers = new Headers(init?.headers);
    expect(headers.get("content-type")).toBe("application/json");
    const expiresAt = Number(headers.get("aifp-agent-expires"));
    expect(expiresAt).toBeGreaterThan(before);
    expect(expiresAt).toBeLessThanOrEqual(before + 300);
    const body = sentBody(f);
    expect(Object.keys(body)).toEqual(KEYS);
    expect(body).toEqual({
      mcp_version: VERSION,
      payments_enabled: true,
      site_origins: ["https://news.example"],
      max_usd: 5,
      daily_usd: 20,
      pay_chain: "polygon",
      pay_asset: "USDC",
    });
    const message = m.localSettingsStatement("https://api.aifinpay.io", lower, expiresAt, body);
    const signature = headers.get("aifp-agent-signature") as `0x${string}`;
    expect(await verifyMessage({ address: signer.address, message, signature })).toBe(true);
  });

  it("names the backend this server pays through as the issuer, without a trailing slash", async () => {
    const m = await fresh();
    const f = backend(stored);
    await m.reportLocalSettings(ctx(f, { baseUrl: "https://dev-api.aifinpay.io/" }));
    const [[url, init]] = reports(f);
    expect(url).toBe(`https://dev-api.aifinpay.io/v1/agents/${lower}/local-settings`);
    const headers = new Headers(init?.headers);
    const message = m.localSettingsStatement(
      "https://dev-api.aifinpay.io",
      lower,
      Number(headers.get("aifp-agent-expires")),
      sentBody(f)
    );
    const signature = headers.get("aifp-agent-signature") as `0x${string}`;
    expect(await verifyMessage({ address: signer.address, message, signature })).toBe(true);
  });

  it("with nothing set: payments off is false, no site list is null, the asset is the chain's native one", async () => {
    const m = await fresh();
    const f = backend(stored);
    await m.reportLocalSettings(
      ctx(f, {
        paymentsEnabled: undefined,
        gatewayOrigins: undefined,
        payAsset: undefined,
        payChain: "base",
        maxGas: "0.001",
      })
    );
    expect(Object.keys(sentBody(f))).toEqual(KEYS);
    expect(sentBody(f)).toEqual({
      mcp_version: VERSION,
      payments_enabled: false,
      site_origins: null,
      max_usd: 5,
      daily_usd: 20,
      pay_chain: "base",
      pay_asset: "ETH",
    });
  });

  it("sends the seven keys and none of the secrets, paths or hosts in config, and logs nothing", async () => {
    vi.stubEnv("AIFINPAY_CLAIM_ORIGINS", "https://claim-origin.example");
    const secrets = {
      walletPassphrase: "passphrase-value",
      seedHash: "ab".repeat(32),
      agentSecretB58: "agentSecretB58Value",
      walletHome: "/Users/owner/.aifinpay-private-home",
      agentsFile: "/Users/owner/project/agents-file.json",
      agentId: "agent-id-value",
      rpcUrl: "https://rpc.example/v2/rpc-api-key-value",
      trustedHosts: ["trusted-host.example"],
      baseUrl: "https://api.aifinpay.io",
    };
    const m = await fresh();
    const f = backend(stored);
    const c = ctx(f, secrets);
    await m.reportLocalSettings(c);
    const [[, init]] = reports(f);
    const raw = String(init?.body);
    expect(Object.keys(JSON.parse(raw))).toEqual(KEYS);
    const sent = raw + JSON.stringify([...new Headers(init?.headers)]);
    for (const value of [
      ...Object.values(secrets).flat(),
      "rpc-api-key-value",
      "api.aifinpay.io",
      "https://claim-origin.example",
      PRIVATE_KEY.slice(2),
    ])
      expect(sent).not.toContain(value);
    expect(c.log).not.toHaveBeenCalled();
  });

  it("reports once per process per address and settings; changed settings or another wallet report again", async () => {
    const m = await fresh();
    const f = backend(stored);
    await m.reportLocalSettings(ctx(f));
    await m.reportLocalSettings(ctx(f));
    expect(reports(f)).toHaveLength(1);
    await m.reportLocalSettings(ctx(f, { maxAmountUsd: 4 }));
    await m.reportLocalSettings(ctx(f, { maxAmountUsd: 4 }));
    expect(reports(f)).toHaveLength(2);
    expect(sentBody(f, 1).max_usd).toBe(4);
    const other = privateKeyToAccount(`0x${"6d".repeat(32)}`);
    await m.reportLocalSettings(ctx(f, {}, other));
    expect(reports(f)).toHaveLength(3);
    expect(reports(f)[2][0]).toBe(`https://api.aifinpay.io/v1/agents/${other.address.toLowerCase()}/local-settings`);
    const restarted = await fresh();
    await restarted.reportLocalSettings(ctx(f));
    expect(reports(f)).toHaveLength(4);
  });

  it("a 409 counts as reported; any other answer is retried on the next call, one request per call", async () => {
    const answers: [string, Report, boolean][] = [
      ["409", OUTCOMES["409"], false],
      ["503", () => Response.json({ error: "db_not_ready" }, { status: 503 }), true],
      ["404", OUTCOMES["404"], true],
      ["500", OUTCOMES["500"], true],
      ["400", () => Response.json({ error: "local_settings_invalid" }, { status: 400 }), true],
      ["302", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } }), true],
      ["network error", OUTCOMES["network error"], true],
    ];
    for (const [name, answer, retried] of answers) {
      const m = await fresh();
      const f = backend(answer);
      await expect(m.reportLocalSettings(ctx(f)), name).resolves.toBeUndefined();
      expect(reports(f), name).toHaveLength(1);
      await expect(m.reportLocalSettings(ctx(f)), name).resolves.toBeUndefined();
      expect(reports(f), name).toHaveLength(retried ? 2 : 1);
    }
  });

  it("a timeout of at most 5 s aborts the request without throwing, and the next call tries again", async () => {
    const m = await fresh();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(controller.signal);
    const hanging = backend(
      (init) =>
        new Promise<Response>((_, reject) => {
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
          controller.abort(new DOMException("The operation was aborted due to timeout", "TimeoutError"));
        })
    );
    await expect(m.reportLocalSettings(ctx(hanging))).resolves.toBeUndefined();
    expect(timeout).toHaveBeenCalledTimes(1);
    expect(timeout.mock.calls[0][0]).toBeGreaterThan(0);
    expect(timeout.mock.calls[0][0]).toBeLessThanOrEqual(5_000);
    expect(reports(hanging)[0][1]?.signal).toBe(controller.signal);
    timeout.mockRestore();
    const f = backend(stored);
    await m.reportLocalSettings(ctx(f));
    expect(reports(f)).toHaveLength(1);
  });

  it("signs and sends nothing when the pay chain or a USD cap cannot be reported", async () => {
    for (const overrides of [
      { payChain: "no-such-chain" },
      { gatewayOrigins: ["https://news.example/"] },
      { payAsset: "NOT-PINNED" },
      { maxAmountUsd: undefined },
      { maxAmountUsd: Number.NaN },
      { maxAmountUsd: 0 },
      { dailyAmountUsd: -1 },
      { dailyAmountUsd: Number.POSITIVE_INFINITY },
    ]) {
      const m = await fresh();
      const f = backend(stored);
      const c = ctx(f, overrides);
      const sign = vi.spyOn(c.agent.evmAccount, "signMessage");
      expect(m.localSettings(c.config), JSON.stringify(overrides)).toBeUndefined();
      await m.reportLocalSettings(c);
      expect(sign).not.toHaveBeenCalled();
      expect(f).not.toHaveBeenCalled();
      sign.mockRestore();
    }
  });

  it("never throws when the signer fails or the context is incomplete", async () => {
    const m = await fresh();
    const f = backend(stored);
    const c = ctx(f);
    vi.spyOn(c.agent.evmAccount, "signMessage").mockRejectedValue(new Error("signer unavailable"));
    await expect(m.reportLocalSettings(c)).resolves.toBeUndefined();
    expect(f).not.toHaveBeenCalled();
    await expect(m.reportLocalSettings({ agent: {} } as unknown as ToolContext)).resolves.toBeUndefined();
  });
});

describe("payment_setup_status reports for a linked agent", () => {
  it("reports right after the dashboard read says linked, and never otherwise", async () => {
    let m = await fresh();
    let f = backend(stored);
    await m.paymentSetupStatus(ctx(f), { readBalance: true });
    expect(reports(f)).toHaveLength(1);
    await m.paymentSetupStatus(ctx(f), { readBalance: true });
    expect(reports(f)).toHaveLength(1);

    for (const unlinked of [
      Response.json({ error: "agent_not_claimed" }, { status: 404 }),
      new Response("down", { status: 503 }),
      Response.json({ claimed: true, policy: { ...policy, paused: "no" } }),
    ]) {
      m = await fresh();
      f = backend(stored, unlinked);
      const status = await m.paymentSetupStatus(ctx(f), { readBalance: true });
      expect(status.dashboard?.linked).not.toBe(true);
      expect(reports(f)).toHaveLength(0);
    }

    m = await fresh();
    f = backend(stored);
    await m.paymentSetupStatus(ctx(f), { readBalance: false });
    const ephemeral = ctx(f);
    ephemeral.walletSource = "ephemeral";
    await m.paymentSetupStatus(ephemeral, { readBalance: true });
    await m.paymentSetupStatus(ctx(f, { payChain: "solana", payAsset: undefined }), { readBalance: true });
    expect(reports(f)).toHaveLength(0);
  });

  it("a linked agent with payments turned off reports payments_enabled false", async () => {
    const m = await fresh();
    const f = backend(stored);
    const status = await m.paymentSetupStatus(ctx(f, { paymentsEnabled: false }), { readBalance: true });
    expect(status.dashboard?.linked).toBe(true);
    expect(sentBody(f).payments_enabled).toBe(false);
  });

  it("answers the same whatever the report gets back: 200, 404, 409, 500, a timeout or a network error", async () => {
    const results: unknown[] = [];
    for (const [name, answer] of Object.entries(OUTCOMES)) {
      const m = await fresh();
      const f = backend(answer);
      results.push(await m.runPaymentSetupStatus(ctx(f), {}));
      expect(reports(f), name).toHaveLength(1);
    }
    expect(structured(results[0])).toMatchObject({ ready: true, dashboard: { linked: true } });
    for (const result of results) expect(result).toEqual(results[0]);
  });
});

describe("agent_claim_self reports after an EVM claim", () => {
  const key = nacl.sign.keyPair.fromSeed(new Uint8Array(32).fill(23));
  const sol = bs58.encode(key.publicKey);
  const link = "https://dash.aifinpay.io/api/auth/verify?token=synthetic-claim-token";

  /** The claim exchange on the link's origin; `confirm` overrides the claim answer per address. */
  function claimExchange(confirm: Record<string, unknown> = {}) {
    return vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}) => {
      const url = String(input);
      if (url.endsWith("/api/auth/claim"))
        return Response.json(
          { ok: true, grant: "agent_claim", expires_in: 600 },
          { headers: { "set-cookie": "__aifinpay_agent_claim=synthetic-cookie; Path=/api/me/agents" } }
        );
      const body = init.body ? JSON.parse(String(init.body)) : {};
      const address: string = body.address ?? body.challenge_id;
      const chain = address.startsWith("0x") ? "polygon" : "solana";
      if (url.endsWith("/challenge"))
        return Response.json({
          challenge_id: address,
          message: `AiFinPay-claim:${chain}:${address}:${"a".repeat(32)}`,
        });
      return Response.json(address in confirm ? confirm[address] : { ok: true, chain, agent_address: address });
    });
  }

  function claimCtx(f: Backend, payChain?: string): ToolContext {
    return {
      config: { ...config, ...(payChain ? { payChain, payAsset: undefined } : {}) },
      log: vi.fn(),
      agent: {
        evmAddress: signer.address,
        solanaAddress: sol,
        evmAccount: signer,
        inner: { secretKey: key.secretKey, fetchImpl: f },
      },
    } as unknown as ToolContext;
  }

  it("reports to the configured backend once the EVM wallet is linked, never to the claim link's origin", async () => {
    const m = await fresh();
    const exchange = claimExchange();
    vi.stubGlobal("fetch", exchange);
    const f = backend(stored);
    const result = await m.runAgentClaimSelf(claimCtx(f), { magic_link_url: link });
    expect(result).not.toHaveProperty("isError");
    expect(structured(result)).toMatchObject({ primary_family: "evm", polygon_claim: "ok" });
    expect(reports(f)).toHaveLength(1);
    expect(reports(f)[0][0]).toBe(`https://api.aifinpay.io/v1/agents/${lower}/local-settings`);
    expect(Object.keys(sentBody(f))).toEqual(KEYS);
    expect(exchange.mock.calls.some(([url]) => String(url).includes("local-settings"))).toBe(false);
  });

  it("does not report after a Solana claim, even when the EVM wallet is linked too", async () => {
    const m = await fresh();
    vi.stubGlobal("fetch", claimExchange());
    const f = backend(stored);
    const result = await m.runAgentClaimSelf(claimCtx(f, "solana"), { magic_link_url: link });
    expect(structured(result)).toMatchObject({ primary_family: "solana", solana_claim: "ok", polygon_claim: "ok" });
    expect(reports(f)).toHaveLength(0);
  });

  it("does not report when the EVM claim fails", async () => {
    const m = await fresh();
    vi.stubGlobal("fetch", claimExchange({ [signer.address]: { ok: false } }));
    const f = backend(stored);
    const result = await m.runAgentClaimSelf(claimCtx(f), { magic_link_url: link });
    expect(result).toHaveProperty("isError", true);
    expect(reports(f)).toHaveLength(0);
  });

  it("answers the same whatever the report gets back: 200, 404, 409, 500, a timeout or a network error", async () => {
    const results: unknown[] = [];
    for (const [name, answer] of Object.entries(OUTCOMES)) {
      const m = await fresh();
      vi.stubGlobal("fetch", claimExchange());
      const f = backend(answer);
      results.push(await m.runAgentClaimSelf(claimCtx(f), { magic_link_url: link }));
      expect(reports(f), name).toHaveLength(1);
    }
    expect(structured(results[0])).toMatchObject({ ok: true });
    for (const result of results) expect(result).toEqual(results[0]);
  });
});
