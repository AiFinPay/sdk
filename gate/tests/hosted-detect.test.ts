// ──────────────────────────────────────────────────────────────────────────
// hostedDetect: the gate asks AiFinPay who pays, and fails free.
//
// The failure that matters is our outage: every reader of every merchant
// would meet a 402 at once. So every way the call can go wrong — network
// error, timeout, a non-200, a body that is not an answer — serves the
// request free, and none of those is cached.
// ──────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import { createGate, hostedDetect, MemoryStore } from "../src/index.js";
import type { GateRequest } from "../src/index.js";
import { ISSUER, MERCHANT, issuer } from "./helpers.js";

const MERCHANT_ID = "mrch_0123456789abcdef";
const SECRET = "s".repeat(40);
const CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

function visitor(
  headers: Record<string, string> = {},
  ip: string | null = "203.0.113.7",
  path = "/articles/1"
): GateRequest {
  const lower = new Map(Object.entries({ "user-agent": CHROME, ...headers }).map(([k, v]) => [k.toLowerCase(), v]));
  return { path, ip: ip ?? undefined, header: (name) => lower.get(name.toLowerCase()) };
}

function service(answer: (body: any) => Response | Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit; body: any }> = [];
  const fetch = (async (url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    calls.push({ url, init, body });
    return answer(body);
  }) as unknown as typeof globalThis.fetch;
  return { calls, fetch };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });

describe("hostedDetect — what the gate sends", () => {
  it("the address, User-Agent, path without query and only the listed headers", async () => {
    const { calls, fetch } = service(() => json({ charge: true, cache_ttl_s: 60 }));
    const detect = hostedDetect({ merchantId: MERCHANT_ID, merchantSecret: SECRET, fetch });
    await detect(
      visitor(
        { "accept-language": "en", cookie: "session=1", authorization: "Bearer x", "sec-ch-ua": '"Chromium"' },
        "203.0.113.7",
        "/articles/1?token=t#f"
      )
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`https://api.aifinpay.io/v1/merchants/${MERCHANT_ID}/detect`);
    expect((calls[0].init.headers as Record<string, string>)["AIFP-Merchant-Secret"]).toBe(SECRET);
    expect(calls[0].body).toEqual({
      v: 1,
      ip: "203.0.113.7",
      ua: CHROME,
      path: "/articles/1",
      headers: { "accept-language": "en", "sec-ch-ua": '"Chromium"' },
      aifp: { receipt: false, agent_id: false },
    });
  });

  it("forwards the Cloudflare Worker's AIFP-Edge-Signal untouched", async () => {
    const { calls, fetch } = service(() => json({ charge: false, cache_ttl_s: 60 }));
    const detect = hostedDetect({ merchantId: MERCHANT_ID, merchantSecret: SECRET, fetch });
    const signal = "v=1;ts=1760000000;vb=0;cat=;score=95;sig=" + "a".repeat(43);
    await detect(visitor({ "AIFP-Edge-Signal": signal }));
    expect(calls[0].body.headers["aifp-edge-signal"]).toBe(signal);
  });

  it("a request speaking AIFP is charged without a call, so its receipt is metered", async () => {
    const { calls, fetch } = service(() => json({ charge: false, cache_ttl_s: 60 }));
    const detect = hostedDetect({ merchantId: MERCHANT_ID, merchantSecret: SECRET, fetch });
    expect(await detect(visitor({ "AIFP-Agent-Id": "0xabc" }))).toBe(true);
    expect(await detect(visitor({ "AIFP-Receipt": "x.y.z" }))).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

describe("hostedDetect — the answer", () => {
  it("follows the service, and reuses it for cache_ttl_s", async () => {
    let t = 1_000_000;
    const { calls, fetch } = service(() => json({ charge: true, cache_ttl_s: 30 }));
    const detect = hostedDetect({ merchantId: MERCHANT_ID, merchantSecret: SECRET, fetch, now: () => t });
    expect(await detect(visitor())).toBe(true);
    t += 29_000;
    expect(await detect(visitor())).toBe(true);
    expect(calls).toHaveLength(1);
    t += 2_000;
    await detect(visitor());
    expect(calls).toHaveLength(2);
  });

  it("caches per address and User-Agent, and not at all for cache_ttl_s 0", async () => {
    const { calls, fetch } = service((body) => json({ charge: body.ip === "198.51.100.1", cache_ttl_s: 0 }));
    const detect = hostedDetect({ merchantId: MERCHANT_ID, merchantSecret: SECRET, fetch });
    expect(await detect(visitor({}, "198.51.100.1"))).toBe(true);
    expect(await detect(visitor({}, "198.51.100.2"))).toBe(false);
    await detect(visitor({}, "198.51.100.1"));
    expect(calls).toHaveLength(3);
  });
});

describe("hostedDetect — fails free", () => {
  const failures: Array<[string, () => Response | Promise<Response>]> = [
    ["a 503", () => json({ error: "AIFP-503" }, 503)],
    ["a 429", () => json({ error: "AIFP-429" }, 429)],
    ["a 403 (wrong secret)", () => json({ error: "AIFP-403" }, 403)],
    ["a 200 that is not an answer", () => json({ charge: "yes" })],
    ["a body that is not JSON", () => new Response("<html>", { status: 200 })],
    [
      "a network error",
      () => {
        throw new TypeError("fetch failed");
      },
    ],
  ];
  for (const [name, answer] of failures) {
    it(`${name}: served free and not cached`, async () => {
      const { calls, fetch } = service(answer);
      const detect = hostedDetect({ merchantId: MERCHANT_ID, merchantSecret: SECRET, fetch });
      expect(await detect(visitor())).toBe(false);
      await detect(visitor());
      expect(calls).toHaveLength(2);
    });
  }

  it("a slow service: served free after timeoutMs", async () => {
    const fetch = ((_url: string, init: RequestInit) =>
      new Promise((_, reject) =>
        init.signal?.addEventListener("abort", () => reject(init.signal?.reason))
      )) as typeof globalThis.fetch;
    const detect = hostedDetect({ merchantId: MERCHANT_ID, merchantSecret: SECRET, fetch, timeoutMs: 20 });
    const started = Date.now();
    expect(await detect(visitor())).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });

  it("no client address: served free without a call", async () => {
    const { calls, fetch } = service(() => json({ charge: true, cache_ttl_s: 60 }));
    const detect = hostedDetect({ merchantId: MERCHANT_ID, merchantSecret: SECRET, fetch });
    expect(await detect(visitor({}, null))).toBe(false);
    expect(calls).toHaveLength(0);
  });
});

describe("hostedDetect — setup", () => {
  it("refuses a bad merchant id, a missing secret and a non-HTTPS apiBase", () => {
    expect(() => hostedDetect({ merchantId: "bad", merchantSecret: SECRET })).toThrow(/merchantId/);
    expect(() => hostedDetect({ merchantId: MERCHANT_ID, merchantSecret: "" })).toThrow(/merchantSecret/);
    for (const apiBase of ["http://api.aifinpay.io", "https://api.aifinpay.io/v1", "https://u:p@api.aifinpay.io"])
      expect(() => hostedDetect({ merchantId: MERCHANT_ID, merchantSecret: SECRET, apiBase })).toThrow(/apiBase/);
  });
});

describe("hostedDetect inside the gate", () => {
  it("the service's charge is a 402, its reader a page", async () => {
    const { fetch } = service((body) => json({ charge: body.ua.startsWith("curl/"), cache_ttl_s: 60 }));
    const iss = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/articles/1",
      tier: "standard",
      issuer: ISSUER,
      jwks: iss.jwks,
      store: new MemoryStore(),
      shouldCharge: hostedDetect({ merchantId: MERCHANT_ID, merchantSecret: SECRET, fetch }),
    });
    const scripted = await gate(visitor({ "user-agent": "curl/8.5.0" }));
    expect(scripted.ok).toBe(false);
    if (!scripted.ok) expect(scripted.status).toBe(402);
    expect((await gate(visitor())).ok).toBe(true);
  });
});
