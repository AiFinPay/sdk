// Each block is a difference the conformance vectors found against this gate.
import { createServer, type Server } from "node:http";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it, vi } from "vitest";
import { aifpGate, createGate, createGateReporter, NO_STORE, MemoryStore } from "../src/index.js";
import type { GateEvent, ResourceRegistry } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req, signReceipt } from "./helpers.js";

const require = createRequire(import.meta.url);
const express = require("express");
const MERCHANT_HEX = "mrch_0123456789abcdef";
const GPTBOT = { "User-Agent": "Mozilla/5.0 (compatible; GPTBot/1.2)" };
const BROWSER = { "User-Agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" };

const registry = (patterns: Array<[string, string]>, neverLoaded = false) =>
  ({
    neverLoaded,
    match(path: string) {
      const hit = patterns
        .filter(([p]) => (p.endsWith("/*") ? path === p.slice(0, -2) || path.startsWith(p.slice(0, -1)) : path === p))
        .sort((a, b) => b[0].length - a[0].length)[0];
      return hit
        ? {
            id: "res",
            route_pattern: hit[0],
            type: "page",
            paywall_enabled: true,
            tier: hit[1],
            unit_weight: null,
            name: null,
            created_at: "",
          }
        : null;
    },
    operatorPolicy: () => null,
  }) as unknown as ResourceRegistry;

const servers: Server[] = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  vi.unstubAllGlobals();
});
const listen = (app: Parameters<typeof createServer>[1]) =>
  new Promise<string>((resolve) => {
    const server = createServer(app);
    servers.push(server);
    server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${(server.address() as { port: number }).port}`));
  });

describe("no answer that depends on who asked can be stored by a shared cache", () => {
  it("marks a 402, a 403, a paid response and a shadow would-be refusal", async () => {
    const { jwks, sign } = await issuer();
    const gate = createGate({ merchantId: MERCHANT, resource: "/api/search", jwks, store: new MemoryStore() });
    expect((await gate(req("/api/search"))).headers["Cache-Control"]).toBe(NO_STORE);
    expect((await gate(req("/api/search", { "AIFP-Receipt": "not.a.jwt" }))).headers["Cache-Control"]).toBe(NO_STORE);
    const paid = await gate(req("/api/search", { "AIFP-Receipt": await sign({ unit_quota: 2 }) }));
    expect(paid.status).toBe(200);
    expect(paid.headers["Cache-Control"]).toBe(NO_STORE);
    const shadow = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      jwks,
      store: new MemoryStore(),
      mode: "shadow",
    });
    expect((await shadow(req("/api/search"))).headers["Cache-Control"]).toBe(NO_STORE);
  });

  it("keeps it on a paid response whose handler sets its own", async () => {
    const { jwks, sign } = await issuer();
    const app = express();
    app.use(
      aifpGate({ merchantId: MERCHANT, resource: "/page", jwks, store: new MemoryStore() }),
      (_req: unknown, res: { set: (k: string, v: string) => void; send: (b: string) => void }) => {
        res.set("Cache-Control", "public, max-age=600");
        res.send("paid page");
      }
    );
    const base = await listen(app);
    const response = await fetch(`${base}/page`, {
      headers: { "AIFP-Receipt": await sign({ resource: "/page", unit_quota: 2 }) },
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe(NO_STORE);
  });

  it("leaves an exempt reader's page alone", async () => {
    const { jwks } = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/page",
      jwks,
      store: new MemoryStore(),
      shouldCharge: () => false,
    });
    expect((await gate(req("/page", BROWSER))).headers["Cache-Control"]).toBeUndefined();
  });
});

describe("a key set that answers with an error is an outage, not a bad token", () => {
  for (const [label, answer] of [
    [
      "a 503",
      (res: { writeHead: (s: number) => void; end: (b?: string) => void }) => {
        res.writeHead(503);
        res.end();
      },
    ],
    [
      "a body that is not JSON",
      (res: { writeHead: (s: number) => void; end: (b?: string) => void }) => {
        res.writeHead(200);
        res.end("<html>");
      },
    ],
    [
      "a body with no keys",
      (res: { writeHead: (s: number) => void; end: (b?: string) => void }) => {
        res.writeHead(200);
        res.end("{}");
      },
    ],
  ] as const) {
    it(`answers 503 with Retry-After on ${label}`, async () => {
      const { sign } = await issuer();
      const base = await listen((_req, res) => answer(res as never));
      const gate = createGate({
        merchantId: MERCHANT,
        resource: "/x",
        jwksUri: `${base}/jwks`,
        store: new MemoryStore(),
      });
      const result = await gate(req("/x", { "AIFP-Receipt": await sign({ resource: "/x" }) }));
      expect(result.status).toBe(503);
      expect(result.headers["Retry-After"]).toBe("30");
      expect(result.ok ? null : result.body.error).toBe("AIFP-503-METER");
    });
  }
});

describe("a path no pattern covers", () => {
  it("is not sent to the ingest and does not stop the reporter", async () => {
    const sent: Array<{ events: Array<{ resource: string; operator?: string }> }> = [];
    vi.stubGlobal("fetch", async (_url: string, init: { body: string }) => {
      const body = JSON.parse(init.body);
      sent.push(body);
      return new Response(JSON.stringify({ accepted: body.events.length, duplicates: 0 }), { status: 200 });
    });
    const reporter = createGateReporter({ merchantId: MERCHANT_HEX, merchantSecret: "secret" });
    const { jwks } = await issuer();
    const events: GateEvent[] = [];
    const gate = createGate({
      merchantId: MERCHANT_HEX,
      jwks,
      store: new MemoryStore(),
      registry: registry([["/paid/*", "standard"]]),
      onEvent: (e) => {
        events.push(e);
        reporter.onEvent(e);
      },
    });
    await gate(req("/account/token-abc", GPTBOT));
    await gate(req("/paid/a", GPTBOT));
    await reporter.flush();
    expect(events.map((e) => e.resource)).toEqual(["/account/token-abc", "/paid/*"]);
    expect(events[0].unregistered).toBe(true);
    expect(events[1].unregistered).toBeUndefined();
    expect(sent.flatMap((b) => b.events.map((e) => e.resource))).toEqual(["/paid/*"]);
    expect(sent[0].events[0].operator).toBe("openai");
    expect(reporter.stats.stopped).toBe(false);
    await reporter.close();
  });
});

describe("a router mounted at a prefix", () => {
  it("prices the whole path, as README 1a mounts it", async () => {
    const { jwks } = await issuer();
    const events: GateEvent[] = [];
    const app = express();
    app.use(
      "/articles",
      aifpGate({
        merchantId: MERCHANT,
        jwks,
        store: new MemoryStore(),
        registry: registry([["/articles/*", "premium"]]),
        onEvent: (e: GateEvent) => events.push(e),
      })
    );
    const base = await listen(app);
    const response = await fetch(`${base}/articles/1`);
    const body = await response.json();
    expect(response.status).toBe(402);
    expect([body.resource, body.tier, body.unit_weight]).toEqual(["/articles/*", "premium", 10]);
    expect(events[0].resource).toBe("/articles/*");
  });
});

describe("a registry that never loaded", () => {
  const gateFor = async (shouldCharge: (r: { header(n: string): string | undefined }) => boolean) => {
    const { jwks } = await issuer();
    return createGate({
      merchantId: MERCHANT,
      jwks,
      store: new MemoryStore(),
      registry: registry([], true),
      shouldCharge,
    });
  };
  it("serves a reader the predicate exempts", async () => {
    const gate = await gateFor(() => false);
    const result = await gate(req("/page", BROWSER));
    expect(result.status).toBe(200);
    expect(result.ok && result.aifp.mode).toBe("exempt");
  });
  it("still refuses to price an agent", async () => {
    const gate = await gateFor(() => true);
    expect((await gate(req("/page", GPTBOT))).status).toBe(503);
  });
  it("charges when the predicate throws", async () => {
    const gate = await gateFor(() => {
      throw new Error("broken");
    });
    expect((await gate(req("/page", GPTBOT))).status).toBe(503);
  });
});

describe("claims only the issuer could get wrong", () => {
  it("refuses a receipt with no exp", async () => {
    const { jwks, privateKey } = await issuer();
    const { SignJWT } = await import("jose");
    const token = await new SignJWT({
      resource: "/x",
      scope: "exact",
      unit_quota: 2,
      receipt_id: "rcpt_1",
      nonce: "n",
      amount: "1",
    })
      .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "test-key" })
      .setIssuer(ISSUER)
      .setSubject("agt")
      .setAudience(MERCHANT)
      .sign(privateKey);
    const gate = createGate({ merchantId: MERCHANT, resource: "/x", jwks, store: new MemoryStore() });
    const result = await gate(req("/x", { "AIFP-Receipt": token }));
    expect(result.status).toBe(403);
  });
  for (const [label, unit_quota] of [
    ["text", "abc"],
    ["zero", 0],
    ["negative", -1],
  ] as const) {
    it(`refuses a ${label} unit_quota`, async () => {
      const { jwks, privateKey } = await issuer();
      const token = await signReceipt(privateKey, { resource: "/x", unit_quota: unit_quota as number });
      const gate = createGate({ merchantId: MERCHANT, resource: "/x", jwks, store: new MemoryStore() });
      const result = await gate(req("/x", { "AIFP-Receipt": token }));
      expect(result.status).toBe(403);
      expect(result.ok ? null : result.body.detail).toBe("receipt carries no usable unit_quota");
    });
  }
});
