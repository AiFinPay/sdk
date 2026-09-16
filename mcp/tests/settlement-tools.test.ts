import { describe, expect, it } from "vitest";
import {
  runSettlementInvoice,
  runSettlementSolana,
  runSettlementCasper,
  runSettlementRoutes,
} from "../src/tools/production-control.js";
import type { ToolContext } from "../src/server.js";

function ctx(overrides?: { fetchImpl?: typeof fetch; baseUrl?: string }): ToolContext {
  return {
    config: { baseUrl: overrides?.baseUrl ?? "https://aifinpay.io" },
    agent: {
      evmAddress: "0x" + "ab".repeat(20),
      inner: { fetchImpl: overrides?.fetchImpl ?? (async () => Response.json({})) as typeof fetch },
    },
    log: () => {},
  } as unknown as ToolContext;
}

describe("settlement_routes", () => {
  it("fetches all routes when no route_class given", async () => {
    let captured = "";
    const fetchImpl = (async (url: any) => {
      captured = String(url);
      return Response.json({ routes: [] });
    }) as typeof fetch;
    await runSettlementRoutes(ctx({ fetchImpl }), {});
    expect(captured).toBe("https://aifinpay.io/v1/settlement/routes");
  });

  it("fetches a specific route", async () => {
    let captured = "";
    const fetchImpl = (async (url: any) => {
      captured = String(url);
      return Response.json({ routes: [] });
    }) as typeof fetch;
    await runSettlementRoutes(ctx({ fetchImpl }), { route_class: "AIFP-2" });
    expect(captured).toContain("route_class=AIFP-2");
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
