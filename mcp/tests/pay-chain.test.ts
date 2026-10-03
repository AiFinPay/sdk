import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Aifp1ReceiptCache } from "@aifinpay/agent";
import { runPayableFetch } from "../src/tools/payable-fetch.js";
import { PaymentStateStore } from "../src/payment-state.js";
import { validatePaymentConfig, type McpConfig } from "../src/config.js";
import { independentNativeUsd } from "../src/native-price.js";
import { PAY_CHAINS, payChain } from "../src/pay-chains.js";
import type { ToolContext } from "../src/server.js";

const owner: McpConfig = {
  paymentsEnabled: true,
  maxAmountUsd: 0.2,
  dailyAmountUsd: 0.3,
  gatewayOrigins: ["https://merchant.example"],
};

describe("AIFINPAY_PAY_CHAIN configuration", () => {
  it("defaults to Polygon and still accepts the POL-named gas cap there", () => {
    expect(payChain(undefined).name).toBe("polygon");
    expect(validatePaymentConfig({ ...owner, maxGasPol: "0.3" })).toBe(3n * 10n ** 17n);
    expect(validatePaymentConfig({ ...owner, maxGas: "0.3" })).toBe(3n * 10n ** 17n);
  });
  it("takes the Base gas cap in ETH from AIFINPAY_MAX_GAS", () => {
    expect(validatePaymentConfig({ ...owner, payChain: "base", maxGas: "0.0005" })).toBe(5n * 10n ** 14n);
  });
  it("refuses a POL-named cap on Base instead of reading POL as ETH", () => {
    expect(() => validatePaymentConfig({ ...owner, payChain: "base", maxGasPol: "0.3" })).toThrow(
      /AIFINPAY_MAX_GAS_POL caps POL gas and does not apply on base; set AIFINPAY_MAX_GAS in ETH/
    );
  });
  it.each(["arbitrum", "Base", "solana", ""])("refuses unsupported chain %j", (name) => {
    expect(() => validatePaymentConfig({ ...owner, payChain: name, maxGas: "0.1" })).toThrow(
      "AIFINPAY_PAY_CHAIN must be one of polygon, base"
    );
  });
  it("refuses two gas caps that disagree, a missing cap and a plaintext RPC", () => {
    expect(() => validatePaymentConfig({ ...owner, maxGas: "0.3", maxGasPol: "0.5" })).toThrow(/disagree/);
    expect(() => validatePaymentConfig({ ...owner, payChain: "base" })).toThrow(/gas cap per payment in ETH/);
    expect(() =>
      validatePaymentConfig({ ...owner, payChain: "base", maxGas: "0.001", rpcUrl: "http://base.example" })
    ).toThrow(/AIFINPAY_RPC_URL/);
  });
});

describe("independent native price per chain", () => {
  it("reads ETH/USD from the Base feed and accepts an ETH-sized price", async () => {
    const answer = (2_690n * 10n ** 8n).toString(16).padStart(64, "0");
    const word = (v: bigint) => v.toString(16).padStart(64, "0");
    const updated = BigInt(Math.floor(Date.now() / 1000) - 5);
    const f = vi.fn(async (_url: string, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body)).params[0].to).toBe(PAY_CHAINS.base.chainlinkNativeUsd);
      return Response.json({ result: "0x" + [word(1n), answer, word(updated), word(updated), word(1n)].join("") });
    });
    const p = await independentNativeUsd({ fetchImpl: f, chain: PAY_CHAINS.base, rpc: "https://base.example" });
    expect(p).toMatchObject({ usd: 2690, source: "chainlink-base" });
  });
  it("asks Coinbase and CoinGecko for ETH on Base and names ETH when all fail", async () => {
    const urls: string[] = [];
    const f = vi.fn(async (url: string) => {
      urls.push(url);
      throw new TypeError("fetch failed");
    });
    await expect(independentNativeUsd({ fetchImpl: f, chain: PAY_CHAINS.base })).rejects.toThrow(
      "Independent ETH/USD price unavailable — nothing was paid"
    );
    expect(urls[0]).toContain("/prices/ETH-USD/spot");
    expect(urls[1]).toContain("ids=ethereum");
  });
});

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
const address = "0x" + "34".repeat(20);
const origin = "https://merchant.example";
const tx = ("0x" + "cd".repeat(32)) as `0x${string}`;
function baseFixture() {
  const home = mkdtempSync(join(tmpdir(), "aifp-mcp-base-"));
  dirs.push(home);
  const store = new PaymentStateStore(address, home);
  const cache = new Aifp1ReceiptCache();
  const fetchPaid = vi.fn(async () => new Response("content"));
  const recoverPaidPayment = vi.fn();
  // Chainlink over the RPC is unreachable here; Coinbase answers ETH.
  const price = vi.fn(async (url: string) =>
    url.startsWith("https://api.coinbase.com/")
      ? Response.json({ data: { base: "ETH", currency: "USD", amount: "2690" } })
      : new Response("blocked", { status: 403 })
  );
  const ctx = {
    config: {
      ...owner,
      payChain: "base",
      maxGas: "0.0005",
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
      getReceiptCacheSummary: () => [],
      inner: { fetchImpl: price },
    },
  } as unknown as ToolContext;
  return { ctx, store, fetchPaid, recoverPaidPayment, price };
}
const preparedOn = (chain: string, asset: string, totalWei: string) => ({
  apiBaseUrl: "https://api.aifinpay.io",
  paymentIssuer: "https://api.aifinpay.io",
  quote: {
    payer: address,
    settlement_call: { chain, splitter_version: "1.4", asset },
    quote_id: "quote_base",
    merchant_id: "merchant_base",
    amount: "0.1",
    native_settlement: { total_wei: totalWei },
  },
  txRef: tx,
  asset,
  serializedTransaction: "0xbeef",
});

describe("payable_fetch on Base", () => {
  it("asks the SDK for Base, in ETH, with the ETH gas cap", async () => {
    const f = baseFixture();
    await runPayableFetch(f.ctx, { url: origin + "/data" });
    const v14 = f.fetchPaid.mock.calls[0][2].v14;
    expect(v14.chain).toBe("base");
    expect(v14.asset).toBeUndefined();
    expect(v14.maxGasWei).toBe(5n * 10n ** 14n);
  });
  it("values an ETH batch at the independent ETH price before it is sent", async () => {
    const f = baseFixture();
    f.fetchPaid.mockImplementation(async (_u, _i, options) => {
      await options.nativeUsdPrice();
      // 0.0000372 ETH at $2690 is $0.10007 — above the quoted $0.10, so that is what is debited.
      await options.v14.onPrepared(preparedOn("base", "ETH", "37200000000000"));
      return new Response("content");
    });
    await runPayableFetch(f.ctx, { url: origin + "/data" });
    expect(f.price.mock.calls.some(([url]) => String(url).includes("/prices/ETH-USD/spot"))).toBe(true);
    expect(f.store.read().spend[0].usd).toBeCloseTo(0.100068, 5);
  });
  it("passes a stablecoin through on Base", async () => {
    const f = baseFixture();
    f.ctx.config.payAsset = "USDC";
    await runPayableFetch(f.ctx, { url: origin + "/data" });
    expect(f.fetchPaid.mock.calls[0][2].v14).toMatchObject({ chain: "base", asset: "USDC" });
  });
  it("never recovers or re-sends a payment pending on another chain", async () => {
    const f = baseFixture();
    const state = f.store.read();
    state.pending = {
      recovery: preparedOn("polygon", "POL", "1000000000000000000"),
      serializedTransaction: "0xbeef",
      site: origin,
      amountUsd: 0.1,
    };
    f.store.save(state);
    const result = await runPayableFetch(f.ctx, { url: origin + "/data" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(tx);
    expect(f.recoverPaidPayment).not.toHaveBeenCalled();
    expect(f.fetchPaid).not.toHaveBeenCalled();
    expect(f.store.read().pending).toBeDefined();
  });
  it("tells a USDC payment pending on Polygon from USDC on Base by chain alone", async () => {
    const f = baseFixture();
    f.ctx.config.payAsset = "USDC";
    const state = f.store.read();
    state.pending = {
      recovery: preparedOn("polygon", "USDC", "0"),
      serializedTransaction: "0xbeef",
      site: origin,
      amountUsd: 0.1,
    };
    f.store.save(state);
    const result = await runPayableFetch(f.ctx, { url: origin + "/data" });
    expect(result.isError).toBe(true);
    expect(f.recoverPaidPayment).not.toHaveBeenCalled();
    expect(f.fetchPaid).not.toHaveBeenCalled();
  });
  it("names Base and ETH when the wallet is short", async () => {
    const f = baseFixture();
    f.fetchPaid.mockRejectedValue(
      Object.assign(new Error("x"), { name: "V14SettlementError", code: "V14_INSUFFICIENT_BALANCE" })
    );
    const result = await runPayableFetch(f.ctx, { url: origin + "/data" });
    expect(result.content[0].text).toBe(
      "The wallet needs enough ETH on Base for the quoted purchase plus the owner-capped gas fee."
    );
  });
});
