import { describe, expect, it, vi } from "vitest";
import { AiFinPayAgent } from "../src/unifiedAgent.js";
import { toSafeError, AiFinPayError } from "../src/errors.js";
import { AGENT_RECEIPT_FIELDS, AGENT_TRANSACTION_FIELDS } from "../src/agentHistory.js";

// Node↔MCP alignment surface: non-signing helpers the MCP server should call
// instead of reimplementing, plus the safe error shape for tool results.
// No live network — fetch is always injected.

class DetailedError extends AiFinPayError {
  constructor(
    msg: string,
    public code = "invoice_request_mismatch",
    public txRef = "0xabc",
    public quoteId = "q-1"
  ) {
    super(msg);
  }
}

describe("toSafeError", () => {
  it("keeps name/message plus allowlisted public fields", () => {
    expect(toSafeError(new DetailedError("bad invoice"))).toEqual({
      name: "DetailedError",
      message: "bad invoice",
      code: "invoice_request_mismatch",
      txRef: "0xabc",
      quoteId: "q-1",
    });
  });

  it("drops non-allowlisted fields even when present (seeds, JWTs, objects)", () => {
    const err = new DetailedError("x") as unknown as Record<string, unknown>;
    err.seed_hash = "deadbeef";
    err.receipt = "eyJhbGciOiJIUzI1NiJ9.payload";
    err.recovery = { quote: {} };
    expect(toSafeError(err as unknown as Error)).toEqual({
      name: "DetailedError",
      message: "x",
      code: "invoice_request_mismatch",
      txRef: "0xabc",
      quoteId: "q-1",
    });
  });

  it("wraps non-Errors without throwing", () => {
    expect(toSafeError("boom")).toEqual({ name: "UnknownError", message: "boom" });
  });
});

describe("history field allowlists", () => {
  it("are exported, non-empty, and duplicate-free", () => {
    for (const fields of [AGENT_RECEIPT_FIELDS, AGENT_TRANSACTION_FIELDS]) {
      expect(fields.length).toBeGreaterThan(0);
      expect(new Set(fields).size).toBe(fields.length);
    }
    expect(AGENT_RECEIPT_FIELDS).toContain("receipt_id");
    expect(AGENT_TRANSACTION_FIELDS).toContain("tx_hash");
  });
});

describe("AiFinPayAgent non-signing MCP helpers", () => {
  const routesFetch = vi.fn().mockResolvedValue(
    new Response(JSON.stringify({ routes: [] }), {
      headers: { "content-type": "application/json" },
    })
  );

  it("settlementRoutes uses the injected fetch and returns the route table", async () => {
    const agent = await AiFinPayAgent.fromSeed("ab".repeat(32), {
      fetchImpl: routesFetch as typeof fetch,
    });
    await expect(agent.settlementRoutes()).resolves.toEqual([]);
    expect(routesFetch).toHaveBeenCalledOnce();
    expect(String(routesFetch.mock.calls[0][0])).toContain("/v1/settlement/routes");
  });

  it("requestSettlementInvoice validates before returning (no signing)", async () => {
    const badFetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ bogus: true }), {
        headers: { "content-type": "application/json" },
      })
    );
    const agent = await AiFinPayAgent.fromSeed("ab".repeat(32), {
      fetchImpl: badFetch as typeof fetch,
    });
    await expect(
      agent.requestSettlementInvoice({
        route_class: "AIFP-1",
        chain: "polygon",
        asset: "POL",
        gross_amount: "1000000",
        merchant_wallet: "0x0000000000000000000000000000000000000001",
        order_id: "order-1",
      })
    ).rejects.toThrow();
  });

  it("getDailySpendUsd starts at zero on a fresh ledger", async () => {
    const agent = await AiFinPayAgent.fromSeed("ab".repeat(32));
    await expect(agent.getDailySpendUsd()).resolves.toBe(0);
  });

  it("getQuota filters, sorts, and rolls up retained receipts", async () => {
    const now = Math.floor(Date.now() / 1000);
    const receipts = [
      {
        receipt_id: "r1",
        merchant_id: "mrch_a",
        resource: "/x",
        remaining: 3,
        used: 7,
        quota: 10,
        amount: "0.10",
        currency: "USD",
        exp: now + 3600,
      },
      {
        receipt_id: "r2",
        merchant_id: "mrch_a",
        resource: "/y",
        remaining: 9,
        used: 1,
        quota: 10,
        amount: "0.10",
        currency: "USD",
        exp: now + 3600,
      },
      {
        receipt_id: "r3",
        merchant_id: "mrch_b",
        resource: "/z",
        remaining: 0,
        used: 5,
        quota: 5,
        exp: now + 3600,
      },
      {
        receipt_id: "r4",
        merchant_id: "mrch_b",
        resource: "/old",
        remaining: 5,
        used: 0,
        quota: 5,
        exp: now - 10,
      },
    ];
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ receipts }));
    const agent = await AiFinPayAgent.fromSeed("ab".repeat(32), {
      fetchImpl: fetchImpl as typeof fetch,
    });
    const q = await agent.getQuota();
    // exhausted r3 and expired r4 excluded; most room first.
    expect(q.batches.map((b) => b.receipt_id)).toEqual(["r2", "r1"]);
    expect(q.totals).toEqual({ mrch_a: { remaining: 12, batches: 2 } });
    expect(q.agent).toBe(agent.evmAddress.toLowerCase());
  });

  it("getQuota honors a merchant filter and invalid addresses", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(Response.json({ receipts: [] }));
    const agent = await AiFinPayAgent.fromSeed("ab".repeat(32), {
      fetchImpl: fetchImpl as typeof fetch,
    });
    await expect(agent.getQuota({ merchantId: "mrch_a" })).resolves.toMatchObject({ batches: [] });
    const { getQuota } = await import("../src/agentHistory.js");
    await expect(getQuota({ address: "not-an-address", fetchImpl: fetchImpl as typeof fetch })).rejects.toThrow(
      /EVM address/
    );
  });

  it("balance() prices from env and never fabricates a feed-less leg", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("not mocked", { status: 404 }));
    const agent = await AiFinPayAgent.fromSeed("ab".repeat(32), {
      fetchImpl: fetchImpl as typeof fetch,
    });
    process.env.AIFINPAY_MATIC_USD = "0.5";
    process.env.AIFINPAY_SOL_USD = "100";
    try {
      const snap = await agent.balance();
      // RPCs unreachable in test → zero balances, but prices carry sources.
      expect(snap.prices.pol).toEqual({ usd: 0.5, source: "AIFINPAY_MATIC_USD" });
      expect(snap.prices.sol).toEqual({ usd: 100, source: "AIFINPAY_SOL_USD" });
      expect(snap.unknown_legs).toBeUndefined();
      expect(snap.agent_balance_usd).toBe(0);
    } finally {
      delete process.env.AIFINPAY_MATIC_USD;
      delete process.env.AIFINPAY_SOL_USD;
    }
    const snap2 = await agent.balance();
    // No env, feed 404s → both legs unknown, excluded from the total.
    expect(snap2.unknown_legs).toEqual(expect.arrayContaining(["pol", "sol"]));
    expect(snap2.prices.pol.source).toBe("unknown");
  });

  it("getReceiptCacheSummary is empty and JWT-free on a fresh agent", async () => {
    const agent = await AiFinPayAgent.fromSeed("ab".repeat(32));
    expect(agent.getReceiptCacheSummary()).toEqual([]);
  });
});
