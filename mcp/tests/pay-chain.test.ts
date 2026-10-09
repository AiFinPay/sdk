import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { generateKeyPairSync, sign } from "node:crypto";
import { Aifp1ReceiptCache, V14_DEPLOYMENTS, recoverAifp1Payment, routeIdOf } from "@aifinpay/agent";
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
  it.each(["botchain", "Base", "amoy", "", "__proto__"])("refuses unsupported chain %j", (name) => {
    expect(() => validatePaymentConfig({ ...owner, payChain: name, maxGas: "0.1" })).toThrow(
      /AIFINPAY_PAY_CHAIN must be one of polygon, base/
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
function baseFixture(walletAddress = address) {
  const home = mkdtempSync(join(tmpdir(), "aifp-mcp-base-"));
  dirs.push(home);
  const store = new PaymentStateStore(walletAddress, home);
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
      evmAddress: walletAddress,
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
  chain,
  serializedTransaction: "0xbeef",
});

describe("legacy recovery through real signed bytes and the public SDK receipt verifier", () => {
  // Reuse the SDK's declared signing dependency for offline test fixtures.
  // No MCP runtime dependency, live transaction or deployment acceptance is added.
  const requireAgent = createRequire(import.meta.resolve("@aifinpay/agent"));
  const { encodeFunctionData, keccak256, parseAbi, stringToHex, recoverMessageAddress } = requireAgent("viem");
  const { privateKeyToAccount } = requireAgent("viem/accounts");
  const wallet = privateKeyToAccount(`0x${"02".repeat(32)}`);
  const signer = privateKeyToAccount(`0x${"01".repeat(32)}`);
  const fields = [
    { name: "payer", type: "address" },
    { name: "merchant", type: "address" },
    { name: "token", type: "address" },
    { name: "grossAmount", type: "uint256" },
    { name: "ipCreator", type: "address" },
    { name: "validUntil", type: "uint256" },
    { name: "orderIdHash", type: "bytes32" },
    { name: "nonce", type: "uint256" },
    { name: "routeId", type: "bytes32" },
  ];
  async function signedFixture(chain: string, alteration?: string) {
    const f = baseFixture(wallet.address);
    f.ctx.config.payChain = chain;
    const dep = V14_DEPLOYMENTS[chain],
      zero = "0x" + "00".repeat(20),
      expired = Math.floor(Date.now() / 1000) - 60;
    const quoteId = "qt_legacy_signed";
    const q = {
      payer: wallet.address,
      merchant: address,
      token: zero,
      grossAmount: 50000000000000n,
      ipCreator: zero,
      validUntil: BigInt(expired),
      orderIdHash: keccak256(stringToHex(quoteId)),
      nonce: 0n,
      routeId: routeIdOf("merchant-aifp1"),
    };
    const signature = await signer.signTypedData({
      domain: { name: "B2BSplitterV14", version: "1", chainId: dep.chainId, verifyingContract: dep.splitter.address },
      types: { Quote: fields },
      primaryType: "Quote",
      message: q,
    });
    const call = {
      chain,
      contract: dep.splitter.address,
      splitter_version: "1.4",
      route: "merchant-aifp1",
      asset: "ETH",
      function: "settleNative((address,address,address,uint256,address,uint256,bytes32,uint256,bytes32),bytes)",
      arg_encoding: "struct+signature",
      field_order: fields.map((field) => field.name),
      value_wei: String(q.grossAmount),
      args: {
        quote: { ...q, grossAmount: String(q.grossAmount), validUntil: String(q.validUntil), nonce: "0" },
        signature,
      },
    };
    const data = encodeFunctionData({
      abi: parseAbi([
        "function settleNative((address payer,address merchant,address token,uint256 grossAmount,address ipCreator,uint256 validUntil,bytes32 orderIdHash,uint256 nonce,bytes32 routeId) quote,bytes signature) payable",
      ]),
      functionName: "settleNative",
      args: [q, signature],
    });
    const sender = alteration === "wrong-sender" ? signer : wallet;
    const serializedTransaction = await sender.signTransaction({
      type: "eip1559",
      chainId: alteration === "wrong-transaction-chain" ? 137 : dep.chainId,
      to: dep.splitter.address,
      data: alteration === "wrong-call-data" ? "0x1234" : data,
      value: q.grossAmount,
      nonce: 7,
      gas: 120000n,
      maxFeePerGas: 10n,
      maxPriorityFeePerGas: 1n,
    });
    const txRef = keccak256(serializedTransaction);
    const quote = {
      quote_id: quoteId,
      payer: wallet.address,
      merchant_id: "merchant_legacy",
      resource: "/data",
      scope: "exact",
      amount: "0.1",
      currency: "USD",
      nonce: "quote_nonce",
      unit_quota: 200,
      accepted_assets: ["ETH"],
      accepted_chains: [chain],
      settlement_call: call,
      expires_at: new Date(expired * 1000).toISOString(),
    };
    const state = f.store.read();
    // Legacy record deliberately lacks recovery.chain. Its signed deadline elapsed,
    // while the issuer's receipt-recovery window remains open.
    state.pending = {
      recovery: {
        apiBaseUrl: "https://api.aifinpay.io",
        paymentIssuer: "https://api.aifinpay.io",
        quote,
        txRef,
        asset: "ETH",
      },
      serializedTransaction,
      site: origin,
      amountUsd: 0.1,
    };
    f.store.save(state);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const expiry = Math.floor(Date.now() / 1000) + 600;
    const claims = {
      iss: "https://api.aifinpay.io",
      sub: wallet.address,
      aud: quote.merchant_id,
      tx_ref: txRef,
      chain,
      asset: "ETH",
      resource: quote.resource,
      scope: quote.scope,
      currency: "USD",
      amount: quote.amount,
      unit_quota: 200,
      receipt_id: "rcpt_legacy",
      iat: expiry - 600,
      exp: expiry,
    };
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
    const payload = `${encode({ alg: "EdDSA", typ: "JWT", kid: "test-key" })}.${encode(claims)}`;
    const receipt = `${payload}.${sign(null, Buffer.from(payload), privateKey).toString("base64url")}`;
    const authorization = vi.fn(async (message: string) => wallet.signMessage({ message }));
    const issuer = vi.fn(async (input: string, init?: RequestInit) => {
      if (input.endsWith("/.well-known/jwks.json"))
        return Response.json({
          keys: [{ ...publicKey.export({ format: "jwk" }), kid: "test-key", alg: "EdDSA", use: "sig" }],
        });
      expect(input).toBe("https://api.aifinpay.io/v1/pay");
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ chain, asset: "ETH", tx_ref: txRef, quote_id: quoteId });
      const message = authorization.mock.calls.at(-1)![0];
      expect(JSON.parse(message).slice(6, 9)).toEqual([chain, txRef, "ETH"]);
      expect(
        (await recoverMessageAddress({ message, signature: body.payment_authorization.signature })).toLowerCase()
      ).toBe(wallet.address.toLowerCase());
      return Response.json({
        receipt_id: claims.receipt_id,
        receipt,
        merchant_id: quote.merchant_id,
        tx_ref: txRef,
        scope: quote.scope,
        resource: quote.resource,
        unit_quota: 200,
        amount: quote.amount,
        currency: "USD",
        chain,
        asset: "ETH",
        expires_at: new Date(expiry * 1000).toISOString(),
      });
    });
    f.recoverPaidPayment.mockImplementation((saved, options) =>
      recoverAifp1Payment(
        saved,
        {
          payerAddress: wallet.address,
          signPaymentAuthorization: authorization,
          fetchImpl: issuer,
        },
        options
      )
    );
    return { ...f, issuer, authorization, txRef };
  }
  it.each(["base", "robinhood"])(
    "adopts owner %s only from original signed bytes and recovers an expired quote without replacing payment",
    async (chain) => {
      const f = await signedFixture(chain);
      const result = await runPayableFetch(f.ctx, { url: origin + "/data" });
      expect(result.isError).not.toBe(true);
      expect(f.recoverPaidPayment.mock.calls[0][0]).toMatchObject({ chain, txRef: f.txRef });
      expect(f.authorization).toHaveBeenCalledOnce();
      expect(f.store.read().pending).toBeUndefined();
      expect(f.store.read().receipts[0]).toMatchObject({ receiptId: "rcpt_legacy" });
      expect(f.fetchPaid).toHaveBeenCalledOnce();
    }
  );
  it.each(["wrong-transaction-chain", "wrong-sender", "wrong-call-data"])(
    "refuses actual signed %s evidence before receipt authorization",
    async (alteration) => {
      const f = await signedFixture("base", alteration);
      expect((await runPayableFetch(f.ctx, { url: origin + "/data" })).isError).toBe(true);
      expect(f.recoverPaidPayment).not.toHaveBeenCalled();
      expect(f.authorization).not.toHaveBeenCalled();
      expect(f.issuer).not.toHaveBeenCalled();
      expect(f.fetchPaid).not.toHaveBeenCalled();
      expect(f.store.read().pending).toBeDefined();
    }
  );
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
  it.each(["base", "robinhood"])(
    "persists %s and forwards that exact rail for receipt-only recovery",
    async (chain) => {
      const f = baseFixture();
      f.ctx.config.payChain = chain;
      f.fetchPaid.mockImplementationOnce(async (_u, _i, options) => {
        await options.nativeUsdPrice();
        await options.v14.onPrepared({
          ...preparedOn(chain, "ETH", "37200000000000"),
          budgetReservationId: "bound-reservation",
        });
        throw new Error("broadcast response unavailable");
      });
      expect((await runPayableFetch(f.ctx, { url: origin + "/data" })).isError).toBe(true);
      const recovery = f.store.read().pending!.recovery;
      expect(recovery).toMatchObject({
        chain,
        budgetReservationId: "bound-reservation",
        serializedTransaction: "0xbeef",
      });
      f.recoverPaidPayment.mockResolvedValue({
        merchant_id: "merchant_base",
        receipt_id: "recovered",
        receipt: "private-test-receipt",
        scope: "exact",
        resource: "/data",
        unit_quota: 200,
        expires_at: new Date(Date.now() + 60000).toISOString(),
      });
      const recovered = await runPayableFetch(f.ctx, { url: origin + "/data" });
      expect(recovered.isError).not.toBe(true);
      expect(f.recoverPaidPayment).toHaveBeenCalledOnce();
      expect(f.recoverPaidPayment).toHaveBeenCalledWith(recovery, { paymentIssuer: "https://api.aifinpay.io" });
      expect(f.store.read().pending).toBeUndefined();
      expect(f.store.read().spend).toHaveLength(1);
      expect(f.fetchPaid).toHaveBeenCalledTimes(2);
    }
  );
  it.each([
    "changed-owner",
    "missing-call",
    "malformed-chain",
    "legacy-without-signed-evidence",
    "legacy-foreign-call",
    "foreign-payer",
    "foreign-api",
  ])("retains and refuses %s recovery before reaching the SDK or requesting a new payment", async (kind) => {
    const f = baseFixture();
    const recovery = preparedOn("base", "ETH", "37200000000000");
    if (kind === "changed-owner") f.ctx.config.payChain = "robinhood";
    if (kind === "missing-call") delete (recovery.quote as { settlement_call?: unknown }).settlement_call;
    if (kind === "malformed-chain") recovery.chain = "Base";
    if (kind.startsWith("legacy")) delete (recovery as { chain?: string }).chain;
    if (kind === "legacy-foreign-call") recovery.quote.settlement_call.chain = "polygon";
    if (kind === "foreign-payer") recovery.quote.payer = "0x" + "44".repeat(20);
    if (kind === "foreign-api") recovery.apiBaseUrl = "https://attacker.example";
    const state = f.store.read();
    state.pending = { recovery, serializedTransaction: "0xbeef", site: origin, amountUsd: 0.1 };
    f.store.save(state);
    const result = await runPayableFetch(f.ctx, { url: origin + "/data" });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("reconcile");
    expect(f.store.read().pending).toBeDefined();
    expect(f.recoverPaidPayment).not.toHaveBeenCalled();
    expect(f.fetchPaid).not.toHaveBeenCalled();
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

describe("all EVM owner settings and independent prices", () => {
  it.each(Object.keys(PAY_CHAINS))(
    "requires a native gas cap on %s and passes its exact chain to SDK",
    async (name) => {
      const chain = payChain(name);
      expect(validatePaymentConfig({ ...owner, payChain: name, maxGas: "0.0005" })).toBe(5n * 10n ** 14n);
      if (name !== "polygon")
        expect(() => validatePaymentConfig({ ...owner, payChain: name, maxGasPol: "0.3" })).toThrow(/caps POL gas/);
      const f = baseFixture();
      f.ctx.config.payChain = name;
      expect((await runPayableFetch(f.ctx, { url: origin + "/data" })).isError).not.toBe(true);
      expect(f.fetchPaid.mock.calls[0][2].v14).toMatchObject({ chain: name, maxGasWei: 5n * 10n ** 14n });
      const getPrice = vi.fn(async (url: string) =>
        url.startsWith("https://api.coinbase.com/")
          ? Response.json({ data: { base: chain.native, currency: "USD", amount: "0.5" } })
          : new Response("unavailable", { status: 403 })
      );
      expect(await independentNativeUsd({ fetchImpl: getPrice, chain, rpc: "https://selected.example" })).toMatchObject(
        { usd: 0.5, source: "coinbase" }
      );
      expect(getPrice.mock.calls.some(([url]) => url.includes(`/prices/${chain.native}-USD/spot`))).toBe(true);
      if (!chain.chainlinkNativeUsd)
        expect(getPrice).not.toHaveBeenCalledWith("https://selected.example", expect.anything());
    }
  );
  it("accepts mixed-case pinned USDe only on Robinhood and rejects a foreign address/symbol", () => {
    expect(validatePaymentConfig({ ...owner, payChain: "robinhood", payAsset: "USDe", maxGas: "0.001" })).toBe(
      10n ** 15n
    );
    expect(() => validatePaymentConfig({ ...owner, payChain: "polygon", payAsset: "USDe", maxGas: "0.001" })).toThrow(
      /PAY_ASSET/
    );
    expect(() => validatePaymentConfig({ ...owner, payChain: "xrplevm", payAsset: "USDC", maxGas: "0.001" })).toThrow(
      /PAY_ASSET/
    );
  });
});

it("future native price timestamps cannot bypass the freshness guard", async () => {
  const future = BigInt(Math.floor(Date.now() / 1000) + 3600);
  const word = (n: bigint) => n.toString(16).padStart(64, "0");
  const price = vi.fn(async (url: string) =>
    url === "https://selected.example"
      ? Response.json({
          result: "0x" + [word(1n), word(2000n * 10n ** 8n), word(future), word(future), word(1n)].join(""),
        })
      : new Response("unavailable", { status: 403 })
  );
  await expect(
    independentNativeUsd({ fetchImpl: price, chain: PAY_CHAINS.base, rpc: "https://selected.example" })
  ).rejects.toThrow(/unavailable/);
});
