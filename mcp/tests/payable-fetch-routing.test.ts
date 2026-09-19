import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aifp1ReceiptCache, Aifp1SettlementUnsupportedError } from "@aifinpay/agent";
import { runPayableFetch } from "../src/tools/payable-fetch.js";
import { PaymentStateStore } from "../src/payment-state.js";
import type { ToolContext } from "../src/server.js";

const dirs: string[] = [];
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
  resource: "/data",
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
  serializedTransaction: "0xdeadbeef",
};
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "aifp-mcp-pay-"));
  dirs.push(home);
  const store = new PaymentStateStore(address, home);
  const cache = new Aifp1ReceiptCache();
  const fetchPaid = vi.fn(async () => new Response("content", { headers: { "content-type": "text/plain" } }));
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
  const innerPay = vi.fn();
  const ctx = {
    config: {
      paymentsEnabled: true,
      maxAmountUsd: 0.2,
      dailyAmountUsd: 0.3,
      maxGasPol: "0.05",
      walletHome: home,
      gatewayOrigins: [origin],
      gatewayPathMode: "direct",
    },
    paymentState: store,
    log: vi.fn(),
    agent: {
      evmAddress: address,
      aifp1Receipts: cache,
      fetchPaid,
      recoverPaidPayment,
      getReceiptCacheSummary: () => cache.list().map(({ jwt, ...entry }) => entry),
      inner: { fetchImpl: price, pay: innerPay },
    },
  } as unknown as ToolContext;
  return { ctx, store, cache, fetchPaid, recoverPaidPayment, price, innerPay };
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const args = { url: origin + "/data" };
const output = (result: Awaited<ReturnType<typeof runPayableFetch>>) => JSON.parse(result.content[0].text);

describe("reviewed AIFP-1 payable_fetch", () => {
  it("explains unsupported legacy routes without exposing server error bodies", async () => {
    const f = fixture();
    f.fetchPaid.mockRejectedValue(new Aifp1SettlementUnsupportedError("private untrusted server response"));
    const result = await runPayableFetch(f.ctx, args);
    expect(result.content[0].text).toContain("signed native Polygon v1.4");
    expect(result.content[0].text).not.toContain("private untrusted");
    expect(f.innerPay).not.toHaveBeenCalled();
  });
  it("fetches only the approved AIFP-1 path and never falls through a 402", async () => {
    const f = fixture();
    f.fetchPaid.mockResolvedValue(new Response("unsupported", { status: 402 }));
    expect(output(await runPayableFetch(f.ctx, args)).status).toBe(402);
    expect(f.innerPay).not.toHaveBeenCalled();
  });
  it("rejects unapproved origins, injected options, absent identity and disabled signing", async () => {
    for (const patch of [
      { url: "https://other.example/data" },
      { ...args, facilitator: "coinbase-x402" },
      { ...args, method: "DELETE" },
    ]) {
      const f = fixture();
      expect((await runPayableFetch(f.ctx, patch)).isError).toBe(true);
      expect(f.fetchPaid).not.toHaveBeenCalled();
    }
    const f = fixture();
    f.ctx.paymentState = undefined;
    expect((await runPayableFetch(f.ctx, args)).isError).toBe(true);
    const g = fixture();
    g.ctx.config.paymentsEnabled = false;
    expect((await runPayableFetch(g.ctx, args)).isError).toBe(true);
    expect(g.fetchPaid).not.toHaveBeenCalled();
  });
  it.each([1000, 0.05])("model cap %s only narrows the owner cap", async (requested) => {
    const f = fixture();
    await runPayableFetch(f.ctx, { ...args, max_amount_usd: requested });
    expect(f.fetchPaid.mock.calls[0][2].maxAmountUsd).toBe(Math.min(0.2, requested));
  });
  it.each([NaN, Infinity, -1, 0, "1"])("refuses invalid model cap %s", async (cap) => {
    const f = fixture();
    expect((await runPayableFetch(f.ctx, { ...args, max_amount_usd: cap })).isError).toBe(true);
    expect(f.fetchPaid).not.toHaveBeenCalled();
  });
  it("does not fetch a price for a reused receipt and redacts secret response headers", async () => {
    const f = fixture();
    f.fetchPaid.mockResolvedValue(
      new Response("ok", {
        headers: {
          authorization: "private",
          "set-cookie": "session=private",
          "aifp-receipt": "private",
          "aifp-quota-remaining": "199",
        },
      })
    );
    const result = await runPayableFetch(f.ctx, args);
    expect(f.price).not.toHaveBeenCalled();
    expect(JSON.stringify(result)).not.toContain("private");
    expect(output(result).headers).toEqual({
      "aifp-quota-remaining": "199",
      "content-type": "text/plain;charset=UTF-8",
    });
  });
  it("never automatically follows a merchant redirect and redacts echoed bearer receipts", async () => {
    const f = fixture();
    const state = f.store.read();
    state.receipts = [receipt];
    f.store.save(state);
    const unknownJwt = "eyJhbGciOiJFZERTQSJ9.eyJzdWIiOiJhZ2VudCJ9.signature";
    f.fetchPaid.mockResolvedValue(
      new Response(receipt.jwt + " " + unknownJwt, { headers: { "aifp-quota-remaining": receipt.jwt } })
    );
    const result = await runPayableFetch(f.ctx, args);
    expect(f.fetchPaid.mock.calls[0][1].redirect).toBe("manual");
    expect(JSON.stringify(result)).not.toContain(receipt.jwt);
    expect(JSON.stringify(result)).not.toContain(unknownJwt);
    expect(output(result).body).toContain("[redacted receipt]");
    expect(output(result).body).toContain("[redacted token]");
  });
  it("bounds merchant content and never exposes cached bearer tokens", async () => {
    const f = fixture();
    f.fetchPaid.mockImplementation(async () => {
      f.cache.put(receipt);
      return new Response("x".repeat(100_000));
    });
    const result = await runPayableFetch(f.ctx, args);
    expect(output(result).body.length).toBe(65536);
    expect(output(result).truncated).toBe(true);
    expect(JSON.stringify(result)).not.toContain(receipt.jwt);
  });
  it("persists signed transaction and daily debit before SDK submission; keeps them after timeout", async () => {
    const f = fixture();
    f.fetchPaid.mockImplementation(async (_url, _init, options) => {
      await options.nativeUsdPrice();
      await options.v14.onPrepared(prepared);
      expect(f.store.read().pending?.recovery.txRef).toBe(tx);
      expect(statSync(join(f.store.directory, "state.json")).mode & 0o777).toBe(0o600);
      throw new Error("unknown submission result private raw transaction");
    });
    const result = await runPayableFetch(f.ctx, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(tx);
    expect(JSON.stringify(result)).not.toContain("deadbeef");
    expect(f.store.read().spend).toHaveLength(1);
    expect(f.store.read().pending).toBeDefined();
  });
  it("retains receipt on content failure, clears pending, hydrates cache on restart without another debit", async () => {
    const f = fixture();
    f.fetchPaid.mockImplementationOnce(async (_url, _init, options) => {
      await options.nativeUsdPrice();
      await options.v14.onPrepared(prepared);
      f.cache.put(receipt);
      throw new Error("content network failure");
    });
    await runPayableFetch(f.ctx, args);
    expect(f.store.read().pending).toBeUndefined();
    expect(f.store.read().receipts[0].jwt).toBe(receipt.jwt);
    f.cache.evict(f.cache.list()[0]);
    await runPayableFetch(f.ctx, args);
    expect(f.cache.list()).toHaveLength(1);
    expect(f.store.read().spend).toHaveLength(1);
    expect(f.recoverPaidPayment).not.toHaveBeenCalled();
  });
  it("recovers pending receipt before fetching, with no replacement submission", async () => {
    const f = fixture();
    const state = f.store.read();
    state.pending = { recovery: prepared, serializedTransaction: "0xdeadbeef", site, amountUsd: 0.1 };
    state.spend = [{ at: Date.now(), usd: 0.1, tx }];
    f.store.save(state);
    const result = await runPayableFetch(f.ctx, args);
    expect(result.isError).not.toBe(true);
    expect(f.recoverPaidPayment).toHaveBeenCalledOnce();
    expect(f.store.read().pending).toBeUndefined();
    expect(f.store.read().spend).toHaveLength(1);
    expect(f.cache.list()).toHaveLength(1);
    expect(f.fetchPaid.mock.calls[0][2].maxAmountUsd).toBeCloseTo(0.2);
  });
  it("blocks new fetch/payment when recovery is unresolved", async () => {
    const f = fixture();
    const state = f.store.read();
    state.pending = { recovery: prepared, serializedTransaction: "0xdeadbeef", site, amountUsd: 0.1 };
    f.store.save(state);
    f.recoverPaidPayment.mockRejectedValue(new Error("not confirmed"));
    expect((await runPayableFetch(f.ctx, args)).isError).toBe(true);
    expect(f.fetchPaid).not.toHaveBeenCalled();
    expect(f.store.read().pending).toBeDefined();
  });
  it("allows cached content with an exhausted daily budget, while passing a zero purchase cap", async () => {
    const f = fixture();
    const state = f.store.read();
    state.receipts = [receipt];
    state.spend = [{ at: Date.now(), usd: 0.3, tx }];
    f.store.save(state);
    expect((await runPayableFetch(f.ctx, args)).isError).not.toBe(true);
    expect(f.fetchPaid.mock.calls[0][2].maxAmountUsd).toBe(0);
    expect(f.price).not.toHaveBeenCalled();
  });
  it("refuses pending recovery against another API or wallet before requesting a signature", async () => {
    const f = fixture();
    const state = f.store.read();
    state.pending = {
      recovery: { ...prepared, apiBaseUrl: "https://attacker.example" },
      serializedTransaction: "0xdeadbeef",
      site,
      amountUsd: 0.1,
    };
    f.store.save(state);
    expect((await runPayableFetch(f.ctx, args)).isError).toBe(true);
    expect(f.recoverPaidPayment).not.toHaveBeenCalled();
    expect(f.fetchPaid).not.toHaveBeenCalled();
  });
  it("rejects oversized independent price response before preparation", async () => {
    const f = fixture();
    f.price.mockResolvedValue(new Response(" ".repeat(17000)));
    f.fetchPaid.mockImplementation(async (_url, _init, options) => {
      await options.nativeUsdPrice();
      await options.v14.onPrepared(prepared);
      return new Response("must not reach");
    });
    expect((await runPayableFetch(f.ctx, args)).isError).toBe(true);
    expect(f.store.read().pending).toBeUndefined();
  });
  it("rechecks durable daily budget inside preparation before any broadcast", async () => {
    const f = fixture();
    const state = f.store.read();
    state.spend = [{ at: Date.now(), usd: 0.25, tx }];
    f.store.save(state);
    f.fetchPaid.mockImplementation(async (_url, _init, options) => {
      await options.nativeUsdPrice();
      await options.v14.onPrepared(prepared);
      throw new Error("must not reach broadcast");
    });
    expect((await runPayableFetch(f.ctx, args)).isError).toBe(true);
    expect(f.store.read().pending).toBeUndefined();
    expect(f.store.read().spend).toHaveLength(1);
  });
});
