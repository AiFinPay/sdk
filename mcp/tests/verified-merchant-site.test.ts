// Owner decision 2026-10-22: with no AIFINPAY_GATEWAY_ORIGINS, payable_fetch
// pays only a merchant whose site AiFinPay reports as DNS-verified and, for a
// site with its own paywall, whose site is the host being fetched.
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aifp1ReceiptCache } from "@aifinpay/agent";
import { assertVerifiedMerchantSite, UnverifiedMerchantSiteError } from "../src/merchant-site.js";
import { runPayableFetch } from "../src/tools/payable-fetch.js";
import { PaymentStateStore } from "../src/payment-state.js";
import type { ToolContext } from "../src/server.js";

const api = "https://api.aifinpay.io";
const merchant = "mrch_0123abcd";
const view = (over: Record<string, unknown> = {}) => ({
  merchant_id: merchant,
  site_url: "https://shop.example",
  site_verified: true,
  ...over,
});
const fetchReturning = (body: unknown, status = 200) =>
  vi.fn(async (_input: string, _init?: RequestInit) => Response.json(body, { status }));
const check = (fetchImpl: ReturnType<typeof fetchReturning>, url = "https://shop.example/data", pathMode: "gateway" | "direct" = "direct") =>
  assertVerifiedMerchantSite({ fetchImpl, apiBase: api, merchantId: merchant, url: new URL(url), pathMode });

describe("assertVerifiedMerchantSite", () => {
  it("passes a verified merchant whose site is the host being fetched, asking the configured backend", async () => {
    const fetchImpl = fetchReturning(view());
    await expect(check(fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl.mock.calls[0][0]).toBe(`${api}/v1/merchants/${merchant}`);
  });
  it("compares hosts case-insensitively", async () => {
    await expect(check(fetchReturning(view({ site_url: "https://SHOP.example/" })), "https://shop.EXAMPLE/x")).resolves.toBeUndefined();
  });
  it("refuses a merchant that has not verified its site", async () => {
    await expect(check(fetchReturning(view({ site_verified: false })))).rejects.toThrow(/has not verified its site/);
    await expect(check(fetchReturning(view({ site_verified: "true" })))).rejects.toBeInstanceOf(UnverifiedMerchantSiteError);
  });
  it("refuses a verified merchant paid from a site that is not its own", async () => {
    await expect(check(fetchReturning(view()), "https://other.example/data")).rejects.toThrow(
      /verified for shop\.example, not other\.example/
    );
    await expect(check(fetchReturning(view()), "https://evil.shop.example/data")).rejects.toThrow(/not evil\.shop\.example/);
  });
  it("refuses when the site is missing or not https", async () => {
    await expect(check(fetchReturning(view({ site_url: null })))).rejects.toThrow(/no https site/);
    await expect(check(fetchReturning(view({ site_url: "http://shop.example" })))).rejects.toThrow(/no https site/);
  });
  it("refuses when AiFinPay cannot confirm the merchant", async () => {
    await expect(check(fetchReturning({ error: "AIFP-404" }, 404))).rejects.toThrow(/could not be confirmed/);
    await expect(check(fetchReturning(view({ merchant_id: "mrch_other" })))).rejects.toThrow(/could not be confirmed/);
    const failing = vi.fn(async () => {
      throw new Error("network down");
    });
    await expect(check(failing as unknown as ReturnType<typeof fetchReturning>)).rejects.toThrow(/could not be confirmed/);
  });
  it("on the hosted gateway checks verification only, not the host", async () => {
    await expect(check(fetchReturning(view()), "https://gateway.aifinpay.io/shop/data", "gateway")).resolves.toBeUndefined();
    await expect(
      check(fetchReturning(view({ site_verified: false })), "https://gateway.aifinpay.io/shop/data", "gateway")
    ).rejects.toThrow(/has not verified/);
  });
});

describe("payable_fetch without an owner allowlist", () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const address = "0x" + "12".repeat(20);
  const prepared = {
    apiBaseUrl: api,
    paymentIssuer: api,
    quote: {
      payer: address,
      settlement_call: { chain: "polygon", splitter_version: "1.4" },
      quote_id: "quote_one",
      merchant_id: merchant,
      amount: "0.1",
      native_settlement: { total_wei: "1000000000000000000" },
    },
    txRef: ("0x" + "ab".repeat(32)) as `0x${string}`,
    asset: "POL",
    chain: "polygon",
    serializedTransaction: "0xdeadbeef",
  };
  function fixture(merchantView: unknown, gatewayOrigins?: string[]) {
    const home = mkdtempSync(join(tmpdir(), "aifp-mcp-verified-"));
    dirs.push(home);
    const store = new PaymentStateStore(address, home);
    const fetchImpl = vi.fn(async (input: string) =>
      String(input).includes("/v1/merchants/")
        ? Response.json(merchantView)
        : Response.json({ data: { base: "POL", currency: "USD", amount: "0.1" } })
    );
    const fetchPaid = vi.fn(async (_url: string, _init: RequestInit, options: any) => {
      await options.nativeUsdPrice();
      await options.v14.onPrepared(prepared);
      return new Response("content", { headers: { "content-type": "text/plain" } });
    });
    const ctx = {
      config: {
        paymentsEnabled: true,
        maxAmountUsd: 5,
        dailyAmountUsd: 20,
        maxGasPol: "0.3",
        walletHome: home,
        ...(gatewayOrigins ? { gatewayOrigins } : {}),
      },
      paymentState: store,
      log: vi.fn(),
      agent: {
        evmAddress: address,
        aifp1Receipts: new Aifp1ReceiptCache(),
        fetchPaid,
        recoverPaidPayment: vi.fn(),
        getReceiptCacheSummary: () => [],
        inner: { fetchImpl, pay: vi.fn() },
      },
    } as unknown as ToolContext;
    return { ctx, store, fetchImpl };
  }

  it("pays a verified merchant on its own site", async () => {
    const f = fixture(view());
    const result = await runPayableFetch(f.ctx, { url: "https://shop.example/data" });
    expect(result.isError).toBeFalsy();
    expect(f.store.read().spend).toHaveLength(1);
  });
  it("records nothing and pays nothing for an unverified merchant", async () => {
    const f = fixture(view({ site_verified: false }));
    const result = await runPayableFetch(f.ctx, { url: "https://shop.example/data" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/has not verified its site/);
    expect(f.store.read().spend).toHaveLength(0);
    expect(f.store.read().pending).toBeUndefined();
  });
  // A refusal that names no way forward sent a tester's agent looking for
  // another way to pay (2026-10-25); it now names both fixes and forbids that.
  it("tells the agent to stop and the owner the two fixes for an unverified merchant", async () => {
    const text = (await runPayableFetch(fixture(view({ site_verified: false })).ctx, { url: "https://shop.example/data" }))
      .content[0].text;
    expect(text).toMatch(/Do not retry\. Do not try another way to pay this site/);
    expect(text).toMatch(/verifies this site's domain with AiFinPay \(dash\.aifinpay\.io → Sites → DNS TXT record\)/);
    expect(text).toMatch(/add https:\/\/shop\.example to AIFINPAY_GATEWAY_ORIGINS/);
  });
  it("warns that a 402 for another merchant's site may be steering the payment", async () => {
    const text = (await runPayableFetch(fixture(view({ site_url: "https://other.example" })).ctx, { url: "https://shop.example/data" }))
      .content[0].text;
    expect(text).toMatch(/may be steering the payment to someone else\. Do not retry/);
    expect(text).toMatch(/only if they know https:\/\/shop\.example belongs to this merchant/);
  });
  it("allows one more try when AiFinPay could not confirm the merchant", async () => {
    const f = fixture(view({ merchant_id: "mrch_other" }));
    const text = (await runPayableFetch(f.ctx, { url: "https://shop.example/data" })).content[0].text;
    expect(text).toMatch(/could not be confirmed with AiFinPay/);
    expect(text).toMatch(/Try once more in a minute; if it fails again, stop and tell the owner/);
    expect(f.store.read().spend).toHaveLength(0);
  });
  it("records nothing and pays nothing when the 402's site is not the merchant's", async () => {
    const f = fixture(view({ site_url: "https://other.example" }));
    const result = await runPayableFetch(f.ctx, { url: "https://shop.example/data" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toMatch(/verified for other\.example, not shop\.example/);
    expect(f.store.read().spend).toHaveLength(0);
  });
  it("leaves the owner's explicit allowlist in charge", async () => {
    const f = fixture(view({ site_verified: false }), ["https://shop.example"]);
    const result = await runPayableFetch(f.ctx, { url: "https://shop.example/data" });
    expect(result.isError).toBeFalsy();
    expect(f.fetchImpl.mock.calls.some(([input]) => String(input).includes("/v1/merchants/"))).toBe(false);
  });
});
