import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { Aifp1ReceiptCache, Aifp1FinalizedFailureError, type Aifp1SolanaPaymentRecovery } from "@aifinpay/agent";
import { validatePaymentConfig, loadConfigFromEnv, type McpConfig } from "../src/config.js";
import { PaymentStateStore } from "../src/payment-state.js";
import { runPayableFetch } from "../src/tools/payable-fetch.js";
import { payChain } from "../src/pay-chains.js";
import type { ToolContext } from "../src/server.js";

const owner: McpConfig = {
  paymentsEnabled: true,
  payChain: "solana",
  solanaNetwork: "mainnet",
  rpcUrl: "https://trusted-solana.example",
  maxFeeLamports: "10000000",
  maxAmountUsd: 0.2,
  dailyAmountUsd: 0.3,
  gatewayOrigins: ["https://merchant.example"],
  gatewayPathMode: "direct",
};
const evmAddress = "0x" + "12".repeat(20);
const solanaAddress = bs58.encode(Uint8Array.from({ length: 32 }, (_, i) => i));
// Synthetic callback transport fixture; not real signed-byte or paid acceptance.
const signature = bs58.encode(Buffer.alloc(64, 1));
const program = bs58.encode(Buffer.alloc(32, 2));
const blockhash = bs58.encode(Buffer.alloc(32, 3));
const dirs: string[] = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});
function fixture(asset = "SOL") {
  const home = mkdtempSync(join(tmpdir(), "aifp-mcp-solana-"));
  dirs.push(home);
  const store = new PaymentStateStore(evmAddress, home);
  const cache = new Aifp1ReceiptCache();
  const recoverPaidPayment = vi.fn(async () => ({
    merchant_id: "merchant",
    receipt_id: "receipt",
    receipt: "private-receipt",
    scope: "exact",
    resource: "/data",
    unit_quota: 200,
    expires_at: new Date(Date.now() + 60000).toISOString(),
  }));
  const fetchPaid = vi.fn(async () => new Response("content"));
  const price = vi.fn(async () => Response.json({ data: { base: "SOL", currency: "USD", amount: "100" } }));
  const ctx = {
    config: { ...owner, payAsset: asset },
    paymentState: store,
    log: vi.fn(),
    agent: {
      evmAddress,
      solanaAddress,
      aifp1Receipts: cache,
      fetchPaid,
      recoverPaidPayment,
      getReceiptCacheSummary: () => [],
      inner: { fetchImpl: price },
    },
  } as unknown as ToolContext;
  const prepared = {
    family: "solana",
    chain: "solana",
    apiBaseUrl: "https://api.aifinpay.io",
    paymentIssuer: "https://api.aifinpay.io",
    budgetBindingVersion: 2,
    budgetReservationId: "original-bound-admission",
    asset,
    reservedAmountUsd: 0.11,
    admissionSolUsdPrice: "100",
    maxFeeLamports: "10000000",
    transactionFeeLamports: "5000",
    txRef: signature,
    quote: {
      payer: solanaAddress,
      quote_id: "quote",
      merchant_id: "merchant",
      amount: "0.1",
      settlement_call: { chain: "solana", network: "mainnet", splitter_version: "1.4", asset },
      ...(asset === "SOL" ? { native_settlement: { total_lamports: "1000000" } } : {}),
    },
    solana: {
      family: "solana",
      hash: signature,
      serializedTransactionBase64: Buffer.alloc(200, 1).toString("base64"),
      network: "mainnet",
      programId: program,
      idlSha256: "ab".repeat(32),
      recentBlockhash: blockhash,
      lastValidBlockHeight: 100,
      settlementNonce: "0",
    },
  };
  return { ctx, store, cache, prepared, fetchPaid, recoverPaidPayment, price };
}
const args = { url: owner.gatewayOrigins![0] + "/data" };

describe("explicit Solana owner settings", () => {
  it("keeps lamports separate from EVM gas and requires independent cluster/mode/RPC", () => {
    expect(payChain("solana").native).toBe("SOL");
    expect(validatePaymentConfig(owner)).toBe(10000000n);
    expect(validatePaymentConfig({ ...owner, devMode: true, solanaNetwork: "devnet" })).toBe(10000000n);
    for (const patch of [
      { solanaNetwork: undefined },
      { solanaNetwork: "devnet" },
      { devMode: true },
      { rpcUrl: undefined },
      { rpcUrl: "http://trusted.example" },
      { maxGas: "0.01" },
      { maxGasPol: "0.01" },
    ])
      expect(() => validatePaymentConfig({ ...owner, ...patch } as McpConfig)).toThrow();
  });
  it.each([undefined, "0", "-1", "1.1", "01", "1e7", "18446744073709551616"])(
    "refuses unsafe fee/rent cap %s",
    (cap) => {
      expect(() => validatePaymentConfig({ ...owner, maxFeeLamports: cap })).toThrow(/MAX_FEE_LAMPORTS/);
    }
  );
  it("accepts exact pinned symbols, rejects unknown assets and wrong-family settings", () => {
    expect(validatePaymentConfig({ ...owner, payAsset: "USDC" })).toBe(10000000n);
    expect(validatePaymentConfig({ ...owner, payAsset: "USDT" })).toBe(10000000n);
    for (const asset of ["usdc", "Token2022", "USDC.e", "ETH"])
      expect(() => validatePaymentConfig({ ...owner, payAsset: asset })).toThrow(/PAY_ASSET/);
    expect(() => validatePaymentConfig({ ...owner, payChain: "polygon", maxGasPol: "0.3" })).toThrow(
      /require.*CHAIN=solana/
    );
  });
  it("loads exact owner environment selectors and refuses a noncanonical cluster", () => {
    vi.stubEnv("AIFINPAY_SOLANA_NETWORK", "mainnet");
    vi.stubEnv("AIFINPAY_MAX_FEE_LAMPORTS", "10000000");
    expect(loadConfigFromEnv()).toMatchObject({ solanaNetwork: "mainnet", maxFeeLamports: "10000000" });
    vi.stubEnv("AIFINPAY_SOLANA_NETWORK", "Mainnet");
    expect(() => loadConfigFromEnv()).toThrow(/SOLANA_NETWORK/);
  });
});

describe("Solana durable MCP dispatch and recovery", () => {
  it("keeps the Solana admission cap stable across rollover while enforcing fresh daily allowance before broadcast", async () => {
    const f = fixture();
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      const state = f.store.read();
      state.spend.push({ at: now - 23 * 3600 * 1000, usd: 0.25, tx: "0x" + "34".repeat(32) });
      f.store.save(state);
      let submissions = 0;
      const observedCaps: unknown[] = [];
      f.fetchPaid.mockImplementation(async (_url, _init, opts) => {
        observedCaps.push(opts.maxAmountUsd);
        await opts.nativeUsdPrice();
        await opts.solanaV14.onPrepared(f.prepared);
        // This is the submission boundary. Assertions live outside the callback:
        // the tool catches errors thrown by the SDK/callback.
        submissions++;
        throw new Error("unknown submission");
      });
      expect((await runPayableFetch(f.ctx, args)).isError).toBe(true);
      expect(observedCaps).toEqual([owner.maxAmountUsd]);
      expect(submissions).toBe(0);
      expect(f.store.read().pending).toBeUndefined();
      expect(f.store.read().spend).toHaveLength(1);
      clock.mockReturnValue(now + 2 * 3600 * 1000);
      expect((await runPayableFetch(f.ctx, args)).isError).toBe(true);
      expect(observedCaps).toEqual([owner.maxAmountUsd, owner.maxAmountUsd]);
      expect(submissions).toBe(1);
      expect(f.store.read().pending?.amountUsd).toBe(f.prepared.reservedAmountUsd);
      expect(f.store.read().spend).toHaveLength(2);
    } finally {
      clock.mockRestore();
    }
  });

  it.each([0, 0.0005])(
    "reconciles exact finalized failure once, retaining fee %s and no receipt or resend",
    async (fee) => {
      const f = fixture();
      const state = f.store.read();
      state.pending = { recovery: f.prepared, site: "site", amountUsd: 0.11 };
      state.spend.push({ at: Date.now(), usd: 0.11, tx: signature });
      f.store.save(state);
      f.recoverPaidPayment.mockRejectedValue(
        new Aifp1FinalizedFailureError(f.prepared as unknown as Aifp1SolanaPaymentRecovery, fee, fee === 0 ? 0n : 5000n)
      );
      const result = await runPayableFetch(f.ctx, args);
      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("verified network fee");
      expect(f.fetchPaid).not.toHaveBeenCalled();
      expect(f.store.read()).toMatchObject({ receipts: [], spend: [{ usd: fee, tx: signature, failure: true }] });
      expect(f.store.read().pending).toBeUndefined();
      // A new invocation may proceed normally; it cannot repeat the old recovery.
      expect((await runPayableFetch(f.ctx, args)).isError).not.toBe(true);
      expect(f.recoverPaidPayment).toHaveBeenCalledTimes(1);
      expect(f.store.read().spend).toHaveLength(1);
      expect(f.store.read().spend[0].usd).toBe(fee);
    }
  );
  it("reconciles a terminal failure from the initial payment without claiming success", async () => {
    const f = fixture();
    f.fetchPaid.mockImplementation(async (_url, _init, opts) => {
      await opts.nativeUsdPrice();
      await opts.solanaV14.onPrepared(f.prepared);
      throw new Aifp1FinalizedFailureError(f.prepared as unknown as Aifp1SolanaPaymentRecovery, 0.0005, 5000n);
    });
    const result = await runPayableFetch(f.ctx, args);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("No receipt was issued");
    expect(f.store.read().pending).toBeUndefined();
    expect(f.store.read().spend).toMatchObject([{ usd: 0.0005, failure: true }]);
    expect(f.store.read().receipts).toEqual([]);
    expect(f.fetchPaid).toHaveBeenCalledTimes(1);
  });
  it("retries fee reconciliation after MCP persistence fails without forgetting or duplicating the original debit", async () => {
    const f = fixture();
    const state = f.store.read();
    state.pending = { recovery: f.prepared, site: "site", amountUsd: 0.11 };
    state.spend.push({ at: Date.now(), usd: 0.11, tx: signature });
    f.store.save(state);
    f.recoverPaidPayment.mockRejectedValue(
      new Aifp1FinalizedFailureError(f.prepared as unknown as Aifp1SolanaPaymentRecovery, 0.0005, 5000n)
    );
    const save = vi.spyOn(f.store, "save").mockImplementationOnce(() => {
      throw new Error("private IO failure");
    });
    expect((await runPayableFetch(f.ctx, args)).isError).toBe(true);
    expect(f.store.read().pending).toBeDefined();
    expect(f.store.read().spend).toMatchObject([{ usd: 0.11, tx: signature }]);
    save.mockRestore();
    expect((await runPayableFetch(f.ctx, args)).content[0].text).toContain("verified network fee");
    expect(f.recoverPaidPayment).toHaveBeenCalledTimes(2);
    expect(f.fetchPaid).not.toHaveBeenCalled();
    expect(f.store.read().pending).toBeUndefined();
    expect(f.store.read().spend).toMatchObject([{ usd: 0.0005, tx: signature, failure: true }]);
    expect(f.store.read().spend).toHaveLength(1);
  });
  it("keeps the original failed debit timestamp across a daily rollover", async () => {
    const f = fixture();
    const originalAt = Date.now() - 2 * 86_400_000;
    const state = f.store.read();
    state.pending = { recovery: f.prepared, site: "site", amountUsd: 0.11 };
    state.spend.push({ at: originalAt, usd: 0.11, tx: signature });
    f.store.save(state);
    f.recoverPaidPayment.mockRejectedValue(
      new Aifp1FinalizedFailureError(f.prepared as unknown as Aifp1SolanaPaymentRecovery, 0.0005, 5000n)
    );
    expect((await runPayableFetch(f.ctx, args)).content[0].text).toContain("verified network fee");
    const saved = f.store.read();
    expect(saved.spend).toMatchObject([{ at: originalAt, usd: 0.0005, failure: true }]);
    expect(f.store.spent24h(saved)).toBe(0);
    expect(saved.pending).toBeUndefined();
    expect(f.fetchPaid).not.toHaveBeenCalled();
  });
  it.each(["plain-error", "quote", "amount", "fee", "duplicate-debit"])(
    "retains the unknown full reservation for mismatched failure evidence: %s",
    async (mutation) => {
      const f = fixture();
      const state = f.store.read();
      state.pending = { recovery: f.prepared, site: "site", amountUsd: 0.11 };
      state.spend.push({ at: Date.now(), usd: 0.11, tx: signature });
      if (mutation === "duplicate-debit") state.spend.push({ ...state.spend[0] });
      f.store.save(state);
      const recovery = structuredClone(f.prepared);
      if (mutation === "quote") recovery.quote.quote_id = "foreign";
      if (mutation === "amount") recovery.reservedAmountUsd = 0.1;
      const error =
        mutation === "plain-error"
          ? Object.assign(new Error("unknown"), {
              code: "AIFP1_FINALIZED_FAILURE",
              recovery,
              feeAmountUsd: 0.0005,
              actualFeeLamports: 5000n,
            })
          : new Aifp1FinalizedFailureError(
              recovery as unknown as Aifp1SolanaPaymentRecovery,
              mutation === "fee" ? 0.12 : 0.0005,
              5000n
            );
      f.recoverPaidPayment.mockRejectedValue(error);
      expect((await runPayableFetch(f.ctx, args)).isError).toBe(true);
      expect(f.fetchPaid).not.toHaveBeenCalled();
      expect(f.store.read().pending).toBeDefined();
      expect(f.store.read().spend.every((entry) => entry.usd === 0.11 && !entry.failure)).toBe(true);
    }
  );
  it.each(["SOL", "USDC"])("persists %s full callback and fee/rent debit before submission", async (asset) => {
    const f = fixture(asset);
    let preBroadcastChecksPassed = false;
    f.fetchPaid.mockImplementation(async (_url, _init, opts) => {
      expect(opts.v14).toBeUndefined();
      expect(opts.solanaV14).toMatchObject({
        environment: "prod",
        network: "mainnet",
        asset,
        maxFeeLamports: 10000000n,
      });
      await opts.nativeUsdPrice();
      await opts.solanaV14.onPrepared(f.prepared);
      const saved = f.store.read();
      expect(saved.pending?.recovery).toEqual(f.prepared);
      expect(saved.pending?.serializedTransaction).toBeUndefined();
      expect(saved.pending?.amountUsd).toBe(0.11);
      expect(saved.spend).toMatchObject([{ usd: 0.11, tx: signature }]);
      preBroadcastChecksPassed = true;
      throw new Error("broadcast response unavailable; private raw bytes");
    });
    const result = await runPayableFetch(f.ctx, args);
    // The tool redacts all thrown callback errors; observe this invariant
    // outside that catch so a failed assertion cannot look like a safe refusal.
    expect(preBroadcastChecksPassed).toBe(true);
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain(signature);
    expect(result.content[0].text).not.toContain("private raw bytes");
    // Restart the journal reader, preserving the unresolved same signature.
    f.ctx.paymentState = new PaymentStateStore(evmAddress, f.store.directory.replace(/\/payments\/[^/]+$/, ""));
    f.fetchPaid.mockResolvedValue(new Response("reused content"));
    expect((await runPayableFetch(f.ctx, args)).isError).not.toBe(true);
    expect(f.recoverPaidPayment).toHaveBeenCalledWith(f.prepared, {
      paymentIssuer: "https://api.aifinpay.io",
      solanaNetwork: "mainnet",
      solanaEnvironment: "prod",
    });
    expect(f.store.read().pending).toBeUndefined();
    expect(f.store.read().spend).toHaveLength(1);
  });
  it.each(["case", "network", "family", "issuer"])(
    "retains %s mismatch without recovery or a new payment",
    async (mutation) => {
      const f = fixture();
      const state = f.store.read();
      if (mutation === "case")
        f.prepared.quote.payer = solanaAddress.slice(0, -1) + (solanaAddress.endsWith("a") ? "A" : "a");
      if (mutation === "network") f.prepared.solana.network = "devnet";
      if (mutation === "family") {
        f.ctx.config.payChain = "polygon";
        f.ctx.config.solanaNetwork = undefined;
        f.ctx.config.maxFeeLamports = undefined;
        f.ctx.config.maxGasPol = "0.3";
        f.ctx.config.payAsset = "POL";
      }
      if (mutation === "issuer") f.prepared.paymentIssuer = "https://foreign.example";
      state.pending = { recovery: f.prepared, site: "site", amountUsd: 0.11 };
      f.store.save(state);
      expect((await runPayableFetch(f.ctx, args)).isError).toBe(true);
      expect(f.recoverPaidPayment).not.toHaveBeenCalled();
      expect(f.fetchPaid).not.toHaveBeenCalled();
      expect(f.store.read().pending).toBeDefined();
    }
  );
  it("rejects fee-inclusive debit above owner cap before writing any prepared spend", async () => {
    const f = fixture();
    f.prepared.reservedAmountUsd = 0.21;
    f.fetchPaid.mockImplementation(async (_url, _init, opts) => {
      await opts.nativeUsdPrice();
      await opts.solanaV14.onPrepared(f.prepared);
      return new Response("unexpected");
    });
    expect((await runPayableFetch(f.ctx, args)).isError).toBe(true);
    expect(f.store.read().pending).toBeUndefined();
    expect(f.store.read().spend).toHaveLength(0);
  });
  it("refuses corrupted base64/hash family evidence instead of resetting state", () => {
    const f = fixture();
    const state = f.store.read();
    state.pending = { recovery: f.prepared, site: "site", amountUsd: 0.11 };
    f.store.save(state);
    const path = join(f.store.directory, "state.json");
    const text = readFileSync(path, "utf8");
    for (const mutate of [
      (s) => s.replace(signature, "0x" + "ab".repeat(32)),
      (s) => s.replace(f.prepared.solana.serializedTransactionBase64, "not base64"),
    ]) {
      writeFileSync(path, mutate(text), { mode: 0o600 });
      expect(() => f.store.read()).toThrow(/Invalid pending/);
    }
  });
});
