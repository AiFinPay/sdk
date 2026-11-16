// EVM /v1/quote authorization against vectors generated and verified by the backend's own payment-auth.js.
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { generateKeyPairSync, sign } from "node:crypto";
import { keccak256, stringToHex, verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import {
  aifp1Fetch,
  evmQuoteAuthorizationMessage,
  Aifp1ReceiptCache,
  type Aifp1Quote,
  type Aifp1Deps,
  type Aifp1FetchOptions,
} from "../src/aifp1.js";
import { routeIdOf, type V14SettlementCall } from "../src/settlementV14.js";

type Vector = {
  name: string;
  issuer: string;
  body: Record<string, unknown>;
  payer: string;
  nonce: string;
  expires_at: number;
  message: string;
  signature: `0x${string}`;
};
const V = JSON.parse(
  readFileSync(new URL("./fixtures/evm-quote-authorization-backend.json", import.meta.url), "utf8")
) as { key: `0x${string}`; address: `0x${string}`; vectors: Vector[] };
const account = privateKeyToAccount(V.key);

// Test-local mirror of the backend's evmQuoteMessageFor; pinned to the vectors below.
function backendMessage(issuer: string, body: Record<string, any>, payer: string, nonce: string, expiresAt: number) {
  return JSON.stringify([
    "AiFinPay EVM quote authorization v1",
    issuer,
    body.merchant_id,
    body.resource ?? null,
    body.tier ?? "standard",
    body.requests ?? null,
    body.units ?? null,
    body.currency ?? "USD",
    body.scope ?? "exact",
    body.settlement_chain ?? null,
    body.settlement_version ?? null,
    body.asset ?? null,
    body.force ?? false,
    payer,
    nonce,
    expiresAt,
  ]);
}

describe("backend vectors", () => {
  it.each(V.vectors.map((v) => [v.name, v] as const))("%s", async (_name, v) => {
    const auth = { payer: v.payer, nonce: v.nonce, expires_at: v.expires_at };
    expect(evmQuoteAuthorizationMessage(v.body, auth, v.issuer)).toBe(v.message);
    expect(backendMessage(v.issuer, v.body, v.payer, v.nonce, v.expires_at)).toBe(v.message);
    expect(account.address).toBe(V.address);
    expect(v.payer).toBe(V.address.toLowerCase());
    expect(await account.signMessage({ message: v.message })).toBe(v.signature);
    expect(await verifyMessage({ address: v.payer as `0x${string}`, message: v.message, signature: v.signature })).toBe(
      true
    );
  });
});

const payer = V.address;
const merchant = "0x2222222222222222222222222222222222222222";
const zero = "0x0000000000000000000000000000000000000000";
const tx = keccak256("0x1234");
const url = "https://merchant.example/api/genres";
const api = "https://api.aifinpay.io";
const { privateKey, publicKey } = generateKeyPairSync("ed25519");
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

type QuoteAnswer = "quote" | "transport" | 503 | 409 | 401 | 410 | "garbage";

function fixture(answers: QuoteAnswer[]) {
  const gross = 1_000_000_000_000_000_000n;
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
    value_wei: String(gross),
    args: {
      quote: {
        payer,
        merchant,
        token: zero,
        grossAmount: String(gross),
        ipCreator: zero,
        validUntil: String(expiry),
        orderIdHash: keccak256(stringToHex("qt_evm_auth")),
        nonce: "0",
        routeId: routeIdOf("merchant-aifp1"),
      },
      signature: `0x${"11".repeat(65)}`,
    },
  };
  const quote: Aifp1Quote = {
    quote_id: "qt_evm_auth",
    payer: payer.toLowerCase(),
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
      merchant_wei: String(gross - gross / 100n),
      treasury_wei: String(gross / 100n),
      creator_wei: "0",
      valid_until: expiry,
      settlement_semantics: "gross-inclusive",
    },
    fee_bps: 100,
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
  const claims = {
    iss: api,
    sub: payer.toLowerCase(),
    aud: quote.merchant_id,
    resource: quote.resource,
    scope: quote.scope,
    amount: "0.1",
    currency: "USD",
    asset: "POL",
    chain: "polygon",
    tx_ref: tx,
    receipt_id: "rcpt_evm_auth",
    unit_quota: 200,
    iat: Math.floor(Date.now() / 1000),
    exp: expiry,
  };
  const encode = (v: unknown) => Buffer.from(JSON.stringify(v)).toString("base64url");
  const quoteRaw: string[] = [];
  const verified: boolean[] = [];
  const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const target = String(input);
    if (target === `${api}/v1/quote`) {
      const raw = String(init?.body);
      quoteRaw.push(raw);
      const body = JSON.parse(raw);
      const auth = body.quote_authorization;
      const now = Math.floor(Date.now() / 1000);
      verified.push(
        auth?.payer === String(body.payer).toLowerCase() &&
          /^[a-f0-9]{64}$/.test(auth.nonce) &&
          Number.isSafeInteger(auth.expires_at) &&
          auth.expires_at > now &&
          auth.expires_at <= now + 300 &&
          /^0x[0-9a-fA-F]{130}$/.test(auth.signature) &&
          (await verifyMessage({
            address: auth.payer,
            message: backendMessage(api, body, auth.payer, auth.nonce, auth.expires_at),
            signature: auth.signature,
          }))
      );
      const answer = answers.shift() ?? "quote";
      if (answer === "transport") throw new TypeError("fetch failed");
      if (answer === "garbage") return new Response("<html>bad gateway</html>", { status: 200 });
      if (answer === 503) return json({ error: "AIFP-503-EVM", reason: "evm_policy_state_unavailable" }, 503);
      if (answer === 409) return json({ error: "AIFP-409-EVM", reason: "evm_quote_authorization_replayed" }, 409);
      if (answer === 401) return json({ error: "AIFP-401-QUOTE-PAYER" }, 401);
      if (answer === 410) return json({ error: "AIFP-410-EVM", reason: "evm_quote_authorization_expired" }, 410);
      return json(quote);
    }
    if (target === `${api}/.well-known/jwks.json`)
      return json({ keys: [{ ...publicKey.export({ format: "jwk" }), kid: "receipt-key", alg: "EdDSA", use: "sig" }] });
    if (target === `${api}/v1/pay`) {
      const unsigned = `${encode({ alg: "EdDSA", typ: "JWT", kid: "receipt-key" })}.${encode(claims)}`;
      return json({
        receipt_id: "rcpt_evm_auth",
        receipt: `${unsigned}.${sign(null, Buffer.from(unsigned), privateKey).toString("base64url")}`,
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
  }) as unknown as typeof fetch;
  const deps: Aifp1Deps = {
    fetchImpl,
    cache: new Aifp1ReceiptCache(),
    agentId: payer,
    payerAddress: payer,
    signPaymentAuthorization: vi.fn((message: string) => account.signMessage({ message })),
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
  const opts: Aifp1FetchOptions = {
    gatewayOrigins: ["https://merchant.example"],
    resourcePathMode: "direct",
    scope: "exact",
    units: 200,
    maxAmountUsd: 0.11,
    nativeUsdPrice: async () => ({ usd: 0.1, observedAtMs: Date.now() }),
    v14: { chain: "polygon", maxGasWei: 50000000000000000n, onPrepared: vi.fn(async () => {}) },
  };
  const nonces = () => quoteRaw.map((raw) => JSON.parse(raw).quote_authorization.nonce as string);
  return { deps, opts, quoteRaw, verified, nonces };
}

describe("aifp1Fetch signs every EVM /v1/quote", () => {
  it("sends the request body plus a valid quote_authorization", async () => {
    const f = fixture(["quote"]);
    expect((await aifp1Fetch(f.deps, url, {}, f.opts))?.status).toBe(200);
    expect(f.quoteRaw).toHaveLength(1);
    expect(f.verified).toEqual([true]);
    const { quote_authorization: auth, ...body } = JSON.parse(f.quoteRaw[0]);
    expect(body).toEqual({
      merchant_id: "mrch_example",
      payer,
      resource: "/api/genres",
      scope: "exact",
      units: 200,
      agent_id: payer,
      asset: "POL",
      settlement_chain: "polygon",
    });
    expect(auth.payer).toBe(payer.toLowerCase());
    expect(auth.expires_at - Math.floor(Date.now() / 1000)).toBeGreaterThan(230);
    expect(f.deps.settle).toHaveBeenCalledOnce();
  });

  it.each([
    ["a transport error", "transport"],
    ["a 503", 503],
    ["a 200 that is not JSON", "garbage"],
  ] as const)("resends the byte-identical body after %s", async (_label, first) => {
    const f = fixture([first, "quote"]);
    expect((await aifp1Fetch(f.deps, url, {}, f.opts))?.status).toBe(200);
    expect(f.quoteRaw).toHaveLength(2);
    expect(f.quoteRaw[1]).toBe(f.quoteRaw[0]);
    expect(f.verified).toEqual([true, true]);
    expect(f.deps.settle).toHaveBeenCalledOnce();
  });

  it("re-signs a fresh nonce once after 410 expired", async () => {
    const f = fixture([410, "quote"]);
    expect((await aifp1Fetch(f.deps, url, {}, f.opts))?.status).toBe(200);
    expect(f.quoteRaw).toHaveLength(2);
    expect(f.nonces()[1]).not.toBe(f.nonces()[0]);
    expect(f.verified).toEqual([true, true]);
  });

  it("stops after a second 410 instead of looping", async () => {
    const f = fixture([410, 410, "quote"]);
    await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toThrow(/410/);
    expect(f.quoteRaw).toHaveLength(2);
    expect(f.deps.settle).not.toHaveBeenCalled();
  });

  it.each([409, 401] as const)("throws on %s after one POST", async (status) => {
    const f = fixture([status, "quote"]);
    await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toThrow(new RegExp(String(status)));
    expect(f.quoteRaw).toHaveLength(1);
    expect(f.deps.reserveDaily).not.toHaveBeenCalled();
    expect(f.deps.settle).not.toHaveBeenCalled();
  });

  it("gives up after three uncertain failures, all with the same body", async () => {
    const f = fixture(["transport", "transport", "transport", "quote"]);
    await expect(aifp1Fetch(f.deps, url, {}, f.opts)).rejects.toThrow(/fetch failed/);
    expect(f.quoteRaw).toHaveLength(3);
    expect(new Set(f.quoteRaw).size).toBe(1);
    expect(f.deps.settle).not.toHaveBeenCalled();
  });
});
