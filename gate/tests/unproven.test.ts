// Unproven pays: the reader cookie, verified search bots and the predicate built from them.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  createGate,
  createReaderProof,
  MemoryStore,
  SEARCH_BOT_CACHE_MAX,
  unprovenPays,
  verifySearchBot,
  type DnsResolver,
  type GateRequest,
} from "../src/index.js";
import { ISSUER, MERCHANT, issuer, signReceipt } from "./helpers.js";

const vectors = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../conformance/vectors/reader-proof-v1.json"),
    "utf8"
  )
);

const KEY = "reader-key-0123456789abcdef0123456789";
const CHROME =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";
const GOOGLEBOT = "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)";
const BINGBOT = "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)";
const GOOGLE_IP = "66.249.66.1";
const GOOGLE_NAME = "crawl-66-249-66-1.googlebot.com";

describe("reader proof — shared vectors", () => {
  for (const v of vectors.issue) {
    it(v.name, () => {
      const proof = createReaderProof({ key: v.key, ttlSeconds: vectors.ttl_seconds });
      expect(proof.issue(v.user_agent, v.now)).toBe(v.cookie);
    });
  }
  for (const v of vectors.verify) {
    it(v.name, () => {
      const proof = createReaderProof({ key: v.key });
      expect(proof.verify(v.cookie_header, v.user_agent, v.now)).toBe(v.valid);
    });
  }
  it("has the cookie name and Set-Cookie attributes of the spec", () => {
    const proof = createReaderProof({ key: KEY });
    expect(proof.cookieName).toBe(vectors.cookie);
    expect(proof.setCookie("1.x")).toBe(vectors.set_cookie.replace("<value>", "1.x"));
  });
});

describe("reader proof — direct", () => {
  const proof = createReaderProof({ key: KEY });
  const now = 1_800_000_000;

  it("an issued cookie verifies for its own User-Agent until it expires", () => {
    const value = proof.issue(CHROME, now);
    expect(proof.verify(`__aifp_human=${value}`, CHROME, now + 1)).toBe(true);
    expect(proof.verify(`__aifp_human=${value}`, CHROME, now + 2592000)).toBe(false);
    expect(proof.verify(`__aifp_human=${value}`, CHROME, now + 2592001)).toBe(false);
  });
  it("a cookie is bound to the User-Agent", () => {
    const value = proof.issue(CHROME, now);
    expect(proof.verify(`__aifp_human=${value}`, GOOGLEBOT, now + 1)).toBe(false);
    expect(proof.verify(`__aifp_human=${value}`, undefined, now + 1)).toBe(false);
  });
  it("a missing User-Agent signs as the empty string", () => {
    const value = proof.issue(undefined, now);
    expect(proof.verify(`__aifp_human=${value}`, "", now + 1)).toBe(true);
  });
  it("refuses a short key", () => {
    expect(() => createReaderProof({ key: "short" })).toThrow(TypeError);
  });
  it("a cookie from another key does not verify", () => {
    const other = createReaderProof({ key: KEY + "x" }).issue(CHROME, now);
    expect(proof.verify(`__aifp_human=${other}`, CHROME, now + 1)).toBe(false);
  });
});

type Zone = { ptr?: Record<string, string[]>; a?: Record<string, string[]>; aaaa?: Record<string, string[]> };
function fakeDns(zone: Zone, calls = { n: 0 }): DnsResolver {
  const answer = (table: Record<string, string[]> | undefined, key: string) => {
    calls.n++;
    const hit = table?.[key];
    if (!hit) return Promise.reject(Object.assign(new Error("ENOTFOUND"), { code: "ENOTFOUND" }));
    return Promise.resolve(hit);
  };
  return {
    reverse: (ip) => answer(zone.ptr, ip),
    resolve4: (name) => answer(zone.a, name),
    resolve6: (name) => answer(zone.aaaa, name),
  };
}
const googleZone: Zone = { ptr: { [GOOGLE_IP]: [GOOGLE_NAME] }, a: { [GOOGLE_NAME]: [GOOGLE_IP] } };

describe("verifySearchBot — forward-confirmed reverse DNS", () => {
  it("a real Googlebot is search", async () => {
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: GOOGLE_IP, resolve: fakeDns(googleZone) })).toBe("search");
  });
  it("a PTR outside the operator's domain is not", async () => {
    const dns = fakeDns({ ptr: { "1.2.3.4": ["host.example.com"] }, a: { "host.example.com": ["1.2.3.4"] } });
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: "1.2.3.4", resolve: dns })).toBeNull();
  });
  it("a PTR the forward lookup does not confirm is not", async () => {
    const dns = fakeDns({ ptr: { "1.2.3.4": [GOOGLE_NAME] }, a: { [GOOGLE_NAME]: [GOOGLE_IP] } });
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: "1.2.3.4", resolve: dns })).toBeNull();
  });
  it("a look-alike suffix is not", async () => {
    const name = "crawl.evilgooglebot.com";
    const dns = fakeDns({ ptr: { "1.2.3.4": [name] }, a: { [name]: ["1.2.3.4"] } });
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: "1.2.3.4", resolve: dns })).toBeNull();
  });
  it("a Google name for a crawler that claims Bing is not", async () => {
    expect(await verifySearchBot({ userAgent: BINGBOT, ip: GOOGLE_IP, resolve: fakeDns(googleZone) })).toBeNull();
  });
  it("a User-Agent that names no search operator is not looked up", async () => {
    const calls = { n: 0 };
    expect(await verifySearchBot({ userAgent: CHROME, ip: GOOGLE_IP, resolve: fakeDns(googleZone, calls) })).toBeNull();
    expect(
      await verifySearchBot({ userAgent: "GPTBot/1.2 Googlebot", ip: GOOGLE_IP, resolve: fakeDns(googleZone, calls) })
    ).toBeNull();
    expect(calls.n).toBe(0);
  });
  it("a resolver that throws is not free", async () => {
    const dns: DnsResolver = {
      reverse: () => Promise.reject(new Error("SERVFAIL")),
      resolve4: () => Promise.resolve([GOOGLE_IP]),
      resolve6: () => Promise.resolve([]),
    };
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: GOOGLE_IP, resolve: dns })).toBeNull();
  });
  it("a forward lookup that throws is not free", async () => {
    const dns: DnsResolver = {
      reverse: () => Promise.resolve([GOOGLE_NAME]),
      resolve4: () => Promise.reject(new Error("SERVFAIL")),
      resolve6: () => Promise.resolve([]),
    };
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: GOOGLE_IP, resolve: dns })).toBeNull();
  });
  it("a resolver that hangs times out as not free", async () => {
    const dns: DnsResolver = {
      reverse: () => new Promise(() => {}),
      resolve4: () => new Promise(() => {}),
      resolve6: () => new Promise(() => {}),
    };
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: GOOGLE_IP, resolve: dns, timeoutMs: 20 })).toBeNull();
  });
  it("IPv6 is confirmed against AAAA, in any spelling", async () => {
    const ip = "2001:4860:4801:10::1";
    const name = "crawl-2001-4860-4801-10--1.googlebot.com";
    const dns = fakeDns({ ptr: { [ip]: [name + "."] }, aaaa: { [name]: ["2001:4860:4801:0010:0000:0000:0000:0001"] } });
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: "2001:4860:4801:10:0:0:0:1", resolve: dns })).toBe(
      "search"
    );
  });
  it("an IPv4-mapped IPv6 address is checked as IPv4", async () => {
    expect(
      await verifySearchBot({ userAgent: GOOGLEBOT, ip: `::ffff:${GOOGLE_IP}`, resolve: fakeDns(googleZone) })
    ).toBe("search");
  });
  it("a value that is not an address is not looked up", async () => {
    expect(
      await verifySearchBot({ userAgent: GOOGLEBOT, ip: "crawl.googlebot.com", resolve: fakeDns(googleZone) })
    ).toBeNull();
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: undefined, resolve: fakeDns(googleZone) })).toBeNull();
  });
});

describe("verifySearchBot — cache", () => {
  it("keeps a verified answer 24 h and a refusal 1 h, by the injected clock", async () => {
    const calls = { n: 0 };
    const dns = fakeDns(googleZone, calls);
    const t0 = 1_800_000_000;
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: GOOGLE_IP, resolve: dns, now: t0 })).toBe("search");
    const afterFirst = calls.n;
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: GOOGLE_IP, resolve: dns, now: t0 + 86399 })).toBe(
      "search"
    );
    expect(calls.n).toBe(afterFirst);
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: GOOGLE_IP, resolve: dns, now: t0 + 86400 })).toBe(
      "search"
    );
    expect(calls.n).toBeGreaterThan(afterFirst);

    const zone: Zone = { ptr: { "1.2.3.4": ["host.example.com"] } };
    const negCalls = { n: 0 };
    const neg = fakeDns(zone, negCalls);
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: "1.2.3.4", resolve: neg, now: t0 })).toBeNull();
    zone.ptr!["1.2.3.4"] = [GOOGLE_NAME];
    zone.a = { [GOOGLE_NAME]: ["1.2.3.4"] };
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: "1.2.3.4", resolve: neg, now: t0 + 3599 })).toBeNull();
    expect(negCalls.n).toBe(1);
    expect(await verifySearchBot({ userAgent: GOOGLEBOT, ip: "1.2.3.4", resolve: neg, now: t0 + 3600 })).toBe("search");
  });
  it("is bounded", async () => {
    const calls = { n: 0 };
    const dns = fakeDns({}, calls);
    const ip = (i: number) => `10.${(i >> 16) & 255}.${(i >> 8) & 255}.${i & 255}`;
    for (let i = 0; i <= SEARCH_BOT_CACHE_MAX; i++)
      await verifySearchBot({ userAgent: GOOGLEBOT, ip: ip(i), resolve: dns, now: 1 });
    const before = calls.n;
    await verifySearchBot({ userAgent: GOOGLEBOT, ip: ip(SEARCH_BOT_CACHE_MAX), resolve: dns, now: 1 });
    expect(calls.n).toBe(before);
    await verifySearchBot({ userAgent: GOOGLEBOT, ip: ip(0), resolve: dns, now: 1 });
    expect(calls.n).toBe(before + 1);
  });
});

describe("unprovenPays — the predicate", () => {
  const proof = createReaderProof({ key: KEY });
  const cookie = () => `__aifp_human=${proof.issue(CHROME)}`;
  const bot = async ({ userAgent, ip }: { userAgent: string; ip: string }) =>
    verifySearchBot({ userAgent, ip, resolve: fakeDns(googleZone) });
  const r = (headers: Record<string, string>, ip?: string): GateRequest => {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    return { path: "/articles", header: (n) => lower[n.toLowerCase()], ip };
  };
  const charge = unprovenPays({ readerProof: proof, verifySearchBot: bot });
  const table: [string, GateRequest, boolean][] = [
    ["reader with a valid cookie", r({ "User-Agent": CHROME, Cookie: cookie() }), false],
    ["browser without a cookie", r({ "User-Agent": CHROME }), true],
    ["reader cookie under another User-Agent", r({ "User-Agent": GOOGLEBOT, Cookie: cookie() }), true],
    ["verified Googlebot", r({ "User-Agent": GOOGLEBOT }, GOOGLE_IP), false],
    ["Googlebot User-Agent from another address", r({ "User-Agent": GOOGLEBOT }, "1.2.3.4"), true],
    ["Googlebot without a client address", r({ "User-Agent": GOOGLEBOT }), true],
    [
      "reader cookie with an AIFP-Agent-Id",
      r({ "User-Agent": CHROME, Cookie: cookie(), "AIFP-Agent-Id": "0x" + "0".repeat(40) }),
      true,
    ],
    [
      "verified Googlebot with an AIFP-Receipt",
      r({ "User-Agent": GOOGLEBOT, "AIFP-Receipt": "x.y.z" }, GOOGLE_IP),
      true,
    ],
    ["AI crawler", r({ "User-Agent": "GPTBot/1.2" }, GOOGLE_IP), true],
    ["no User-Agent", r({}), true],
  ];
  for (const [name, request, expected] of table) {
    it(`${name} → ${expected ? "pays" : "free"}`, async () => {
      expect(await charge(request)).toBe(expected);
    });
  }
  it("a verified bot outside freeBots pays", async () => {
    const onlyPreview = unprovenPays({ readerProof: proof, verifySearchBot: bot, freeBots: ["preview"] });
    expect(await onlyPreview(r({ "User-Agent": GOOGLEBOT }, GOOGLE_IP))).toBe(true);
  });
  it("a bot verifier that throws charges", async () => {
    const broken = unprovenPays({
      readerProof: proof,
      verifySearchBot: () => {
        throw new Error("down");
      },
    });
    expect(await broken(r({ "User-Agent": GOOGLEBOT }, GOOGLE_IP))).toBe(true);
  });
  it("needs a reader proof", () => {
    expect(() => unprovenPays({} as never)).toThrow(TypeError);
  });

  it("in a gate: a reader is served exempt, a stranger gets the 402, a receipt is metered", async () => {
    const iss = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/articles",
      tier: "standard",
      issuer: ISSUER,
      jwks: iss.jwks,
      store: new MemoryStore(),
      shouldCharge: charge,
    });
    const reader = await gate(r({ "User-Agent": CHROME, Cookie: cookie() }));
    expect(reader.ok && reader.aifp.mode).toBe("exempt");
    const stranger = await gate(r({ "User-Agent": CHROME }));
    expect(stranger.status).toBe(402);
    const token = await signReceipt(iss.privateKey, { resource: "/articles", unit_quota: 2 });
    const paid = await gate(r({ "User-Agent": CHROME, Cookie: cookie(), "AIFP-Receipt": token }));
    expect(paid.ok && paid.aifp.mode).not.toBe("exempt");
    expect(paid.status).toBe(200);
  });
});
