import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { keccak256, stringToHex } from "viem";
import {
  aifp1Fetch,
  recoverAifp1Payment,
  Aifp1ReceiptCache,
  type Aifp1Quote,
  type Aifp1Deps,
  type Aifp1FetchOptions,
} from "../src/aifp1.js";
import { routeIdOf, type V14SettlementCall } from "../src/settlementV14.js";
import { V14_DEPLOYMENTS } from "../src/generated/v14Deployments.generated.js";
import { SettlementConfirmationPendingError } from "../src/settlement.js";

const payer = "0x1111111111111111111111111111111111111111";
const merchant = "0x2222222222222222222222222222222222222222";
const zero = "0x0000000000000000000000000000000000000000";
const tx = `0x${"ab".repeat(32)}` as const;
const url = "https://merchant.example/api/genres";
const api = "https://api.aifinpay.io";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

function fixture(chain: "polygon" | "base" = "polygon") {
  const nativeAsset = chain === "base" ? "ETH" : "POL";
  const gross = chain === "base" ? 50_000_000_000_000n : 1_000_000_000_000_000_000n;
  const rate = chain === "base" ? 2000 : 0.1;
  const expiry = Math.floor(Date.now() / 1000) + 600;
  const call: V14SettlementCall = {
    chain,
    contract: "0x78bed24B8D3A5eB2cf8D9A0D6A9Da6Bc5d7f32eB",
    splitter_version: "1.4",
    route: "merchant-aifp1",
    asset: nativeAsset,
    function: "settleNative((address,address,address,uint256,address,uint256,bytes32,uint256,bytes32),bytes)",
    arg_encoding: "struct+signature",
    field_order: [
      "payer",
      "merchant",
      "token",
      "grossAmount",
      "ipCreator",
      "validUntil",
      "orderIdHash",
      "nonce",
      "routeId",
    ],
    value_wei: String(gross),
    args: {
      quote: {
        payer,
        merchant,
        token: zero,
        grossAmount: String(gross),
        ipCreator: zero,
        validUntil: String(expiry),
        orderIdHash: keccak256(stringToHex("qt_v14")),
        nonce: "0",
        routeId: routeIdOf("merchant-aifp1"),
      },
      signature: `0x${"11".repeat(65)}`,
    },
  };
  const quote: Aifp1Quote = {
    quote_id: "qt_v14",
    payer,
    merchant_id: "mrch_example",
    resource: "/api/genres",
    scope: "exact",
    tier: "standard",
    unit_price: "0.0005",
    requests: 200,
    units: 200,
    unit_quota: 200,
    amount: "0.1",
    currency: "USD",
    accepted_assets: [nativeAsset],
    accepted_chains: [chain],
    pay_to: chain === "base" ? { evm: merchant } : { polygon: merchant },
    settlement_call: call,
    native_settlement: {
      asset: nativeAsset,
      decimals: 18,
      rate_usd: String(rate),
      total_wei: call.value_wei,
      gross_wei: call.value_wei,
      payer_total_wei: call.value_wei,
      merchant_wei: String(gross - gross / 100n),
      treasury_wei: String(gross / 100n),
      creator_wei: "0",
      valid_until: expiry,
      settlement_semantics: "gross-inclusive",
    },
    settlement: {
      batch_units: "100000",
      total_units: "100000",
      gross_units: "100000",
      payer_total_units: "100000",
      merchant_units: "99000",
      protocol_fee_units: "1000",
      creator_units: "0",
      fee_on_top: false,
      settlement_semantics: "gross-inclusive",
    },
    nonce: "nonce",
    expires_at: new Date(expiry * 1000).toISOString(),
  };
  const claims: Record<string, unknown> = {
    iss: api,
    sub: payer,
    aud: quote.merchant_id,
    resource: quote.resource,
    scope: quote.scope,
    amount: "0.1",
    currency: "USD",
    asset: nativeAsset,
    chain,
    tx_ref: tx,
    receipt_id: "rcpt_v14",
    unit_quota: 200,
    iat: Math.floor(Date.now() / 1000),
    exp: expiry,
  };
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  let payFailure = false;
  const header: Record<string, unknown> = { alg: "EdDSA", typ: "JWT", kid: "receipt-key" };
  const responseOverrides: Record<string, unknown> = {};
  let corruptSignature = false;
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(input);
    if (target.endsWith("/v1/quote")) return json(quote);
    if (target.endsWith("/.well-known/jwks.json"))
      return json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "receipt-key", alg: "EdDSA", use: "sig" }] });
    if (target.endsWith("/v1/pay")) {
      if (payFailure) return json({ error: "refused" }, 400);
      const unsigned = `${encode(header)}.${encode(claims)}`;
      return json({
        receipt_id: "rcpt_v14",
        receipt: `${unsigned}.${(corruptSignature ? Buffer.alloc(64) : sign(null, Buffer.from(unsigned), privateKey)).toString("base64url")}`,
        status: "settled",
        tx_ref: tx,
        merchant_id: quote.merchant_id,
        resource: quote.resource,
        scope: quote.scope,
        amount: "0.1",
        currency: "USD",
        quota: 200,
        unit_quota: 200,
        asset: nativeAsset,
        chain,
        settled_at: new Date().toISOString(),
        expires_at: quote.expires_at,
        ...responseOverrides,
      });
    }
    if (new Headers(init?.headers).has("AIFP-Receipt")) return json({ genres: ["Drama"] });
    return json(
      {
        error: "AIFP-402",
        protocol: "AIFP-1",
        merchant_id: quote.merchant_id,
        resource: quote.resource,
        unit_weight: 1,
        base_unit_price_usd: "0.0005",
      },
      402
    );
  }) as unknown as typeof fetch;
  const deps: Aifp1Deps = {
    fetchImpl,
    cache: new Aifp1ReceiptCache(),
    agentId: payer,
    payerAddress: payer,
    signPaymentAuthorization: vi.fn(async () => "0xsignature"),
    settle: vi.fn(async (p) => {
      await p.onPrepared?.({ hash: tx, serializedTransaction: "0x1234" });
      return tx;
    }),
    checkPerCall: () => true,
    reserveDaily: vi.fn(async () => "reservation"),
    commit: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  };
  const price = vi.fn(async () => ({ usd: rate, observedAtMs: Date.now() }));
  const prepared = vi.fn(async () => {});
  const opts: Aifp1FetchOptions = {
    gatewayOrigins: ["https://merchant.example"],
    resourcePathMode: "direct",
    scope: "exact",
    units: 200,
    maxAmountUsd: 0.11,
    nativeUsdPrice: price,
    v14: { chain, maxGasWei: 50000000000000000n, onPrepared: prepared },
  };
  return {
    quote,
    call,
    claims,
    deps,
    opts,
    price,
    prepared,
    header,
    responseOverrides,
    corrupt: () => {
      corruptSignature = true;
    },
    failPay: () => {
      payFailure = true;
    },
  };
}

describe("public native v1.4 purchase", () => {
  it("passes the original signed call, journals before receipt, and reuses verified access without another purchase", async () => {
    const f = fixture();
    expect((await aifp1Fetch(f.deps, url, {}, f.opts))?.status).toBe(200);
    expect(f.prepared).toHaveBeenCalledWith(
      expect.objectContaining({ txRef: tx, quote: f.quote, serializedTransaction: "0x1234" })
    );
    expect(f.deps.settle).toHaveBeenCalledWith(
      expect.objectContaining({ settlementCall: f.call, grossWei: 1000000000000000000n })
    );
    expect((await aifp1Fetch(f.deps, url, {}, f.opts))?.status).toBe(200);
    expect(f.deps.settle).toHaveBeenCalledTimes(1);
    expect(f.price).toHaveBeenCalledTimes(1);
  });
  it("does not follow a hosted-origin redirect into another merchant's payment challenge", async () => {
    const f = fixture();
    f.deps.fetchImpl = vi.fn(async (_url, init) => {
      expect(init?.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://foreign.example/pay" } });
    });
    const response = await aifp1Fetch(
      f.deps,
      "https://gateway.aifinpay.io/shop/data",
      {},
      {
        ...f.opts,
        gatewayOrigins: ["https://gateway.aifinpay.io"],
        resourcePathMode: "gateway",
      }
    );
    expect(response?.status).toBe(302);
    expect(f.deps.settle).not.toHaveBeenCalled();
    expect(f.deps.fetchImpl).toHaveBeenCalledTimes(1);
  });
  it.each(["merchant", "gross", "expiry", "scope", "price", "legacy"])(
    "refuses %s mismatch before signing",
    async (kind) => {
      const f = fixture();
      if (kind === "merchant") f.call.args.quote.merchant = payer;
      if (kind === "gross") f.call.args.quote.grossAmount = "2000000000000000000";
      if (kind === "expiry") f.call.args.quote.validUntil = String(Number(f.call.args.quote.validUntil) + 1);
      if (kind === "scope") f.quote.scope = "merchant";
      if (kind === "price") f.opts.nativeUsdPrice = { usd: 0.5, observedAtMs: Date.now() };
      if (kind === "legacy") (f.call as { splitter_version: string }).splitter_version = "1.2";
      await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toThrow();
      expect(f.deps.settle).not.toHaveBeenCalled();
    }
  );
  it("keeps pending broadcast charged and returns recoverable transaction", async () => {
    const f = fixture();
    f.deps.settle = vi.fn(async () => {
      throw new SettlementConfirmationPendingError(tx, "settlement");
    });
    await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toMatchObject({
      txRef: tx,
      recovery: expect.objectContaining({ txRef: tx }),
    });
    expect(f.deps.commit).toHaveBeenCalled();
    expect(f.deps.release).not.toHaveBeenCalled();
  });
  it.each(["sub", "aud", "tx_ref", "unit_quota", "exp"])(
    "rejects signed receipt with foreign %s and preserves recovery",
    async (field) => {
      const f = fixture();
      f.claims[field] = field === "exp" ? 1 : field === "unit_quota" ? 999 : "foreign";
      await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toMatchObject({ txRef: tx });
      expect(f.deps.cache.size).toBe(0);
      expect(f.deps.release).not.toHaveBeenCalled();
    }
  );
  it.each(["signature", "algorithm", "key", "receipt-id", "expiry"])(
    "refuses receipt %s tampering after payment",
    async (kind) => {
      const f = fixture();
      if (kind === "signature") f.corrupt();
      if (kind === "algorithm") f.header.alg = "HS256";
      if (kind === "key") f.header.kid = "unknown";
      if (kind === "receipt-id") f.responseOverrides.receipt_id = "foreign";
      if (kind === "expiry") f.responseOverrides.expires_at = new Date(Date.now() + 9999999).toISOString();
      await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toMatchObject({ txRef: tx });
      expect(f.deps.cache.size).toBe(0);
      expect(f.deps.release).not.toHaveBeenCalled();
    }
  );
  it("ignores a JWT-controlled key URL and uses the configured issuer", async () => {
    const f = fixture();
    f.header.jku = "https://attacker.example/jwks.json";
    expect((await aifp1Fetch(f.deps, url, {}, f.opts))?.status).toBe(200);
    expect(f.deps.fetchImpl).not.toHaveBeenCalledWith(expect.stringContaining("attacker.example"), expect.anything());
  });
});

// ── Stablecoin purchase ──────────────────────────────────────────────────────
// The same fixture, turned into the USDC quote the backend now signs: one
// asset, no native amounts, settleStable with value 0 and an exact approval.
const USDC = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359";
function stableFixture(chain: "polygon" | "base" = "polygon") {
  const f = fixture(chain);
  const USDC = V14_DEPLOYMENTS[chain].splitter.assets.find((a) => a.symbol === "USDC")!.address;
  const q = f.call.args.quote as { token: string; grossAmount: string };
  q.token = USDC;
  q.grossAmount = "100000";
  f.call.asset = "USDC";
  f.call.function = "settleStable((address,address,address,uint256,address,uint256,bytes32,uint256,bytes32),bytes)";
  f.call.value_wei = "0";
  f.call.approval = { token: USDC, spender: f.call.contract, amount: "100000" };
  f.quote.accepted_assets = ["USDC"];
  delete (f.quote as { native_settlement?: unknown }).native_settlement;
  f.claims.asset = "USDC";
  f.responseOverrides.asset = "USDC";
  f.opts.v14 = { ...f.opts.v14!, asset: "USDC" };
  delete f.opts.nativeUsdPrice;
  return f;
}

describe("public v1.4 stablecoin purchase", () => {
  it("asks for a USDC quote, settles the signed token call without any POL price, and verifies a USDC receipt", async () => {
    const f = stableFixture();
    expect((await aifp1Fetch(f.deps, url, {}, f.opts))?.status).toBe(200);
    const quoteCall = (f.deps.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.find(([u]) =>
      String(u).endsWith("/v1/quote")
    )!;
    expect(JSON.parse(String(quoteCall[1]!.body)).asset).toBe("USDC");
    expect(f.deps.settle).toHaveBeenCalledWith(
      expect.objectContaining({ settlementCall: f.call, grossWei: 100000n, token: USDC })
    );
    expect(f.prepared).toHaveBeenCalledWith(expect.objectContaining({ asset: "USDC" }));
    expect(f.price).not.toHaveBeenCalled();
  });

  it.each([
    ["a quote that also accepts POL", (f: any) => (f.quote.accepted_assets = ["USDC", "POL"])],
    [
      // The cap is raised so that only the amount binding can catch this.
      "a stated amount that is not the signed gross",
      (f: any) => {
        f.quote.amount = "0.2";
        f.opts.maxAmountUsd = 1;
      },
    ],
    ["settlement units that are not the signed gross", (f: any) => (f.quote.settlement.total_units = "200000")],
    ["an approval larger than the gross", (f: any) => (f.call.approval.amount = "100000000")],
    ["an approval to another spender", (f: any) => (f.call.approval.spender = merchant)],
    ["an unpinned token", (f: any) => (f.call.args.quote.token = merchant)],
    ["a signed call in another asset", (f: any) => (f.call.asset = "USDC.e")],
    ["native amounts beside a token quote", (f: any) => (f.quote.native_settlement = { asset: "POL" })],
  ])("refuses %s before reserving budget or settling", async (_name, mutate) => {
    const f = stableFixture();
    (mutate as (fx: typeof f) => void)(f);
    await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toThrow();
    expect(f.deps.reserveDaily).not.toHaveBeenCalled();
    expect(f.deps.settle).not.toHaveBeenCalled();
  });

  it("refuses an asset the SDK does not pin before asking for a quote", async () => {
    const f = stableFixture();
    f.opts.v14 = { ...f.opts.v14!, asset: "DAI" };
    await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toThrow(/not a stablecoin pinned/);
    const calls = (f.deps.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([u]) => String(u));
    expect(calls.some((u) => u.endsWith("/v1/quote"))).toBe(false);
  });

  it("does not accept a receipt that names another asset", async () => {
    const f = stableFixture();
    f.claims.asset = "POL";
    f.responseOverrides.asset = "POL";
    await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toThrow(/recover the existing payment/);
  });
});

describe("Base v1.4 chain authorization", () => {
  it.each(["ETH", "USDC"])("pays Base %s and reuses merchant access after changing selected chain", async (asset) => {
    const f = asset === "ETH" ? fixture("base") : stableFixture("base");
    expect((await aifp1Fetch(f.deps, url, {}, f.opts))?.status).toBe(200);
    expect(f.prepared).toHaveBeenCalledWith(expect.objectContaining({ chain: "base", asset }));
    const calls = vi.mocked(f.deps.fetchImpl).mock.calls;
    const quoteBody = JSON.parse(String(calls.find(([u]) => String(u).endsWith("/v1/quote"))![1]!.body));
    const payBody = JSON.parse(String(calls.find(([u]) => String(u).endsWith("/v1/pay"))![1]!.body));
    expect(quoteBody.asset).toBe(asset);
    expect(payBody).toMatchObject({ chain: "base", asset, tx_ref: tx });
    expect(f.deps.signPaymentAuthorization).toHaveBeenCalledWith(expect.stringContaining('"base"'));
    expect((await aifp1Fetch(f.deps, url, {}, { ...f.opts, v14: { ...f.opts.v14!, chain: "polygon" } }))?.status).toBe(
      200
    );
    expect(f.deps.settle).toHaveBeenCalledOnce();
    expect(f.deps.commit).toHaveBeenCalledOnce();
  });

  it.each([
    "unselected",
    "wrong-chain",
    "extra-chain",
    "POL-rate",
    "POL-label",
    "conflicting-payout",
    "Polygon-only-payout",
  ])("refuses Base native %s before signing or reserving funds", async (kind) => {
    const f = fixture("base");
    if (kind === "unselected") delete f.opts.v14!.chain;
    if (kind === "wrong-chain") f.call.chain = "polygon";
    if (kind === "extra-chain") f.quote.accepted_chains.push("polygon");
    if (kind === "POL-rate") f.opts.nativeUsdPrice = { usd: 0.1, observedAtMs: Date.now() };
    if (kind === "POL-label") f.call.asset = f.quote.native_settlement!.asset = "POL";
    if (kind === "conflicting-payout") f.quote.pay_to.base = payer;
    if (kind === "Polygon-only-payout") f.quote.pay_to = { polygon: merchant };
    await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toThrow();
    expect(f.deps.reserveDaily).not.toHaveBeenCalled();
    expect(f.deps.settle).not.toHaveBeenCalled();
    expect(f.deps.signPaymentAuthorization).not.toHaveBeenCalled();
  });

  it("refuses a Polygon token in an explicitly authorized Base purchase before approval", async () => {
    const f = stableFixture("base");
    f.call.args.quote.token = USDC;
    f.call.approval!.token = USDC;
    await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toThrow(/stablecoin call disagrees/);
    expect(f.deps.settle).not.toHaveBeenCalled();
    expect(f.deps.reserveDaily).not.toHaveBeenCalled();
  });

  it.each(["chain", "asset"])("rejects a correctly signed receipt with a foreign %s", async (field) => {
    const f = fixture("base");
    f.claims[field] = f.responseOverrides[field] = field === "chain" ? "polygon" : "POL";
    await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toMatchObject({
      recovery: expect.objectContaining({ chain: "base", asset: "ETH" }),
    });
    expect(f.deps.cache.size).toBe(0);
    expect(f.deps.settle).toHaveBeenCalledOnce();
    expect(f.deps.release).not.toHaveBeenCalled();
  });

  it("recovers the selected Base chain after quote expiry without settling again", async () => {
    const f = stableFixture("base");
    await aifp1Fetch(f.deps, url, {}, f.opts);
    const saved = vi.mocked(f.prepared).mock.calls[0][0] as any;
    saved.quote.expires_at = new Date(1).toISOString();
    const result = await recoverAifp1Payment(saved, f.deps);
    expect(result).toMatchObject({ chain: "base", asset: "USDC", tx_ref: tx });
    expect(f.deps.settle).toHaveBeenCalledOnce();
  });

  it.each(["missing", "foreign"])(
    "refuses %s chain in a Base recovery journal before authorizing receipt issuance",
    async (kind) => {
      const f = stableFixture("base");
      await aifp1Fetch(f.deps, url, {}, f.opts);
      const saved = vi.mocked(f.prepared).mock.calls[0][0] as any;
      if (kind === "missing") delete saved.chain;
      else saved.chain = "polygon";
      vi.mocked(f.deps.signPaymentAuthorization).mockClear();
      expect(() => recoverAifp1Payment(saved, f.deps)).toThrow(/recovery chain or asset/);
      expect(f.deps.signPaymentAuthorization).not.toHaveBeenCalled();
    }
  );
});
