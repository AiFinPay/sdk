// payable_fetch pays with what the wallet holds, in the owner's order (AIFINPAY_PAY_OPTIONS).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aifp1ReceiptCache, paymentStableAsset } from "@aifinpay/agent";
import { runPayableFetch } from "../src/tools/payable-fetch.js";
import { paymentSetupStatus } from "../src/tools/payment-setup-status.js";
import { PaymentStateStore } from "../src/payment-state.js";
import { loadConfigFromEnv, payOptions, validatePaymentConfig, type McpConfig } from "../src/config.js";
import { forgetBalances } from "../src/pay-options.js";
import { PAY_CHAINS, pinnedStablecoins } from "../src/pay-chains.js";
import type { ToolContext } from "../src/server.js";
import { payableNetwork } from "./offline-pay-network.js";

const address = "0x" + "56".repeat(20);
const origin = "https://shop.example";
const url = `${origin}/article`;
const tx = ("0x" + "ef".repeat(32)) as `0x${string}`;
const POL = 10n ** 18n;
const USDC = 10n ** 6n;
const owner: McpConfig = { paymentsEnabled: true, maxAmountUsd: 5, dailyAmountUsd: 20, gatewayOrigins: [origin] };

const dirs: string[] = [];
beforeEach(() => forgetBalances());
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function fixture(network: Parameters<typeof payableNetwork>[0] extends infer O ? Omit<O, "url"> : never, config: McpConfig = {}) {
  const home = mkdtempSync(join(tmpdir(), "aifp-mcp-options-"));
  dirs.push(home);
  const store = new PaymentStateStore(address, home);
  const fetchImpl = payableNetwork({ url, merchantChains: ["polygon"], ...network });
  // The SDK, as far as payable_fetch sees it: a quote for $0.02 in the asset it was asked for.
  const fetchPaid = vi.fn(async (_url: string, _init: RequestInit, options: any) => {
    const asset = options.v14.asset ?? PAY_CHAINS[options.v14.chain as keyof typeof PAY_CHAINS].native;
    if (!options.v14.asset) await options.nativeUsdPrice();
    await options.v14.onPrepared({
      apiBaseUrl: "https://api.aifinpay.io",
      paymentIssuer: "https://api.aifinpay.io",
      quote: {
        payer: address,
        settlement_call: { chain: options.v14.chain, splitter_version: "1.4", asset },
        quote_id: "quote_options",
        merchant_id: "mrch_offline",
        amount: "0.02",
        native_settlement: { total_wei: String(10n ** 17n) },
      },
      txRef: tx,
      asset,
      chain: options.v14.chain,
      serializedTransaction: "0xbeef",
    });
    return new Response("content", { headers: { "content-type": "text/plain" } });
  });
  const ctx = {
    config: { ...owner, walletHome: home, ...config },
    paymentState: store,
    walletSource: "legacy-keystore",
    log: vi.fn(),
    agent: {
      evmAddress: address,
      aifp1Receipts: new Aifp1ReceiptCache(),
      fetchPaid,
      recoverPaidPayment: vi.fn(),
      getReceiptCacheSummary: () => [],
      inner: { fetchImpl },
    },
  } as unknown as ToolContext;
  return { ctx, store, fetchPaid, fetchImpl };
}
const v14 = (f: ReturnType<typeof fixture>) => f.fetchPaid.mock.calls.map((call) => (call[2] as any).v14);
const text = (result: Awaited<ReturnType<typeof runPayableFetch>>) => result.content[0].text;
const balanceOfCalls = (f: ReturnType<typeof fixture>) =>
  f.fetchImpl.mock.calls
    .map(([, init]) => (init?.body ? JSON.parse(String(init.body)) : undefined))
    .filter((body) => body?.method === "eth_call")
    .map((body) => String(body.params[0].to).toLowerCase());

describe("what the owner allows", () => {
  it("defaults to the pay chain's pinned stablecoins from the SDK registry, then its native coin", () => {
    expect(payOptions({})).toEqual([
      ...pinnedStablecoins("polygon").map((asset) => ({ chain: "polygon", asset })),
      { chain: "polygon", asset: "POL" },
    ]);
    expect(pinnedStablecoins("polygon")).toContain("USDC");
    expect(payOptions({ payChain: "base" }).map((o) => o.asset)).toEqual([...pinnedStablecoins("base"), "ETH"]);
    // Arc's gas token is its USDC; it is listed once.
    expect(payOptions({ payChain: "arc" })).toEqual([{ chain: "arc", asset: "USDC" }]);
    expect(payOptions({ payChain: "solana" })).toEqual([]);
  });
  it("AIFINPAY_PAY_ASSET alone is one option, as before", () => {
    expect(payOptions({ payAsset: "USDC" })).toEqual([{ chain: "polygon", asset: "USDC" }]);
    expect(payOptions({ payChain: "base", payAsset: "ETH" })).toEqual([{ chain: "base", asset: "ETH" }]);
  });
  it("reads AIFINPAY_PAY_OPTIONS in the owner's order", () => {
    vi.stubEnv("AIFINPAY_PAY_OPTIONS", "polygon:POL, polygon:USDC");
    try {
      const config = loadConfigFromEnv();
      expect(config.payOptions).toEqual(["polygon:POL", "polygon:USDC"]);
      expect(payOptions(config)).toEqual([
        { chain: "polygon", asset: "POL" },
        { chain: "polygon", asset: "USDC" },
      ]);
      expect(validatePaymentConfig({ ...owner, ...config })).toBe(3n * 10n ** 17n);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it.each([
    [{ payOptions: ["polygon:USDC"], payAsset: "USDC" }, /AIFINPAY_PAY_OPTIONS or AIFINPAY_PAY_ASSET, not both/],
    [{ payOptions: ["polygon"] }, /"polygon" must be chain:ASSET/],
    [{ payOptions: ["Polygon:USDC"] }, /must be chain:ASSET on a supported EVM chain/],
    [{ payOptions: ["__proto__:USDC"] }, /must be chain:ASSET/],
    [{ payOptions: ["polygon:USDT"] }, /USDT is not payable on polygon/],
    [{ payOptions: ["botchain:BOT"], payChain: "botchain", maxGas: "0.1" }, /BOT is not payable on botchain/],
    [{ payOptions: ["polygon:POL", "polygon:POL"] }, /lists polygon:POL twice/],
    [{ payOptions: ["base:USDC"] }, /lists base, which has no gas cap here.*AIFINPAY_PAY_CHAIN=base/],
    [{ payOptions: ["arctestnet:USDC"] }, /arctestnet is a testnet/],
  ])("refuses %j", (config, message) => {
    expect(() => validatePaymentConfig({ ...owner, ...config })).toThrow(message);
  });
  it("Solana keeps its own setting", () => {
    expect(() => payOptions({ payChain: "solana", payOptions: ["polygon:POL"] })).toThrow(/Solana pays with AIFINPAY_PAY_CHAIN=solana/);
  });
  it("another chain takes its gas cap from AIFINPAY_PAY_CHAIN, and Polygon keeps its POL cap beside it", () => {
    const config = { ...owner, payChain: "base", maxGas: "0.0005", maxGasPol: "0.2", payOptions: ["base:USDC", "polygon:POL"] };
    expect(validatePaymentConfig(config)).toBe(5n * 10n ** 14n);
    // Without Polygon listed, the POL cap still has no meaning on Base.
    expect(() => validatePaymentConfig({ ...config, payOptions: ["base:USDC"] })).toThrow(/AIFINPAY_MAX_GAS_POL caps POL gas/);
  });
});

describe("payable_fetch chooses by balance, in the owner's order", () => {
  it("USDC and USDC.e empty, POL enough: pays POL and says so", async () => {
    const f = fixture({ balances: { "polygon:POL": 5n * POL } });
    const result = await runPayableFetch(f.ctx, { url });
    expect(result.isError).not.toBe(true);
    expect(v14(f)).toEqual([expect.objectContaining({ chain: "polygon", maxGasWei: 3n * 10n ** 17n })]);
    expect(v14(f)[0].asset).toBeUndefined();
    expect(JSON.parse(text(result)).paid_with).toEqual({ chain: "polygon", asset: "POL" });
  });
  it("USDC enough: pays USDC, first in the owner's order, though POL would cover too", async () => {
    const f = fixture({ balances: { "polygon:USDC": 5n * USDC, "polygon:POL": 5n * POL } });
    const result = await runPayableFetch(f.ctx, { url });
    expect(v14(f)).toEqual([expect.objectContaining({ chain: "polygon", asset: "USDC" })]);
    expect(JSON.parse(text(result)).paid_with).toEqual({ chain: "polygon", asset: "USDC" });
    expect(f.store.read().spend).toHaveLength(1);
  });
  it("the owner's order wins: POL first pays POL although USDC is held", async () => {
    const f = fixture(
      { balances: { "polygon:USDC": 5n * USDC, "polygon:POL": 5n * POL } },
      { payOptions: ["polygon:POL", "polygon:USDC"] }
    );
    await runPayableFetch(f.ctx, { url });
    expect(v14(f)[0].asset).toBeUndefined();
  });
  it("gas short in POL while USDC covers the price: not that option, and the message names POL for gas", async () => {
    const f = fixture({ balances: { "polygon:USDC": 5n * USDC, "polygon:POL": POL / 10n } });
    const result = await runPayableFetch(f.ctx, { url });
    expect(result.isError).toBe(true);
    expect(f.fetchPaid).not.toHaveBeenCalled();
    expect(text(result)).toContain("Polygon: 5 USDC, 0 USDC.e, 0.1 POL (gas needs up to 0.3 POL).");
    expect(text(result)).toContain("Nothing was paid or quoted");
    expect(text(result)).toContain(`Add USDC, USDC.e or POL to ${address}.`);
  });
  it("the merchant accepts only USDC: POL is never used, and the message says USDC is short", async () => {
    const f = fixture(
      { merchantChains: ["arc"], balances: { "arc:USDC": 0n, "polygon:POL": 5n * POL } },
      { payChain: "arc", maxGas: "0.05", payOptions: ["arc:USDC", "polygon:POL"] }
    );
    const result = await runPayableFetch(f.ctx, { url });
    expect(result.isError).toBe(true);
    expect(f.fetchPaid).not.toHaveBeenCalled();
    expect(text(result)).toContain("Arc: 0 USDC (gas needs up to 0.05 USDC).");
    expect(text(result)).toContain("The merchant accepts Arc USDC.");
    expect(text(result)).toContain(`Add USDC to ${address}.`);
    expect(text(result)).not.toContain("POL");
  });
  it("an option the owner did not list is never quoted or read, even when the merchant takes it and the wallet holds it", async () => {
    const f = fixture(
      { balances: { "polygon:USDC.e": 100n * USDC } },
      { payOptions: ["polygon:USDC", "polygon:POL"] }
    );
    const result = await runPayableFetch(f.ctx, { url });
    expect(result.isError).toBe(true);
    expect(f.fetchPaid).not.toHaveBeenCalled();
    expect(balanceOfCalls(f)).not.toContain(paymentStableAsset("polygon", "USDC.e")!.address.toLowerCase());
    expect(text(result)).toContain("Polygon: 0 USDC, 0 POL (gas");
    expect(text(result)).toContain(`Add USDC or POL to ${address}.`);
  });
  it("unreadable balances choose nothing and say so", async () => {
    const f = fixture({ balances: { "polygon:USDC": null, "polygon:USDC.e": null, "polygon:POL": null } });
    const result = await runPayableFetch(f.ctx, { url });
    expect(f.fetchPaid).not.toHaveBeenCalled();
    expect(text(result)).toContain("USDC unreadable");
  });
  it("AIFINPAY_PAY_ASSET alone pays exactly as before: no 402 read, no balance read, that asset", async () => {
    const f = fixture({ balances: { "polygon:POL": 5n * POL } }, { payAsset: "USDC" });
    await runPayableFetch(f.ctx, { url });
    expect(f.fetchImpl.mock.calls.some(([input]) => String(input) === url)).toBe(false);
    expect(balanceOfCalls(f)).toEqual([]);
    expect(v14(f)).toEqual([expect.objectContaining({ chain: "polygon", asset: "USDC" })]);
  });
  it("content that needs no payment is the one request, and nothing is chosen", async () => {
    const f = fixture({});
    f.fetchImpl.mockImplementation(async () => new Response("free", { headers: { "content-type": "text/plain" } }));
    const result = await runPayableFetch(f.ctx, { url });
    expect(JSON.parse(text(result))).toMatchObject({ status: 200, body: "free" });
    expect(f.fetchImpl).toHaveBeenCalledOnce();
    expect(f.fetchPaid).not.toHaveBeenCalled();
  });
});

describe("remembering what was paid with", () => {
  it("keeps the option and the balances in the payment state, never anything secret", async () => {
    const f = fixture({ balances: { "polygon:POL": 5n * POL } });
    await runPayableFetch(f.ctx, { url });
    const { paidWith } = f.store.read();
    expect(paidWith).toMatchObject({ chain: "polygon", asset: "POL" });
    expect(paidWith!.balances).toContainEqual(
      expect.objectContaining({ chain: "polygon", asset: "POL", units: String(5n * POL), decimals: 18 })
    );
  });
  it("tries the remembered option first while it covers, but a fresh read decides", async () => {
    const f = fixture({ balances: { "polygon:USDC": 5n * USDC, "polygon:POL": 5n * POL } });
    const state = f.store.read();
    state.paidWith = { chain: "polygon", asset: "POL", at: Date.now(), balances: [] };
    f.store.save(state);
    await runPayableFetch(f.ctx, { url });
    expect(v14(f)[0].asset).toBeUndefined();

    // POL spent since (0.35 left: gas, not price plus gas): the new read decides, and the owner's order applies.
    const g = fixture({ balances: { "polygon:USDC": 5n * USDC, "polygon:POL": 35n * 10n ** 16n } });
    const again = g.store.read();
    again.paidWith = { chain: "polygon", asset: "POL", at: Date.now(), balances: [{ chain: "polygon", asset: "POL", units: String(5n * POL), decimals: 18, at: Date.now() }] };
    g.store.save(again);
    await runPayableFetch(g.ctx, { url });
    expect(v14(g)).toEqual([expect.objectContaining({ chain: "polygon", asset: "USDC" })]);
  });
  it("a malformed remembered entry is dropped, never a reason to refuse the journal", () => {
    const f = fixture({});
    const state = f.store.read();
    (state as any).paidWith = { chain: "polygon; rm", asset: 1 };
    f.store.save(state);
    expect(f.store.read().paidWith).toBeUndefined();
  });
});

describe("payment_setup_status lists the options in order with balances", () => {
  it("names each option and its balance, and a covering stablecoin is ready without more POL", async () => {
    const f = fixture({ balances: { "polygon:USDC": 2n * USDC, "polygon:POL": 3n * 10n ** 17n } });
    const status = await paymentSetupStatus(f.ctx, { readBalance: true });
    expect(status.pay_options).toEqual([
      { chain: "polygon", asset: "USDC", balance: "2" },
      { chain: "polygon", asset: "USDC.e", balance: "0" },
      { chain: "polygon", asset: "POL", balance: "0.3" },
    ]);
    expect(status.ready).toBe(true);
  });
  it("without a covering option it still asks for POL", async () => {
    const f = fixture({ balances: { "polygon:POL": 10n ** 17n } });
    const status = await paymentSetupStatus(f.ctx, { readBalance: true });
    expect(status.ready).toBe(false);
    expect(status.next_step).toMatch(/^Fund 0x5656/);
  });
});
