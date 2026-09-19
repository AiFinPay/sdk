import { describe, it, expect, vi } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import { keccak256, stringToHex } from "viem";
import {
  aifp1Fetch,
  Aifp1ReceiptCache,
  type Aifp1Quote,
  type Aifp1Deps,
  type Aifp1FetchOptions,
} from "../src/aifp1.js";
import { routeIdOf, type V14SettlementCall } from "../src/settlementV14.js";
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

function fixture() {
  const expiry = Math.floor(Date.now() / 1000) + 600;
  const call: V14SettlementCall = {
    chain: "polygon",
    contract: "0x78bed24B8D3A5eB2cf8D9A0D6A9Da6Bc5d7f32eB",
    splitter_version: "1.4",
    route: "merchant-aifp1",
    asset: "POL",
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
    value_wei: "1000000000000000000",
    args: {
      quote: {
        payer,
        merchant,
        token: zero,
        grossAmount: "1000000000000000000",
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
    accepted_assets: ["POL"],
    accepted_chains: ["polygon"],
    pay_to: { polygon: merchant },
    settlement_call: call,
    native_settlement: {
      asset: "POL",
      decimals: 18,
      rate_usd: "0.1",
      total_wei: call.value_wei,
      gross_wei: call.value_wei,
      payer_total_wei: call.value_wei,
      merchant_wei: "990000000000000000",
      treasury_wei: "10000000000000000",
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
    asset: "POL",
    chain: "polygon",
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
        asset: "POL",
        chain: "polygon",
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
  const price = vi.fn(async () => ({ usd: 0.1, observedAtMs: Date.now() }));
  const prepared = vi.fn(async () => {});
  const opts: Aifp1FetchOptions = {
    gatewayOrigins: ["https://merchant.example"],
    resourcePathMode: "direct",
    scope: "exact",
    units: 200,
    maxAmountUsd: 0.11,
    nativeUsdPrice: price,
    v14: { maxGasWei: 50000000000000000n, onPrepared: prepared },
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
