// AIFP-1 client — the behaviour that decides whether a paywalled site is
// payable at all.
//
// A receipt is a prepaid BATCH of billing units, not a ticket for one request,
// and the minimum batch is $0.10 settled on-chain. A client that re-quotes per
// request therefore does not "work a bit slower" — it charges eleven cents and
// a transaction's gas for a $0.0001 page view. So the tests that matter here
// are about NOT paying: reuse a batch that covers the path, buy a new one only
// when the old one is genuinely spent, and never send a receipt to a merchant
// or a path it does not cover.
//
// The gateway and /v1 endpoints are mocked, but the mock mirrors the real
// server's decisions — routes/gateway.js metering, aifp/scope.js coverage,
// routes/aifp.js idempotency — because a mock that is merely agreeable would
// pass while the SDK talks to nobody.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { AiFinPayAgent, BudgetCapExceededError } from "../src/unifiedAgent.js";
import { MemorySpendLedger } from "../src/spendLedger.js";
import {
  Aifp1ReceiptCache,
  Aifp1QuoteError,
  idempotencyKeyFor,
  scopeCovers,
  prefixHint,
  parseGatewayUrl,
  defaultUnitsFor,
  type Aifp1CachedReceipt,
} from "../src/aifp1.js";

const GATEWAY = "https://gateway.aifinpay.io";
const API     = "https://api.aifinpay.io";
const MERCHANT_WALLET = "0x1111111111111111111111111111111111111111";

// ── A gateway + /v1 that behaves like the real one ────────────────────────

interface MockReceipt {
  receiptId: string;
  merchantId: string;
  scope: string;
  resource: string;
  unitQuota: number;
  used: number;
  expMs: number;
}

interface MockServer {
  /** Multiply total_wei in the quote without touching the USD amount. */
  inflateWeiBy: number | null;
  /** Force an unparseable expires_at out of /v1/pay. */
  expiresAtOverride: string | null;
  /** Answer this gateway path with the merchant's own 403. */
  upstream403Path: string | null;
  quotes: number;
  pays: number;
  idempotencyKeys: string[];
  /** Every gateway hit: path + whether a receipt rode along. */
  gatewayHits: Array<{ path: string; receipt: string | null }>;
  /** Route weights, merchant-relative path → billing units. Default 1. */
  weights: Record<string, number>;
  /** slug → merchant_id. */
  merchants: Record<string, string>;
  /** Number of AIFP-425 answers /v1/pay gives before settling. */
  payNotConfirmedTimes: number;
  receipts: Map<string, MockReceipt>;
  fetch: typeof fetch;
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status, headers: { "content-type": "application/json", ...headers },
  });
}

/** Mirror of backend/aifp/scope.js — the server-side coverage test. */
function serverScopeCovers(scope: string, resource: string, path: string): boolean {
  if (scope === "merchant") return true;
  if (scope === "prefix") {
    if (resource === "/") return true;
    if (path === resource) return true;
    const boundary = resource.endsWith("/") ? resource : resource + "/";
    return path.startsWith(boundary);
  }
  return path === resource;
}

function mockServer(): MockServer {
  const s: MockServer = {
    // Flags read INSIDE the handler, not by swapping s.fetch: agentFor passes
    // s.fetch to the agent, which keeps the reference, so reassigning it after
    // the agent exists changes nothing. A test that did that asserted against
    // the untouched mock and passed for the wrong reason.
    inflateWeiBy: null,
    expiresAtOverride: null,
    upstream403Path:   null,
    quotes: 0,
    pays: 0,
    idempotencyKeys: [],
    gatewayHits: [],
    weights: {},
    merchants: { acme: "mrch_acme", other: "mrch_other" },
    payNotConfirmedTimes: 0,
    receipts: new Map(),
    fetch: null as unknown as typeof fetch,
  };
  let seq = 0;

  s.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input.toString());
    const headers = new Headers(init?.headers as HeadersInit | undefined);

    // ── POST /v1/quote ──────────────────────────────────────────────────
    if (url.origin === API && url.pathname === "/v1/quote") {
      s.quotes++;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const scope: string = body.scope ?? "exact";
      if (!["exact", "prefix", "merchant"].includes(scope)) {
        return json({ error: "AIFP-400", detail: "bad scope" }, 400);
      }
      // The real server refuses a batch under the $0.10 floor (200 units at $0.0005).
      if (!Number.isInteger(body.units) || body.units < 200) {
        return json({ error: "AIFP-400", detail: "units must be an integer 200..100000000" }, 400);
      }
      const resource = scope === "merchant" ? "*" : String(body.resource ?? "");
      if (scope !== "merchant" && !resource.startsWith("/")) {
        return json({ error: "AIFP-400", detail: 'resource must start with "/"' }, 400);
      }
      const quote_id = `qt_${String(++seq).padStart(16, "0")}`;
      const expiresAt = new Date(Date.now() + 900_000).toISOString();
      const quotedTotalWei = s.inflateWeiBy
        ? BigInt(Math.round(1379310344827586206 * s.inflateWeiBy))
        : 1379310344827586206n;
      const quotedTreasuryWei = quotedTotalWei / 100n;
      const quotedMerchantWei = quotedTotalWei - quotedTreasuryWei;
      const grossUnits = BigInt(body.units) * 500n;
      const protocolUnits = grossUnits / 100n;
      const merchantUnits = grossUnits - protocolUnits;
      return json({
        quote_id,
        merchant_id: body.merchant_id,
        resource,
        scope,
        tier: "standard",
        unit_price: "0.0005",
        requests: body.units,
        units: body.units,
        unit_quota: body.units,
        base_unit_price_usd: "0.0005",
        amount: (body.units * 0.0005).toFixed(6).replace(/0+$/, ""),
        currency: "USD",
        accepted_assets: ["USDC", "USDT", "POL"],
        accepted_chains: ["polygon"],
        pay_to: { polygon: MERCHANT_WALLET },
        fee_bps: 100,
        no_minimum_fee: true,
        native_settlement: {
          asset: "POL", decimals: 18, rate_usd: "0.073000",
          rate_fixed_at: new Date().toISOString(),
          total_wei: quotedTotalWei.toString(),
          gross_wei: quotedTotalWei.toString(),
          payer_total_wei: quotedTotalWei.toString(),
          merchant_wei: quotedMerchantWei.toString(),
          treasury_wei: quotedTreasuryWei.toString(),
          creator_wei: "0",
          valid_until: String(Math.floor(Date.parse(expiresAt) / 1000)),
          settlement_semantics: "gross-inclusive",
        },
        settlement: {
          batch_units: grossUnits.toString(),
          total_units: grossUnits.toString(),
          gross_units: grossUnits.toString(),
          payer_total_units: grossUnits.toString(),
          merchant_units: merchantUnits.toString(),
          protocol_fee_units: protocolUnits.toString(),
          creator_units: "0",
          fee_on_top: false,
        },
        nonce: "n-" + quote_id,
        expires_at: expiresAt,
      });
    }

    // ── POST /v1/pay ────────────────────────────────────────────────────
    if (url.origin === API && url.pathname === "/v1/pay") {
      const key = headers.get("Idempotency-Key");
      if (!key) return json({ error: "AIFP-400", detail: "Idempotency-Key header is required" }, 400);
      s.idempotencyKeys.push(key);
      if (s.payNotConfirmedTimes > 0) {
        s.payNotConfirmedTimes--;
        return json({ error: "AIFP-425", detail: "settlement not yet confirmed" }, 425);
      }
      s.pays++;
      const body = JSON.parse(String(init?.body ?? "{}"));
      const receiptId = `rcpt_${String(++seq).padStart(16, "0")}`;
      const jwt = `jwt.${receiptId}`;
      // The quote the client just paid — replayed from the sequence it holds.
      const quoted = lastQuotes.get(body.quote_id);
      if (!quoted) return json({ error: "AIFP-404", detail: "unknown or expired quote_id" }, 404);
      s.receipts.set(jwt, {
        receiptId,
        merchantId: quoted.merchant_id,
        scope: quoted.scope,
        resource: quoted.resource,
        unitQuota: quoted.unit_quota,
        used: 0,
        expMs: Date.now() + 30 * 24 * 3600 * 1000,
      });
      return json({
        receipt_id: receiptId, receipt: jwt, status: "settled", tx_ref: body.tx_ref,
        merchant_id: quoted.merchant_id, resource: quoted.resource, scope: quoted.scope,
        amount: quoted.amount, currency: "USD", tier: "standard", unit_price: "0.0005",
        quota: quoted.unit_quota, unit_quota: quoted.unit_quota, base_unit_price_usd: "0.0005",
        asset: body.asset, chain: body.chain,
        fee: false,
        settled_at: new Date().toISOString(),
        expires_at: s.expiresAtOverride
          ?? new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString(),
        settlement: { chain: "polygon", tx_ref: body.tx_ref },
      });
    }

    // ── The gateway ─────────────────────────────────────────────────────
    if (url.origin === GATEWAY) {
      // The merchant's OWN 403, proxied verbatim by routes/gateway.js:310.
      // Deliberately not shaped like {"error":"AIFP-403"} — that difference is
      // the only thing telling the client whose refusal it is.
      if (s.upstream403Path && url.pathname.endsWith(s.upstream403Path)) {
        return json({ error: "forbidden", detail: "merchant origin says no" }, 403);
      }
      const segments = url.pathname.split("/").filter(Boolean);
      const slug = segments[0]!;
      const restPath = "/" + segments.slice(1).join("/");
      const token = headers.get("AIFP-Receipt");
      s.gatewayHits.push({ path: restPath, receipt: token });

      const merchantId = s.merchants[slug];
      if (!merchantId) return json({ error: "AIFP-404", detail: "unknown gateway slug" }, 404);
      const weight = s.weights[restPath] ?? 1;

      const challenge = (detail: string) => json({
        error: "AIFP-402", detail, protocol: "AIFP-1",
        merchant_id: merchantId, resource: restPath, unit_weight: weight,
        base_unit_price_usd: "0.0005",
        how_to_pay: [`POST ${API}/v1/quote {"merchant_id":"${merchantId}","resource":"${restPath}","units":200}`],
        scopes: { note: "a batch can cover more than this one path", examples: [] },
      }, 402);

      if (!token) return challenge("Payment Required");
      const rec = s.receipts.get(token);
      if (!rec) return json({ error: "AIFP-403", detail: "receipt verification failed" }, 403);
      if (rec.merchantId !== merchantId) {
        return json({ error: "AIFP-403", detail: "receipt verification failed (audience)" }, 403);
      }
      if (rec.expMs <= Date.now()) return challenge("receipt expired — prepay a new batch");
      if (!serverScopeCovers(rec.scope, rec.resource, restPath)) {
        return json({
          error: "AIFP-403",
          detail: `receipt is scoped to ${rec.resource} (${rec.scope}), not ${restPath}`,
        }, 403);
      }
      rec.used += weight;
      if (rec.used > rec.unitQuota) return challenge("quota exhausted — prepay the next batch");
      return json(
        { ok: true, path: restPath },
        200,
        { "AIFP-Quota-Remaining": String(rec.unitQuota - rec.used) },
      );
    }

    return new Response("not mocked: " + url.toString(), { status: 404 });
  }) as typeof globalThis.fetch;

  // /v1/pay needs the quote it is settling; the real server stores it, so does this.
  const lastQuotes = new Map<string, any>();
  const wrapped = s.fetch;
  s.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const r = await wrapped(input, init);
    const url = new URL(typeof input === "string" ? input : input.toString());
    if (url.origin === API && url.pathname === "/v1/quote" && r.ok) {
      const q = await r.clone().json();
      lastQuotes.set(q.quote_id, q);
    }
    return r;
  }) as typeof globalThis.fetch;

  return s;
}

// ── Agent wired to the mock, with the chain stubbed out ───────────────────

interface Settlement {
  merchantWallet: string;
  grossWei: bigint;
  merchantWei: bigint;
  treasuryWei: bigint;
  creatorWei: bigint;
  validUntil: bigint;
  orderId: string;
}

async function agentFor(server: MockServer, opts: Record<string, unknown> = {}) {
  const agent = await AiFinPayAgent.fromSeed("22".repeat(32), {
    telemetry: false,
    fetchImpl: server.fetch,
    ...opts,
  });
  const settlements: Settlement[] = [];
  // The one thing that cannot be mocked at the HTTP layer. Stubbed rather than
  // stubbed-out: the arguments are asserted, because "paid the right merchant
  // the right amount against the right order id" is the whole safety property.
  (agent as unknown as { settleAifp1NativeV13: (p: Settlement) => Promise<string> })
    .settleAifp1NativeV13 = async (p: Settlement) => {
      settlements.push({ ...p });
      return "0x" + "ab".repeat(32);
    };
  return { agent, settlements };
}

let originalFetch: typeof globalThis.fetch;
beforeEach(() => { originalFetch = globalThis.fetch; });
afterEach(() => { globalThis.fetch = originalFetch; });

// ── Pass-through ──────────────────────────────────────────────────────────

describe("aifp1: requests that are not an AIFP-1 paywall", () => {
  it("returns a non-402 response untouched and pays nothing", async () => {
    const server = mockServer();
    server.receipts.clear();
    // A free route: mark the merchant open by answering 200 without a receipt.
    const base = server.fetch;
    server.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof i === "string" ? i : i.toString());
      if (u.origin === GATEWAY) return json({ ok: true, free: true });
      return base(i, init);
    }) as typeof globalThis.fetch;

    const { agent, settlements } = await agentFor(server);
    const res = await agent.fetchPaid(`${GATEWAY}/acme/free/thing`);
    expect(res!.status).toBe(200);
    expect(await res!.json()).toEqual({ ok: true, free: true });
    expect(server.quotes).toBe(0);
    expect(settlements).toHaveLength(0);
  });

  it("leaves a 402 that belongs to another protocol alone", async () => {
    const server = mockServer();
    const base = server.fetch;
    server.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof i === "string" ? i : i.toString());
      if (u.origin === GATEWAY) {
        // x402 / bridge shape — call() owns this one, not fetchPaid().
        return json({ error: "payment_required", protocol: "x402", accepts: [] }, 402);
      }
      return base(i, init);
    }) as typeof globalThis.fetch;

    const { agent, settlements } = await agentFor(server);
    const res = await agent.fetchPaid(`${GATEWAY}/acme/x`);
    expect(res!.status).toBe(402);
    expect((await res!.json()).protocol).toBe("x402");
    expect(server.quotes).toBe(0);
    expect(settlements).toHaveLength(0);
  });
});

// ── The paid path ─────────────────────────────────────────────────────────

describe("aifp1: paying a paywall", () => {
  it("quotes, settles on-chain against the quote id, pays and retries", async () => {
    const server = mockServer();
    const { agent, settlements } = await agentFor(server);

    const res = await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`);

    expect(res!.status).toBe(200);
    expect(server.quotes).toBe(1);
    expect(server.pays).toBe(1);
    expect(settlements).toHaveLength(1);
    // The binding /v1/pay verifies on-chain: orderId === quote_id, and the
    // funds go to the wallet the quote named.
    expect(settlements[0]!.orderId).toMatch(/^qt_[0-9]{16}$/);
    expect(settlements[0]!.merchantWallet).toBe(MERCHANT_WALLET);
    expect(settlements[0]!.grossWei).toBe(1379310344827586206n);
    expect(settlements[0]!.merchantWei).toBe(1365517241379310344n);
    expect(settlements[0]!.treasuryWei).toBe(13793103448275862n);
    expect(settlements[0]!.creatorWei).toBe(0n);

    // Three gateway hits: refused, then the paid retry. First carried no
    // receipt (we had none), the retry did.
    expect(server.gatewayHits.map((h) => h.receipt !== null)).toEqual([false, true]);
  });

  it("buys a prefix batch by default, not a batch for the single URL", async () => {
    // The default that makes a content site payable: /articles/2026/a is
    // refused, and the batch bought covers /articles/.
    const server = mockServer();
    const { agent } = await agentFor(server);
    await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`);

    const held = agent.aifp1Receipts.list();
    expect(held).toHaveLength(1);
    expect(held[0]!.scope).toBe("prefix");
    expect(held[0]!.resource).toBe("/articles/");
  });

  it("honours an explicit merchant-wide scope", async () => {
    const server = mockServer();
    const { agent } = await agentFor(server);
    await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`, {}, { scope: "merchant" });

    const held = agent.aifp1Receipts.list();
    expect(held[0]!.scope).toBe("merchant");
    expect(held[0]!.resource).toBe("*");

    // ...and it then covers a path in a completely different section.
    await agent.fetchPaid(`${GATEWAY}/acme/pricing/enterprise`);
    expect(server.quotes).toBe(1);
  });
});

// ── Reuse: the point of the whole design ──────────────────────────────────

describe("aifp1: receipt reuse", () => {
  it("reuses a held receipt instead of quoting again", async () => {
    const server = mockServer();
    const { agent, settlements } = await agentFor(server);

    await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`);
    await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/b`);
    await agent.fetchPaid(`${GATEWAY}/acme/articles/2027/c`);

    // One batch paid for all three pages — one quote, one settlement, one pay.
    expect(server.quotes).toBe(1);
    expect(server.pays).toBe(1);
    expect(settlements).toHaveLength(1);
    // And the later calls went straight out with the receipt attached: no
    // wasted 402 round-trip per page.
    expect(server.gatewayHits.map((h) => h.receipt !== null))
      .toEqual([false, true, true, true]);
  });

  it("tracks the gateway's own AIFP-Quota-Remaining rather than guessing", async () => {
    const server = mockServer();
    server.weights["/articles/2026/a"] = 7;
    const { agent } = await agentFor(server);

    await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`);
    // 1000 units bought, a weight-7 route consumed — the number comes from the
    // header the gateway set, not from arithmetic on our side.
    expect(agent.aifp1Receipts.list()[0]!.remaining).toBe(993);
  });

  it("buys a new batch once the old one is spent", async () => {
    const server = mockServer();
    // A heavy route: 1000 prepaid units cover exactly two calls.
    server.weights["/reports/q1"] = 500;
    server.weights["/reports/q2"] = 500;
    server.weights["/reports/q3"] = 500;
    const { agent, settlements } = await agentFor(server);

    await agent.fetchPaid(`${GATEWAY}/acme/reports/q1`);
    await agent.fetchPaid(`${GATEWAY}/acme/reports/q2`);
    expect(server.quotes).toBe(1);
    expect(agent.aifp1Receipts.list()[0]!.remaining).toBe(0);

    // Third call: the batch is spent, so a new one is bought — and the client
    // knows it locally, so it does not waste a 402 finding out.
    await agent.fetchPaid(`${GATEWAY}/acme/reports/q3`);
    expect(server.quotes).toBe(2);
    expect(server.pays).toBe(2);
    expect(settlements).toHaveLength(2);
    expect(settlements[0]!.orderId).not.toBe(settlements[1]!.orderId);
  });
});

// ── Coverage: never send a receipt that does not cover the request ────────

describe("aifp1: a receipt is not used where it does not reach", () => {
  it("does not spend an /articles/ batch on /pricing/", async () => {
    const server = mockServer();
    const { agent } = await agentFor(server);

    await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`);
    await agent.fetchPaid(`${GATEWAY}/acme/pricing/enterprise`);

    expect(server.quotes).toBe(2);
    // The /pricing request went out WITHOUT the /articles/ receipt — the
    // coverage test happened before the request, not after a 403.
    const pricingFirstHit = server.gatewayHits.find((h) => h.path === "/pricing/enterprise")!;
    expect(pricingFirstHit.receipt).toBeNull();
  });

  it("does not spend one merchant's batch at another merchant", async () => {
    const server = mockServer();
    const { agent } = await agentFor(server);

    await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`);
    await agent.fetchPaid(`${GATEWAY}/other/articles/2026/a`);

    expect(server.quotes).toBe(2);
    const otherHits = server.gatewayHits.filter((h) => h.receipt !== null);
    // Only the two paid retries carried a receipt; neither reached across.
    expect(otherHits).toHaveLength(2);
    const held = agent.aifp1Receipts.list();
    expect(new Set(held.map((h) => h.merchantId))).toEqual(new Set(["mrch_acme", "mrch_other"]));
  });

  it("refuses a cached entry whose merchant does not match", () => {
    // The cache is the last line before a bearer token leaves the process, so
    // the merchant check is asserted directly rather than only end-to-end.
    const cache = new Aifp1ReceiptCache();
    const entry: Aifp1CachedReceipt = {
      site: `${GATEWAY}/acme`, merchantId: "mrch_acme", receiptId: "rcpt_1",
      jwt: "jwt.1", scope: "merchant", resource: "*", unitQuota: 1000,
      remaining: 1000, expiresAt: Date.now() + 60_000, amountUsd: 0.1,
    };
    cache.put(entry);
    expect(cache.find(`${GATEWAY}/acme`, "/anything", "mrch_acme")).toBe(entry);
    expect(cache.find(`${GATEWAY}/acme`, "/anything", "mrch_other")).toBeUndefined();
    expect(cache.find(`${GATEWAY}/other`, "/anything")).toBeUndefined();
  });

  it("refuses an expired or exhausted entry", () => {
    const cache = new Aifp1ReceiptCache();
    const base: Aifp1CachedReceipt = {
      site: `${GATEWAY}/acme`, merchantId: "mrch_acme", receiptId: "rcpt_1",
      jwt: "jwt.1", scope: "prefix", resource: "/articles/", unitQuota: 1000,
      remaining: 1000, expiresAt: Date.now() + 60_000, amountUsd: 0.1,
    };
    cache.put({ ...base, receiptId: "spent", remaining: 0 });
    // Inside the expiry margin: still nominally valid, but not worth sending —
    // it would come back as "receipt expired", which looks like an exhausted
    // batch and would make us pay for a batch we already had.
    cache.put({ ...base, receiptId: "expiring", expiresAt: Date.now() + 2_000 });
    expect(cache.find(`${GATEWAY}/acme`, "/articles/x")).toBeUndefined();
  });
});

// ── Idempotency ───────────────────────────────────────────────────────────

describe("aifp1: idempotency key", () => {
  it("is stable for a retry of the same payment", () => {
    const p = { quoteId: "qt_0000000000000001", chain: "polygon", asset: "POL", txRef: "0xabc" };
    expect(idempotencyKeyFor(p)).toBe(idempotencyKeyFor({ ...p }));
  });

  it("differs whenever any part of the payment differs", () => {
    const p = { quoteId: "qt_0000000000000001", chain: "polygon", asset: "POL", txRef: "0xabc" };
    const key = idempotencyKeyFor(p);
    expect(idempotencyKeyFor({ ...p, quoteId: "qt_0000000000000002" })).not.toBe(key);
    expect(idempotencyKeyFor({ ...p, txRef: "0xdef" })).not.toBe(key);
    expect(idempotencyKeyFor({ ...p, asset: "USDC" })).not.toBe(key);
    expect(idempotencyKeyFor({ ...p, chain: "solana" })).not.toBe(key);
    expect(key.length).toBeLessThanOrEqual(200); // the server's hard limit
  });

  it("reuses one key across an AIFP-425 retry and settles only once", async () => {
    const server = mockServer();
    server.payNotConfirmedTimes = 2;   // chain lagging behind us
    const { agent, settlements } = await agentFor(server);

    const res = await agent.fetchPaid(
      `${GATEWAY}/acme/articles/2026/a`, {}, { settlementConfirmMs: 5_000 },
    );

    expect(res!.status).toBe(200);
    // Three /v1/pay attempts, ONE key — the server replays rather than issuing
    // a second receipt, and the money moved exactly once.
    expect(server.idempotencyKeys).toHaveLength(3);
    expect(new Set(server.idempotencyKeys).size).toBe(1);
    expect(settlements).toHaveLength(1);
  }, 20_000);

  it("uses a different key for a different batch", async () => {
    const server = mockServer();
    server.weights["/reports/q1"] = 1000;   // one call empties the batch
    server.weights["/reports/q2"] = 1000;
    const { agent } = await agentFor(server);

    await agent.fetchPaid(`${GATEWAY}/acme/reports/q1`);
    await agent.fetchPaid(`${GATEWAY}/acme/reports/q2`);

    expect(server.idempotencyKeys).toHaveLength(2);
    expect(server.idempotencyKeys[0]).not.toBe(server.idempotencyKeys[1]);
  });
});

// ── Budget caps and loud failures ─────────────────────────────────────────

describe("aifp1: budget caps and refusals", () => {
  it("refuses to settle a batch above the per-call cap", async () => {
    const server = mockServer();
    const { agent, settlements } = await agentFor(server, {
      budgetCaps: { per_call_usd: 0.05 },
    });

    await expect(agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`))
      .rejects.toBeInstanceOf(BudgetCapExceededError);
    // Quoted (free) but nothing signed — the cap is checked against the quote's
    // real USD total, before any transaction.
    expect(server.quotes).toBe(1);
    expect(settlements).toHaveLength(0);
    expect(server.pays).toBe(0);
  });

  it("returns null instead of throwing when the caller asked to skip", async () => {
    const server = mockServer();
    const { agent, settlements } = await agentFor(server, {
      budgetCaps: { per_call_usd: 0.05, on_limit_exceeded: "skip" },
    });
    expect(await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`)).toBeNull();
    expect(settlements).toHaveLength(0);
  });

  it("counts a settled batch against the 24h spend", async () => {
    const server = mockServer();
    const { agent } = await agentFor(server);
    await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`);
    expect(agent.getSpend24h()).toBeCloseTo(0.1, 6);
    // The second page rides the same batch — it is not a second payment.
    await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/b`);
    expect(agent.getSpend24h()).toBeCloseTo(0.1, 6);
  });

  it("surfaces a refused quote as Aifp1QuoteError with the server's own detail", async () => {
    const server = mockServer();
    const { agent, settlements } = await agentFor(server);
    // The real refusal this catches: a wide scope on a tier that is not
    // flat-rated (aifp/scope.js isFlatRated). Unguessable from the status.
    await expect(agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`, {}, { units: 10 }))
      .rejects.toBeInstanceOf(Aifp1QuoteError);
    await expect(agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`, {}, { units: 10 }))
      .rejects.toThrow(/units must be an integer/);
    expect(settlements).toHaveLength(0);
  });

  it("gives the daily reservation back when the settlement fails", async () => {
    // A tight cap: 0.15 covers one 0.10 batch, not two. If a failed
    // settlement kept its reservation, the retry below would be refused —
    // which is how a leaked reservation stops an agent paying at all.
    const server = mockServer();
    const { agent } = await agentFor(server, {
      budgetCaps: { daily_usd: 0.15 },
      spendLedger: new MemorySpendLedger(),
    });

    let failNext = true;
    (agent as unknown as { settleAifp1NativeV13: (p: Settlement) => Promise<string> })
      .settleAifp1NativeV13 = async () => {
        if (failNext) { failNext = false; throw new Error("polygon rpc unreachable"); }
        return "0x" + "cd".repeat(32);
      };

    await expect(agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`))
      .rejects.toThrow(/polygon rpc unreachable/);
    expect(agent.getSpend24h()).toBe(0);

    const res = await agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`);
    expect(res!.status).toBe(200);
    expect(agent.getSpend24h()).toBeCloseTo(0.1, 6);
  });

  it("names the merchant when a quote comes back for the wrong one", async () => {
    const server = mockServer();
    const base = server.fetch;
    server.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const r = await base(i, init);
      const u = new URL(typeof i === "string" ? i : i.toString());
      if (u.origin === API && u.pathname === "/v1/quote" && r.ok) {
        const q = await r.json();
        return json({ ...q, merchant_id: "mrch_somebody_else" });
      }
      return r;
    }) as typeof globalThis.fetch;

    const { agent, settlements } = await agentFor(server);
    await expect(agent.fetchPaid(`${GATEWAY}/acme/articles/2026/a`))
      .rejects.toThrow(/mrch_somebody_else/);
    expect(settlements).toHaveLength(0);
  });
});

// ── Pure helpers, ported from the server ──────────────────────────────────

describe("aifp1: scope + url helpers match the server", () => {
  it("prefix stops at a path boundary", () => {
    expect(scopeCovers("prefix", "/articles/", "/articles/2026/x")).toBe(true);
    expect(scopeCovers("prefix", "/articles", "/articles-internal")).toBe(false);
    expect(scopeCovers("prefix", "/articles", "/articles")).toBe(true);
    expect(scopeCovers("prefix", "/", "/anything/at/all")).toBe(true);
    expect(scopeCovers("merchant", "*", "/anything")).toBe(true);
    expect(scopeCovers("exact", "/a", "/a")).toBe(true);
    expect(scopeCovers("exact", "/a", "/a/b")).toBe(false);
    expect(scopeCovers(undefined, "/a", "/a/b")).toBe(false);   // unrecognised → exact
  });

  it("derives the same prefix hint the gateway suggests", () => {
    expect(prefixHint("/articles/2026/thing")).toBe("/articles/");
    expect(prefixHint("/thing")).toBe("/");
    expect(prefixHint("/")).toBe("/");
  });

  it("splits a gateway URL into slug and merchant-relative path", () => {
    expect(parseGatewayUrl(`${GATEWAY}/acme/articles/2026/x?q=1`)).toEqual({
      site: `${GATEWAY}/acme`, slug: "acme", restPath: "/articles/2026/x",
    });
    expect(parseGatewayUrl(`${GATEWAY}/acme`).restPath).toBe("/");
  });
});

// ── The five ways this client lost money in review ────────────────────────
//
// Each of these was found by an adversarial read of the first version, and
// each is the kind that does not announce itself: the client keeps working,
// and the wallet drains or a paid batch evaporates.

describe("aifp1: refusing to pay the wrong people", () => {
  it("will not settle against a host that is not a known gateway", async () => {
    // The worst of the set. A 402 is the answer to a request that carried no
    // credentials, so it is unauthenticated by construction — any site can
    // return {error:"AIFP-402", protocol:"AIFP-1", merchant_id:"mrch_theirs"}
    // and, before this check, the agent quoted, settled real POL to the
    // address in that quote, and handed over a receipt.
    const server = mockServer();
    const evil = "https://totally-not-our-gateway.example";
    const base = server.fetch;
    server.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const u = new URL(typeof i === "string" ? i : i.toString());
      if (u.origin === evil) {
        return json({
          error: "AIFP-402", protocol: "AIFP-1",
          merchant_id: "mrch_attacker", resource: "/x", unit_weight: 1,
        }, 402);
      }
      return base(i, init);
    }) as typeof globalThis.fetch;

    const { agent, settlements } = await agentFor(server);
    await expect(agent.fetchPaid(`${evil}/acme/x`)).rejects.toThrow(/not a known AiFinPay gateway/i);
    expect(settlements.length).toBe(0);
    expect(server.quotes).toBe(0);
  });

  it("an empty origin list refuses everything rather than allowing everything", () => {
    // A config bug that produces [] must fail closed. "No allowlist" reading
    // as "allow all" is how this class of check is usually defeated.
    expect(() => parseGatewayUrl(`${GATEWAY}/acme/x`, [])).toThrow(/refusing to pay any host/i);
  });
});

describe("aifp1: keeping a batch that is still good", () => {
  it("does not throw away a receipt when the merchant's own origin says 403", async () => {
    // routes/gateway.js proxies the upstream status verbatim, so hotlink
    // protection or an expired key on the merchant's side arrives here as a
    // 403 with THEIR body. Treating it as "the gateway refused our receipt"
    // evicted a paid batch and settled another one on the next call.
    const server = mockServer();
    const { agent, settlements } = await agentFor(server);

    await agent.fetchPaid(`${GATEWAY}/acme/articles/one`);
    expect(settlements.length).toBe(1);

    server.upstream403Path = "/articles/forbidden";
    const res = await agent.fetchPaid(`${GATEWAY}/acme/articles/forbidden`);
    expect(res!.status).toBe(403);
    // The batch survived: the next covered call still spends it, no new tx.
    server.upstream403Path = null;
    await agent.fetchPaid(`${GATEWAY}/acme/articles/two`);
    expect(settlements.length).toBe(1);
  });

  it("caches a settled receipt even when the response carries an unusable expiry", async () => {
    // This was guarded on a finite expiresAt, so an unparseable expires_at
    // binned a batch that had just been paid for on-chain — the JWT existed
    // nowhere else and the next call settled another one.
    const server = mockServer();
    server.expiresAtOverride = "not-a-date";
    const { agent, settlements } = await agentFor(server);

    await agent.fetchPaid(`${GATEWAY}/acme/articles/one`);
    await agent.fetchPaid(`${GATEWAY}/acme/articles/two`);
    expect(settlements.length).toBe(1);
  });
});

describe("aifp1: concurrency", () => {
  it("ten workers arriving together buy one batch, not ten", async () => {
    // The cache is empty between deciding to buy and the receipt arriving, so
    // every concurrent caller missed and every one settled. It recurred at
    // each quota boundary, so more traffic meant proportionally more overpay.
    const server = mockServer();
    const { agent, settlements } = await agentFor(server);

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, i) => agent.fetchPaid(`${GATEWAY}/acme/articles/${i}`)),
    );

    expect(results.every((r) => r!.status === 200)).toBe(true);
    expect(settlements.length).toBe(1);
    expect(server.quotes).toBe(1);
  });
});

describe("aifp1: request shape", () => {
  it("keeps caller headers given as a Headers instance", async () => {
    // RequestInit.headers is legally a Headers or an array of pairs, and the
    // first version spread it into an object literal — which yields {} for a
    // Headers, silently dropping every header the caller set, including their
    // own upstream auth.
    const server = mockServer();
    const seen: string[] = [];
    const base = server.fetch;
    server.fetch = (async (i: RequestInfo | URL, init?: RequestInit) => {
      const h = new Headers(init?.headers);
      const v = h.get("x-caller-token");
      if (v) seen.push(v);
      return base(i, init);
    }) as typeof globalThis.fetch;

    const { agent } = await agentFor(server);
    await agent.fetchPaid(`${GATEWAY}/acme/articles/one`, {
      headers: new Headers({ "x-caller-token": "kept" }),
    });
    expect(seen).toContain("kept");
  });
});

describe("aifp1: the caps must bound what the wallet actually pays", () => {
  it("refuses a quote whose wei debit does not match the USD it declares", async () => {
    // The budget caps were checked against quote.amount in USD while the
    // wallet was debited native_settlement.total_wei, with nothing tying them
    // together — so a quote could clear a ten-cent cap and spend any amount of
    // POL, and the client had no reason to notice because it never converted
    // one into the other.
    const server = mockServer();
    server.inflateWeiBy = 50;                     // same USD, fifty times the POL
    const { agent, settlements } = await agentFor(server);

    await expect(agent.fetchPaid(`${GATEWAY}/acme/articles/one`))
      .rejects.toThrow(/refusing to sign a payment the budget caps did not see/i);
    expect(settlements.length).toBe(0);
  });

  it("allows the rounding a fee-inclusive split actually produces", async () => {
    // The check must not be so tight that an honest quote fails: the splitter
    // floors each leg and the rate is printed to six places.
    const server = mockServer();
    server.inflateWeiBy = 1.005;
    const { agent, settlements } = await agentFor(server);
    const res = await agent.fetchPaid(`${GATEWAY}/acme/articles/one`);
    expect(res!.status).toBe(200);
    expect(settlements.length).toBe(1);
  });
});

describe("aifp1: a default batch is an amount of money, not a unit count", () => {
  it("buys ~$0.10 at the current base price", () => {
    // 1000 units was correct at $0.0001 and became $0.50 when the tiers were
    // re-priced to $0.0005 on 2026-08-07 — five times the money, with the
    // comment beside it still claiming ten cents. The count is derived now, so
    // the next re-price cannot repeat it.
    expect(defaultUnitsFor({ base_unit_price_usd: "0.0005" })).toBe(200);
    expect(defaultUnitsFor({ base_unit_price_usd: "0.0001" })).toBe(1000);
    expect(defaultUnitsFor({ base_unit_price_usd: "0.001" })).toBe(100);
  });

  it("the derived batch is worth about a dime whatever the base price", () => {
    for (const base of ["0.0001", "0.0005", "0.002", "0.01"]) {
      const usd = defaultUnitsFor({ base_unit_price_usd: base }) * Number(base);
      expect(usd).toBeGreaterThanOrEqual(0.1);
      expect(usd).toBeLessThan(0.2);
    }
  });

  it("falls back rather than dividing by a missing or absurd price", () => {
    // A 402 that omits the price, or states one we cannot use, must not produce
    // Infinity units and a quote for the agent's whole balance.
    for (const bad of [undefined, "", "0", "-1", "not-a-number"]) {
      const n = defaultUnitsFor({ base_unit_price_usd: bad as string });
      expect(Number.isFinite(n)).toBe(true);
      expect(n).toBe(200);
    }
  });
});
