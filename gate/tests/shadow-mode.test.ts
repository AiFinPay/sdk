// ──────────────────────────────────────────────────────────────────────────
// Shadow mode — the same decision, the same event, a 200 instead of a refusal.
//
// Two things must hold or the mode is worthless. First, a site in shadow sees
// in its dashboard exactly what it would see in enforce: the event stream is
// identical, request for request, including who asked. Second, a site that
// never set `mode` keeps the paywall it has: nothing in this change flips a
// live 402 into a pass-through.
// ──────────────────────────────────────────────────────────────────────────
import * as jose from "jose";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import type { Server } from "node:http";
import {
  HEADER_MODE,
  HEADER_SHADOW_STATUS,
  HEADER_QUOTA_REMAINING,
  aifpGate,
  createGate,
  createGateReporter,
  knownAiAgent,
  MemoryStore,
} from "../src/index.js";
import type { GateEvent, GateOptions, GateResult, GateStore } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req, signReceipt } from "./helpers.js";

const GPTBOT_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Safari/605.1.15";

async function gateWith(overrides: Partial<GateOptions> = {}) {
  const iss = await issuer();
  const events: GateEvent[] = [];
  const gate = createGate({
    merchantId: MERCHANT,
    resource: "/api/search",
    issuer: ISSUER,
    jwks: iss.jwks,
    store: new MemoryStore(),
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { gate, iss, events };
}

describe("a config without `mode` is enforce — nothing flips a live paywall", () => {
  it("still answers 402 and 403, with no AIFP-Mode header, exactly as before", async () => {
    for (const mode of [undefined, "enforce" as const]) {
      const { gate, iss, events } = await gateWith(mode ? { mode } : {});
      const noReceipt = await gate(req("/api/search", { "User-Agent": GPTBOT_UA }));
      expect(noReceipt.status).toBe(402);
      expect(noReceipt.ok).toBe(false);
      expect(noReceipt.headers).toEqual({ "Content-Type": "application/json" });

      const bad = await gate(req("/api/search", { "AIFP-Receipt": await iss.sign({ resource: "/elsewhere" }) }));
      expect(bad.status).toBe(403);
      expect(bad.headers).toEqual({ "Content-Type": "application/json" });

      const paid = await gate(req("/api/search", { "AIFP-Receipt": await iss.sign({ unit_quota: 5 }) }));
      expect(paid.status).toBe(200);
      expect(Object.keys(paid.headers)).toEqual([HEADER_QUOTA_REMAINING]);
      expect(events.map((e) => e.kind)).toEqual(["402", "403", "serve"]);
    }
  });

  it("refuses a mode it does not know rather than guessing", () => {
    for (const mode of ["Shadow", "observe", "off", "", 1, true]) {
      expect(() => createGate({ merchantId: MERCHANT, resource: "/x", mode: mode as never })).toThrow(/mode must be/);
    }
  });
});

describe("shadow never refuses", () => {
  it("serves a would-be 402, says so in the headers, and hands the handler the refusal", async () => {
    const { gate, events } = await gateWith({ mode: "shadow" });
    const r = await gate(req("/api/search", { "User-Agent": GPTBOT_UA }));
    expect(r.ok).toBe(true);
    expect(r.status).toBe(200);
    expect(r.headers).toEqual({ [HEADER_MODE]: "shadow", [HEADER_SHADOW_STATUS]: "402" });
    if (!r.ok) throw new Error("unreachable");
    expect(r.aifp).toEqual({
      agent: null,
      receipt_id: "",
      resource: "/api/search",
      weight: 0,
      unit_quota: 0,
      used: 0,
      remaining: 0,
      mode: "shadow",
      shadow: {
        status: 402,
        error: "AIFP-402",
        detail: "Payment Required — prepay a batch of requests and retry with the AIFP-Receipt header",
        weight: 1,
      },
    });
    expect(events).toEqual([
      {
        kind: "402",
        resource: "/api/search",
        weight: 1,
        detail: undefined,
        operator: "openai",
        ua_class: "ai_crawler",
        verified: false,
      },
    ]);
  });

  it("serves a would-be 403 and a would-be 503, each with its status in AIFP-Shadow-Status", async () => {
    const { gate, iss } = await gateWith({ mode: "shadow" });
    const forged = await gate(req("/api/search", { "AIFP-Receipt": await iss.sign({ resource: "/elsewhere" }) }));
    expect([forged.ok, forged.status, forged.headers[HEADER_SHADOW_STATUS]]).toEqual([true, 200, "403"]);
    expect(forged.ok && forged.aifp.shadow).toMatchObject({ status: 403, error: "AIFP-403", weight: 1 });

    const failing = { incrBy: async () => Promise.reject(new Error("store down")) } as unknown as GateStore;
    const { gate: broken } = await gateWith({ mode: "shadow", store: failing });
    const down = await broken(req("/api/search", { "AIFP-Receipt": await iss.sign({ unit_quota: 5 }) }));
    expect([down.ok, down.status, down.headers[HEADER_SHADOW_STATUS]]).toEqual([true, 200, "503"]);
    expect(down.ok && down.aifp.shadow).toMatchObject({ status: 503, error: "AIFP-503-METER" });
    expect(down.headers).not.toHaveProperty("Retry-After");

    const { gate: unpriced, events } = await gateWith({
      mode: "shadow",
      resource: undefined,
      registry: { neverLoaded: true, match: () => null } as never,
    });
    const nopricing = await unpriced(req("/api/anything"));
    expect([nopricing.ok, nopricing.status, nopricing.headers[HEADER_SHADOW_STATUS]]).toEqual([true, 200, "503"]);
    expect(nopricing.ok && nopricing.aifp).toMatchObject({ resource: "/api/anything", mode: "shadow" });
    expect(events.map((e) => e.kind)).toEqual(["pricing_unavailable"]);
  });

  it("serves what enforce would serve exactly as enforce does, plus the mode header", async () => {
    const { gate, iss } = await gateWith({ mode: "shadow", shouldCharge: knownAiAgent });
    const paid = await gate(req("/api/search", { "AIFP-Receipt": await iss.sign({ unit_quota: 5 }) }));
    expect(paid.headers).toEqual({ [HEADER_QUOTA_REMAINING]: "4", [HEADER_MODE]: "shadow" });
    expect(paid.ok && paid.aifp).toMatchObject({ mode: "paid", used: 1, remaining: 4 });

    const human = await gate(req("/api/search", { "User-Agent": BROWSER_UA }));
    expect(human.headers).toEqual({ "AIFP-Paywall": "exempt", [HEADER_MODE]: "shadow" });
    expect(human.ok && human.aifp.mode).toBe("exempt");

    const { gate: open } = await gateWith({
      mode: "shadow",
      resource: undefined,
      registry: {
        neverLoaded: false,
        match: () => ({ route_pattern: "/free", paywall_enabled: false, tier: null, unit_weight: null }),
      } as never,
    });
    const free = await open(req("/free"));
    expect(free.headers).toEqual({ "AIFP-Paywall": "off", [HEADER_MODE]: "shadow" });
    expect(free.ok && free.aifp.mode).toBe("open");
  });

  it("a shadow pass-through is not a paid admission for reporting v2", async () => {
    const iss = await issuer();
    const observe: unknown[] = [];
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwks: iss.jwks,
      store: new MemoryStore(),
      mode: "shadow",
      reporting: { version: 2, reporter: { version: 2, observe: (e: unknown) => observe.push(e) } as never },
    });
    const r = await gate(req("/api/search", { "User-Agent": GPTBOT_UA }));
    expect(r.ok).toBe(true);
    expect(r.reportingResource).toBeUndefined();
  });
});

describe("shadow and enforce emit the identical event stream", () => {
  // The same script of requests runs through both gates, built from the same
  // issuer key and the same receipts. Events must be deep-equal; only the
  // responses differ.
  async function script(mode: "shadow" | "enforce") {
    const iss = await issuer();
    const events: GateEvent[] = [];
    const failing = { incrBy: async () => Promise.reject(new Error("store down")) } as unknown as GateStore;
    const base = {
      merchantId: MERCHANT,
      issuer: ISSUER,
      jwks: iss.jwks,
      mode,
      onEvent: (e: GateEvent) => events.push(e),
    };
    const gate = createGate({ ...base, resource: "/api/search", store: new MemoryStore(), shouldCharge: knownAiAgent });
    const broken = createGate({ ...base, resource: "/api/search", store: failing });
    const batch = await iss.sign({ unit_quota: 2, receipt_id: "rcpt_00000000000000aa", nonce: "n-aa" });
    const stranger = await jose.generateKeyPair("Ed25519");
    const forged = await signReceipt(stranger.privateKey as CryptoKey, {});
    const results: GateResult[] = [];
    results.push(await gate(req("/api/search", { "User-Agent": GPTBOT_UA })));
    results.push(await gate(req("/api/search", { "User-Agent": BROWSER_UA })));
    results.push(await gate(req("/api/search", { "User-Agent": GPTBOT_UA, "AIFP-Receipt": forged })));
    results.push(await gate(req("/api/search", { "AIFP-Receipt": await iss.sign({ resource: "/elsewhere" }) })));
    results.push(await gate(req("/api/search", { "AIFP-Receipt": await iss.sign({ expiresInSec: -3600 }) })));
    for (let i = 0; i < 3; i++) results.push(await gate(req("/api/search", { "AIFP-Receipt": batch })));
    results.push(await broken(req("/api/search", { "AIFP-Receipt": batch })));
    results.push(await gate(req("/api/search", {})));
    return { events, results };
  }

  it("same events, different responses", async () => {
    const enforce = await script("enforce");
    const shadow = await script("shadow");
    expect(shadow.events).toEqual(enforce.events);
    expect(shadow.events.map((e) => e.kind)).toEqual([
      "402",
      "serve",
      "403",
      "403",
      "402",
      "serve",
      "serve",
      "402",
      "meter_error",
      "402",
    ]);
    expect(enforce.results.map((r) => r.status)).toEqual([402, 200, 403, 403, 402, 200, 200, 402, 503, 402]);
    expect(shadow.results.map((r) => r.status)).toEqual([200, 200, 200, 200, 200, 200, 200, 200, 200, 200]);
    expect(shadow.results.every((r) => r.ok && r.headers[HEADER_MODE] === "shadow")).toBe(true);
    expect(shadow.results.map((r) => r.headers[HEADER_SHADOW_STATUS])).toEqual([
      "402",
      undefined,
      "403",
      "403",
      "402",
      undefined,
      undefined,
      "402",
      "503",
      "402",
    ]);
  });

  it("the reporter puts the same wire events on the same endpoint", async () => {
    const bodies: Array<{ events: Array<Record<string, unknown>> }> = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body));
      bodies.push(body);
      return new Response(JSON.stringify({ accepted: body.events.length, duplicates: 0 }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);
    const wire = async (mode: "shadow" | "enforce") => {
      const iss = await issuer();
      const reporter = createGateReporter({ merchantId: "mrch_0123456789abcdef", merchantSecret: "s3cret" });
      const gate = createGate({
        merchantId: "mrch_0123456789abcdef",
        resource: "/api/search",
        issuer: ISSUER,
        jwks: iss.jwks,
        store: new MemoryStore(),
        mode,
        onEvent: reporter.onEvent,
        shouldCharge: knownAiAgent,
      });
      await gate(req("/api/search", { "User-Agent": GPTBOT_UA }));
      await gate(req("/api/search", { "User-Agent": BROWSER_UA }));
      const before = bodies.length;
      await reporter.close();
      return bodies
        .slice(before)
        .flatMap((b) => b.events)
        .map(({ id: _id, at: _at, ...rest }) => rest);
    };
    expect(await wire("shadow")).toEqual(await wire("enforce"));
    expect(await wire("shadow")).toEqual([
      { kind: "402", resource: "/api/search", operator: "openai", ua_class: "ai_crawler", verified: false },
    ]);
    for (const call of fetchMock.mock.calls) {
      expect(call[0]).toBe("https://api.aifinpay.io/v1/merchants/mrch_0123456789abcdef/gate-events");
    }
  });

  afterEach(() => vi.unstubAllGlobals());
});

describe("express in shadow", () => {
  const require = createRequire(import.meta.url);
  const servers: Server[] = [];
  afterAll(() => {
    for (const s of servers) s.close();
  });

  it("the handler runs, the crawler gets its page, and the headers say shadow", async () => {
    const iss = await issuer();
    const express = require("express");
    const app = express();
    const events: GateEvent[] = [];
    app.get(
      "/articles/:id",
      aifpGate({
        merchantId: MERCHANT,
        resource: "/articles/*",
        issuer: ISSUER,
        jwks: iss.jwks,
        store: new MemoryStore(),
        mode: "shadow",
        shouldCharge: knownAiAgent,
        onEvent: (e) => events.push(e),
      }),
      (req: any, res: any) => res.json({ article: req.params.id, aifp: req.aifp })
    );
    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, "127.0.0.1", () => resolve(s));
    });
    servers.push(server);
    const { port } = server.address() as { port: number };

    const res = await fetch(`http://127.0.0.1:${port}/articles/42`, { headers: { "User-Agent": GPTBOT_UA } });
    expect(res.status).toBe(200);
    expect(res.headers.get("aifp-mode")).toBe("shadow");
    expect(res.headers.get("aifp-shadow-status")).toBe("402");
    const body = (await res.json()) as { article: string; aifp: { mode: string; shadow: { status: number } } };
    expect(body.article).toBe("42");
    expect(body.aifp.mode).toBe("shadow");
    expect(body.aifp.shadow.status).toBe(402);
    expect(events).toEqual([expect.objectContaining({ kind: "402", resource: "/articles/*", operator: "openai" })]);

    const human = await fetch(`http://127.0.0.1:${port}/articles/42`, { headers: { "User-Agent": BROWSER_UA } });
    expect([human.status, human.headers.get("aifp-mode"), human.headers.get("aifp-shadow-status")]).toEqual([
      200,
      "shadow",
      null,
    ]);
  });
});
