import { describe, expect, it } from "vitest";
import {
  runSettlementInvoice,
  runSettlementSolana,
  runSettlementCasper,
  runSettlementRoutes,
} from "../src/tools/production-control.js";
import type { ToolContext } from "../src";

function ctx(overrides?: { fetchImpl?: typeof fetch; baseUrl?: string }): ToolContext {
  return {
    config: overrides?.baseUrl ? { baseUrl: overrides.baseUrl } : {},
    agent: {
      evmAddress: "0x" + "ab".repeat(20),
      inner: { fetchImpl: overrides?.fetchImpl ?? ((async () => Response.json({})) as typeof fetch) },
    },
    log: () => {},
  } as unknown as ToolContext;
}

/**
 * The backend as the 2026-10-19 agent test saw it: GET /v1/settlement/routes
 * describes only splitter v1.3 and every one of its routes is disabled, while
 * the issuer's health and x402 documents name the chains served on v1.4.
 */
function backend(served: string[] = ["polygon-mainnet", "base-mainnet"]) {
  const calls: string[] = [];
  const legacyRoutes = ["polygon", "base", "arbitrum", "optimism"].flatMap((chain) =>
    ["AIFP-1", "AIFP-2"].map((route_class) => ({
      route_class,
      chain,
      splitter_version: "1.3",
      live: false,
      reason: "settlement is not enabled",
    }))
  );
  const fetchImpl = (async (url: any, init?: any) => {
    const target = String(url);
    calls.push(target);
    if (target.endsWith("/api/health")) return Response.json({ status: "ok", chains: served });
    if (target.endsWith("/.well-known/x402.json"))
      return Response.json({
        protocol: "AIFP-1",
        networks: Object.fromEntries(served.map((c) => [c, { live: true }])),
      });
    if (target.includes("/v1/settlement/routes")) {
      const wanted = new URL(target).searchParams.get("route_class");
      return Response.json({ routes: legacyRoutes.filter((r) => !wanted || r.route_class === wanted) });
    }
    throw new Error(`unexpected request ${target} ${init?.method ?? "GET"}`);
  }) as typeof fetch;
  return { fetchImpl, calls };
}
const parse = (result: { content: Array<{ text: string }> }) => JSON.parse(result.content[0].text);

describe("settlement_routes", () => {
  it("shows Polygon and Base v1.4 live first, even when every v1.3 route is disabled", async () => {
    const b = backend();
    const result = await runSettlementRoutes(ctx({ fetchImpl: b.fetchImpl }), {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0].text;
    expect(text.indexOf('"v14"')).toBeLessThan(text.indexOf('"legacy_v13"'));
    const { v14, legacy_v13 } = parse(result);
    expect(v14.routes[0]).toMatchObject({
      route_class: "AIFP-1",
      chain: "polygon",
      chain_id: 137,
      assets: ["POL", "USDC", "USDC.e"],
      splitter_version: "1.4",
      live: true,
      served_by_backend: true,
      quote_endpoint: "https://api.aifinpay.io/v1/quote",
      pay_endpoint: "https://api.aifinpay.io/v1/pay",
      pay_with: "payable_fetch",
    });
    expect(v14.routes[1]).toMatchObject({ chain: "base", chain_id: 8453, assets: ["ETH", "USDC"], live: true });
    const rest = v14.routes.slice(2);
    expect(rest.length).toBeGreaterThan(0);
    for (const route of rest)
      expect(route).toMatchObject({ live: false, served_by_backend: false, deployment_enabled: true });
    expect(v14.routes.map((r: any) => r.chain)).not.toContain("solana");
    expect(v14.served_from).toEqual([
      "https://aifinpay.io/api/health: read",
      "https://aifinpay.io/.well-known/x402.json: read",
    ]);
    // The legacy answer is passed through unchanged, under its own name.
    expect(legacy_v13.routes).toHaveLength(8);
    expect(legacy_v13.routes.every((r: any) => r.live === false)).toBe(true);
    expect(legacy_v13.note).toContain("v1.3");
    expect(b.calls).toEqual([
      "https://aifinpay.io/api/health",
      "https://aifinpay.io/.well-known/x402.json",
      "https://aifinpay.io/v1/settlement/routes",
    ]);
  });

  it("marks a chain not live when the issuer's documents list other chains but not it", async () => {
    const b = backend(["base-mainnet"]);
    const { v14 } = parse(await runSettlementRoutes(ctx({ fetchImpl: b.fetchImpl }), {}));
    expect(v14.routes[0]).toMatchObject({ chain: "base", live: true });
    expect(v14.routes.find((r: any) => r.chain === "polygon")).toMatchObject({ live: false, served_by_backend: false });
  });

  it("reports unreadable discovery as unknown rather than disabled, and a failed legacy lookup inline", async () => {
    const fetchImpl = (async () => new Response("down", { status: 503 })) as typeof fetch;
    const result = await runSettlementRoutes(ctx({ fetchImpl }), {});
    expect(result.isError).toBeFalsy();
    const { v14, legacy_v13 } = parse(result);
    expect(v14.routes[0]).toMatchObject({ chain: "polygon", served_by_backend: "unknown", live: true });
    expect(v14.served_from[0]).toContain("HTTP 503");
    expect(legacy_v13.error).toContain("Settlement route lookup failed");
  });

  it("filters the legacy query and leaves v1.4 empty for AIFP-2", async () => {
    const b = backend();
    const { v14, legacy_v13 } = parse(
      await runSettlementRoutes(ctx({ fetchImpl: b.fetchImpl }), { route_class: "AIFP-2" })
    );
    expect(b.calls.at(-1)).toContain("route_class=AIFP-2");
    expect(v14.routes).toEqual([]);
    expect(legacy_v13.routes.every((r: any) => r.route_class === "AIFP-2")).toBe(true);
  });

  it("uses the configured base for discovery and the API origin for quote/pay", async () => {
    const b = backend();
    const { v14 } = parse(
      await runSettlementRoutes(ctx({ fetchImpl: b.fetchImpl, baseUrl: "https://api.aifinpay.io" }), {
        route_class: "AIFP-1",
      })
    );
    expect(b.calls[0]).toBe("https://api.aifinpay.io/health");
    expect(v14.routes[0].quote_endpoint).toBe("https://api.aifinpay.io/v1/quote");
  });

  it("rejects invalid route_class", async () => {
    const result = await runSettlementRoutes(ctx(), { route_class: "AIFP-3" });
    expect(result.isError).toBe(true);
  });
});

describe("settlement_invoice (EVM)", () => {
  it("rejects non-EVM chain", async () => {
    const result = await runSettlementInvoice(ctx(), {
      route_class: "AIFP-1",
      chain: "solana",
      asset: "SOL",
      gross_amount: "1000000000",
      merchant_wallet: "0x" + "ab".repeat(20),
      order_id: "ord_1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/unsupported EVM/);
  });

  it("posts invoice for valid EVM chain", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_url: any, init?: any) => {
      capturedBody = init?.body ?? "";
      return Response.json({ invoice_id: "inv_1" });
    }) as typeof fetch;
    const result = await runSettlementInvoice(ctx({ fetchImpl }), {
      route_class: "AIFP-1",
      chain: "polygon",
      asset: "USDC",
      gross_amount: "1000000",
      merchant_wallet: "0x" + "ab".repeat(20),
      order_id: "ord_1",
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(capturedBody);
    expect(body.chain).toBe("polygon");
    expect(body.asset).toBe("USDC");
  });
});

describe("settlement_solana", () => {
  it("rejects invalid Solana wallet (too short)", async () => {
    const result = await runSettlementSolana(ctx(), {
      route_class: "AIFP-1",
      chain: "solana",
      asset: "SOL",
      gross_amount: "1000000000",
      merchant_wallet: "tooShort",
      order_id: "ord_1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/base58/);
  });

  it("rejects invalid Solana wallet (contains 0/O/I/l)", async () => {
    const result = await runSettlementSolana(ctx(), {
      route_class: "AIFP-1",
      chain: "solana",
      asset: "SOL",
      gross_amount: "1000000000",
      merchant_wallet: "00000000000000000000000000000000",
      order_id: "ord_1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/base58/);
  });

  it("rejects non-SOL/USDC asset", async () => {
    const result = await runSettlementSolana(ctx(), {
      route_class: "AIFP-1",
      chain: "solana",
      asset: "ETH",
      gross_amount: "1000000000",
      merchant_wallet: "11111111111111111111111111111111",
      order_id: "ord_1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/SOL or USDC/);
  });

  it("rejects invalid route_class", async () => {
    const result = await runSettlementSolana(ctx(), {
      route_class: "AIFP-3",
      chain: "solana",
      asset: "SOL",
      gross_amount: "1000000000",
      merchant_wallet: "11111111111111111111111111111111",
      order_id: "ord_1",
    });
    expect(result.isError).toBe(true);
  });

  it("posts invoice for valid Solana request", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_url: any, init?: any) => {
      capturedBody = init?.body ?? "";
      return Response.json({ invoice_id: "inv_sol_1" });
    }) as typeof fetch;
    const result = await runSettlementSolana(ctx({ fetchImpl }), {
      route_class: "AIFP-1",
      chain: "solana",
      asset: "SOL",
      gross_amount: "1000000000",
      merchant_wallet: "11111111111111111111111111111111",
      order_id: "ord_sol_1",
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(capturedBody);
    expect(body.chain).toBe("solana");
    expect(body.asset).toBe("SOL");
  });
});

describe("settlement_casper", () => {
  it("rejects invalid Casper account hash (missing prefix)", async () => {
    const result = await runSettlementCasper(ctx(), {
      route_class: "AIFP-1",
      chain: "casper",
      asset: "CSPR",
      gross_amount: "1000000000",
      merchant_wallet: "abcdef" + "0".repeat(64),
      order_id: "ord_1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/account-hash/);
  });

  it("rejects invalid Casper account hash (wrong length)", async () => {
    const result = await runSettlementCasper(ctx(), {
      route_class: "AIFP-1",
      chain: "casper",
      asset: "CSPR",
      gross_amount: "1000000000",
      merchant_wallet: "account-hash-" + "ab".repeat(30),
      order_id: "ord_1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/account-hash/);
  });

  it("rejects non-CSPR asset", async () => {
    const result = await runSettlementCasper(ctx(), {
      route_class: "AIFP-1",
      chain: "casper",
      asset: "ETH",
      gross_amount: "1000000000",
      merchant_wallet: "account-hash-" + "ab".repeat(32),
      order_id: "ord_1",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/CSPR/);
  });

  it("rejects invalid route_class", async () => {
    const result = await runSettlementCasper(ctx(), {
      route_class: "AIFP-3",
      chain: "casper",
      asset: "CSPR",
      gross_amount: "1000000000",
      merchant_wallet: "account-hash-" + "ab".repeat(32),
      order_id: "ord_1",
    });
    expect(result.isError).toBe(true);
  });

  it("posts invoice for valid Casper request", async () => {
    let capturedBody = "";
    const fetchImpl = (async (_url: any, init?: any) => {
      capturedBody = init?.body ?? "";
      return Response.json({ invoice_id: "inv_csp_1" });
    }) as typeof fetch;
    const result = await runSettlementCasper(ctx({ fetchImpl }), {
      route_class: "AIFP-2",
      chain: "casper",
      asset: "CSPR",
      gross_amount: "5000000000",
      merchant_wallet: "account-hash-" + "cd".repeat(32),
      order_id: "ord_csp_1",
    });
    expect(result.isError).toBeFalsy();
    const body = JSON.parse(capturedBody);
    expect(body.chain).toBe("casper");
    expect(body.asset).toBe("CSPR");
    expect(body.route_class).toBe("AIFP-2");
  });
});
