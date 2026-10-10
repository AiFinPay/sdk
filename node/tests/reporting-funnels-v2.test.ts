import { describe, expect, it, vi } from "vitest";
import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { keccak256, stringToHex, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { routeIdOf } from "../src/settlementV14.js";

// Read-only pre-change source replay is an explicit author red control.
const baseline = process.env.AIFP_S05_BASELINE === "1";
const payerModule = baseline
  ? await import("../../../aifinpay-sdk/node/src/aifp1.js")
  : await import("../src/aifp1.js");
const agentModule = baseline
  ? await import("../../../aifinpay-sdk/node/src/agent.js")
  : await import("../src/agent.js");
const unifiedModule = baseline
  ? await import("../../../aifinpay-sdk/node/src/unifiedAgent.js")
  : await import("../src/unifiedAgent.js");
const token = "A".repeat(43);
const api = "https://api.aifinpay.io";
const url = "https://merchant.example/api/genres";
const merchant = "0x2222222222222222222222222222222222222222";
const tx = keccak256("0x1234");
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function fixture() {
  const account = privateKeyToAccount(`0x${randomBytes(32).toString("hex")}`);
  const payer = account.address;
  const expiry = Math.floor(Date.now() / 1000) + 600;
  const quote: any = {
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
    settlement_call: {
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
          token: "0x" + "0".repeat(40),
          grossAmount: "1000000000000000000",
          ipCreator: "0x" + "0".repeat(40),
          validUntil: String(expiry),
          orderIdHash: keccak256(stringToHex("qt_v14")),
          nonce: "0",
          routeId: routeIdOf("merchant-aifp1"),
        },
        signature: "0x" + "11".repeat(65),
      },
    },
    native_settlement: {
      asset: "POL",
      decimals: 18,
      rate_usd: "0.1",
      total_wei: "1000000000000000000",
      gross_wei: "1000000000000000000",
      payer_total_wei: "1000000000000000000",
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
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const claims = {
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
  const unsigned = `${encode({ alg: "EdDSA", typ: "JWT", kid: "synthetic-key" })}.${encode(claims)}`;
  const receipt = `${unsigned}.${sign(null, Buffer.from(unsigned), privateKey).toString("base64url")}`;
  let payFailure = false;
  const fetchImpl = vi.fn(async (input: any, init?: RequestInit) => {
    const target = String(input);
    if (target.endsWith("/v1/quote")) return json(quote);
    if (target.endsWith("/.well-known/jwks.json"))
      return json({
        keys: [{ ...publicKey.export({ format: "jwk" }), kid: "synthetic-key", alg: "EdDSA", use: "sig" }],
      });
    if (target.endsWith("/v1/pay")) {
      const request = JSON.parse(String(init?.body));
      const auth = request.payment_authorization;
      const statement = JSON.stringify([
        "AiFinPay receipt authorization v1",
        api,
        quote.quote_id,
        quote.nonce,
        quote.merchant_id,
        "live",
        request.chain,
        request.tx_ref,
        request.asset || "",
        new Headers(init?.headers).get("Idempotency-Key"),
        auth.payer,
        auth.expires_at,
      ]);
      if (!(await verifyMessage({ address: payer, message: statement, signature: auth.signature })))
        return json({ error: "invalid payer proof" }, 401);
      return payFailure
        ? json({ error: "refused" }, 400)
        : json({
            receipt_id: "rcpt_v14",
            receipt,
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
  });
  const prepared = vi.fn(async () => {});
  const deps: any = {
    fetchImpl,
    cache: new payerModule.Aifp1ReceiptCache(),
    agentId: payer,
    payerAddress: payer,
    signPaymentAuthorization: vi.fn((message) => account.signMessage({ message })),
    settle: vi.fn(async (p) => {
      await p.onPrepared?.({ hash: tx, serializedTransaction: "0x1234" });
      return tx;
    }),
    checkPerCall: () => true,
    reserveDaily: vi.fn(async () => "reservation"),
    commit: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
    prepareReservation: vi.fn(async () => {}),
    assertReservation: vi.fn(async () => {}),
    completeReservation: vi.fn(async () => {}),
  };
  const opts: any = {
    reportingToken: token,
    gatewayOrigins: ["https://merchant.example"],
    resourcePathMode: "direct",
    scope: "exact",
    units: 200,
    maxAmountUsd: 0.11,
    nativeUsdPrice: { usd: 0.1, observedAtMs: Date.now() },
    v14: { chain: "polygon", maxGasWei: 50000000000000000n, onPrepared: prepared },
  };
  return {
    deps,
    opts,
    prepared,
    fetchImpl,
    failPay: () => {
      payFailure = true;
    },
  };
}

describe("S05 memory-only optional payer propagation", () => {
  it("sends capability only to canonical quote; authenticates and settles exactly once, then reuses receipt", async () => {
    const f = fixture();
    expect(
      (
        await payerModule.aifp1Fetch(
          f.deps,
          url,
          { headers: { "AIFP-Reporting-Token": token, "X-Custom": "original" } },
          f.opts
        )
      )?.status
    ).toBe(200);
    expect((await payerModule.aifp1Fetch(f.deps, url, {}, f.opts))?.status).toBe(200);
    const quoteCalls = f.fetchImpl.mock.calls.filter(([target]) => String(target).endsWith("/v1/quote"));
    const payCalls = f.fetchImpl.mock.calls.filter(([target]) => String(target).endsWith("/v1/pay"));
    expect(quoteCalls).toHaveLength(1);
    expect(payCalls).toHaveLength(1);
    expect(new Headers(quoteCalls[0][1]?.headers).get("AIFP-Reporting-Token")).toBe(token);
    for (const [target, init] of f.fetchImpl.mock.calls) {
      if (!String(target).endsWith("/v1/quote"))
        expect(new Headers(init?.headers).has("AIFP-Reporting-Token")).toBe(false);
      expect(String(init?.body)).not.toContain(token);
      expect(init?.redirect).not.toBe("follow");
    }
    expect(f.deps.settle).toHaveBeenCalledTimes(1);
    expect(f.deps.signPaymentAuthorization).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(f.prepared.mock.calls)).not.toContain(token);
    expect(JSON.stringify(f.deps.reserveDaily.mock.calls)).not.toContain(token);
  });
  it("a pay refusal preserves original error/recovery and never retries transfer or persists capability", async () => {
    const f = fixture();
    f.failPay();
    let error: any;
    try {
      await payerModule.aifp1Fetch(f.deps, url, {}, f.opts);
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(payerModule.Aifp1PayError);
    expect(error.recovery.txRef).toBe(tx);
    expect(JSON.stringify(error.recovery)).not.toContain(token);
    expect(f.deps.settle).toHaveBeenCalledTimes(1);
    expect(f.fetchImpl.mock.calls.filter(([u]) => String(u).endsWith("/v1/pay"))).toHaveLength(1);
  });
  it.each([undefined, "bad\r\nvalue", "A".repeat(44), { token }])(
    "invalid/unset telemetry keeps original result: %s",
    async (reportingToken) => {
      const f = fixture();
      f.opts.reportingToken = reportingToken;
      expect((await payerModule.aifp1Fetch(f.deps, url, {}, f.opts))?.status).toBe(200);
      expect(f.deps.settle).toHaveBeenCalledTimes(1);
      for (const [, init] of f.fetchImpl.mock.calls)
        expect(new Headers(init?.headers).has("AIFP-Reporting-Token")).toBe(false);
    }
  );
  it("custom quote origins never receive the capability", async () => {
    const f = fixture();
    f.opts.apiBaseUrl = "https://custom-api.example";
    expect((await payerModule.aifp1Fetch(f.deps, url, {}, f.opts))?.status).toBe(200);
    for (const [, init] of f.fetchImpl.mock.calls)
      expect(new Headers(init?.headers).has("AIFP-Reporting-Token")).toBe(false);
  });
  it("Agent first-party quote opt-in sends one header and refuses redirect forwarding", async () => {
    const fetchImpl = vi.fn(async () => json({ gross: "1" }));
    const agent = agentModule.Agent.new({ baseUrl: "https://aifinpay.io", fetchImpl });
    expect(await agent.quoteSplit({ chain: "polygon", merchantAmount: "1", reportingToken: token } as any)).toEqual({
      gross: "1",
    });
    expect(new Headers(fetchImpl.mock.calls[0][1]?.headers).get("AIFP-Reporting-Token")).toBe(token);
    expect(fetchImpl.mock.calls[0][1]?.redirect).toBe("manual");
    expect(String(fetchImpl.mock.calls[0][0])).not.toContain(token);
  });
  it("unified facade passes optional token only to quote and preserves refusal behavior", async () => {
    const fetchImpl = vi.fn(async (input, init) =>
      String(input).endsWith("/v1/quote")
        ? json({ error: "refused" }, 400)
        : json(
            {
              error: "AIFP-402",
              protocol: "AIFP-1",
              merchant_id: "mrch_example",
              resource: "/api/genres",
              unit_weight: 1,
            },
            402
          )
    );
    const agent = await unifiedModule.AiFinPayAgent.new({
      fetchImpl,
      spendLedger: new (await import("../src/spendLedger.js")).MemorySpendLedger(),
    });
    await expect(
      agent.fetchPaid(url, {}, {
        reportingToken: token,
        gatewayOrigins: ["https://merchant.example"],
        resourcePathMode: "direct",
        scope: "exact",
      } as any)
    ).rejects.toThrow(/POST.*quote/);
    const quote = fetchImpl.mock.calls.find(([u]) => String(u).endsWith("/v1/quote"));
    expect(new Headers(quote?.[1]?.headers).get("AIFP-Reporting-Token")).toBe(token);
    expect(fetchImpl.mock.calls.filter(([u]) => String(u).endsWith("/v1/pay"))).toHaveLength(0);
  });
});
