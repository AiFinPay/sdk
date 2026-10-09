// Independent S05/S06 slice. No author-v2 tests imported; all transport is injected or owned loopback.
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createRequire } from "node:module";
import { createServer, type Server } from "node:http";
import { readFileSync } from "node:fs";
import * as gate from "../src/index.js";
import { issuer } from "./helpers.js"; // pre-existing receipt fixture, actual jose verification
import { Agent, reportingHeaders } from "../../node/src/agent.js";
import { Aifp1ReceiptCache, aifp1Fetch } from "../../node/src/aifp1.js";

const MID = "mrch_0123456789abcdef";
const CAP = "I".repeat(43); // synthetic, never a live credential
const require = createRequire(import.meta.url);
const nativeFetch = globalThis.fetch;
const reporters: gate.GateReporterV2[] = [];
const servers: Server[] = [];
const id = (n = 1) => `20000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const fact = (n = 1): gate.ReportedEvent => ({
  id: id(n),
  name: "access_admitted",
  resource: "/paid",
  at: new Date().toISOString(),
  channel: "api",
  consent: "denied",
});
const ack = (n = 1, duplicate = false) =>
  new Response(
    JSON.stringify({
      version: 2,
      accepted: duplicate ? 0 : n,
      duplicates: duplicate ? n : 0,
      received_at: new Date().toISOString(),
    })
  );
function make() {
  const r = gate.createGateReporterV2({
    version: 2,
    merchantId: MID,
    merchantSecret: "independent-fixture",
    supported: ["access_challenged", "access_admitted", "resource_response_completed"],
  });
  reporters.push(r);
  return r;
}
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(async () => {
  for (const r of reporters.splice(0)) await r.close();
  for (const s of servers.splice(0)) {
    s.closeAllConnections();
    await new Promise<void>((resolve) => s.close(() => resolve()));
  }
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("unchanged v1 implementation and version-only Node package data; dual producer refused", () => {
  const current = readFileSync(new URL("../src/reporter.ts", import.meta.url), "utf8");
  const original = readFileSync(new URL("../../../aifinpay-sdk/gate/src/reporter.ts", import.meta.url), "utf8");
  expect(
    current
      .slice(
        current.indexOf("export interface GateReporterOptions"),
        current.indexOf("export interface GateReporterV2Options")
      )
      .trim()
  ).toBe(original.slice(original.indexOf("export interface GateReporterOptions")).trim());
  for (const pkg of ["gate", "node"])
    for (const file of ["package.json", "package-lock.json"]) {
      const a = JSON.parse(readFileSync(new URL(`../../${pkg}/${file}`, import.meta.url), "utf8"));
      const b = JSON.parse(readFileSync(new URL(`../../../aifinpay-sdk/${pkg}/${file}`, import.meta.url), "utf8"));
      delete a.version;
      delete b.version;
      if (file.includes("lock")) {
        delete a.packages[""].version;
        delete b.packages[""].version;
      }
      expect(a).toEqual(b);
    }
  expect(() =>
    gate.createGate({
      merchantId: MID,
      resource: "/paid",
      onEvent: () => {},
      reporting: { version: 2, reporter: make() },
    })
  ).toThrow(/dual-send/);
});

it.each([
  { name: "payment_confirmed" },
  { name: "paywall_viewed" },
  { wallet: "forged" },
  { mode: "live" },
  { source: "hosted" },
  { origin: "https://foreign.invalid" },
  { reason: "private exception content" },
  { reporting_token: "bad\r\nheader" },
  { client_id: id(2) },
  { at: "2026-02-30T12:00:00.000Z" },
  { at: "2099-01-01T00:00:00.000Z" },
  { resource: "https://foreign.invalid/paid" },
  { resource: "/paid?wallet=secret" },
])("untrusted input refuses without throwing or transport: %j", async (over) => {
  const fetcher = vi.fn();
  vi.stubGlobal("fetch", fetcher);
  const r = make();
  expect(r.record({ ...fact(), ...over } as any)).toBe(false);
  await r.flush();
  expect(fetcher).not.toHaveBeenCalled();
  expect(r.stats.dropped).toBe("1");
});

it("copies immutable facts; equal pending retries dedupe while changed facts conflict", async () => {
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (_url: unknown, init: any) => {
    sent.push(init.body);
    return ack();
  });
  const r = make(),
    e = fact();
  const original = { ...e };
  expect(r.record(e)).toBe(true);
  expect(r.record({ ...e })).toBe(true);
  expect(r.record({ ...e, channel: "browser" })).toBe(false);
  e.resource = "/mutated";
  await r.flush();
  expect(JSON.parse(sent[0]).events).toEqual([original]);
  expect(r.stats).toMatchObject({ delivered: "1", dropped: "1", pending: 0 });
});

it("lost ack retries identical bytes after 1s; no flush bypass; max five event attempts", async () => {
  vi.useFakeTimers();
  const sent: string[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    expect(url).toContain("/v2/");
    sent.push(init.body);
    return new Response("private storage exception", { status: 503 });
  });
  const r = make();
  r.record(fact());
  await r.flush();
  await r.flush();
  expect(sent).toHaveLength(1);
  for (const ms of [1000, 2000, 4000, 8000]) await vi.advanceTimersByTimeAsync(ms);
  expect(sent).toHaveLength(5);
  expect(new Set(sent).size).toBe(1);
  expect(r.stats).toMatchObject({ pending: 0, dropped: "1", retries: "4", lastError: "retry_exhausted" });
  expect(JSON.stringify(r.stats)).not.toContain("private storage");
});

it.each([400, 403, 409, 302])("HTTP %s never retries or follows; reports a drop", async (status) => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => new Response("", { status, headers: { Location: "https://foreign.invalid" } }));
  vi.stubGlobal("fetch", fetcher);
  const r = make();
  r.record(fact());
  await r.flush();
  await vi.advanceTimersByTimeAsync(20000);
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(fetcher.mock.calls[0][1].redirect).toBe("manual");
  expect(r.stats).toMatchObject({ pending: 0, dropped: "1" });
});

it.each(["foreign", "redirected", "extra-ack", "bad-sum"])("refuses forged response %s", async (kind) => {
  const response =
    kind === "extra-ack"
      ? new Response(
          JSON.stringify({ version: 2, accepted: 1, duplicates: 0, received_at: new Date().toISOString(), token: CAP })
        )
      : kind === "bad-sum"
        ? ack(2)
        : ack();
  if (kind === "foreign") Object.defineProperty(response, "url", { value: "https://foreign.invalid" });
  if (kind === "redirected") Object.defineProperty(response, "redirected", { value: true });
  vi.stubGlobal("fetch", async () => response);
  const r = make();
  r.record(fact());
  await r.flush();
  expect(r.stats.delivered).toBe("0");
  expect(r.stats.lastSample).toBeNull();
});

it("bounds inflight+pending queue, 50-event/64KiB batches and loss coverage", async () => {
  let release!: (r: Response) => void;
  const bodies: string[] = [];
  vi.stubGlobal("fetch", (url: string, init: any) => {
    bodies.push(init.body);
    if (bodies.length === 1)
      return new Promise<Response>((resolve) => {
        release = resolve;
      });
    return Promise.resolve(ack(JSON.parse(init.body).events.length));
  });
  const r = make();
  for (let n = 1; n <= 1000; n++) expect(r.record(fact(n))).toBe(true);
  const flush = r.flush();
  expect(r.stats.pending).toBe(1000);
  expect(r.record(fact(1001))).toBe(false);
  release(ack(50));
  await flush;
  expect(bodies).toHaveLength(20);
  for (const b of bodies) {
    expect(JSON.parse(b).events).toHaveLength(50);
    expect(Buffer.byteLength(b)).toBeLessThanOrEqual(65536);
  }
  expect(r.stats).toMatchObject({ pending: 0, delivered: "1000", dropped: "1", lastSample: null });
});

it("3s includes an uncooperative header transport and stalled body; cancels body", async () => {
  vi.useFakeTimers();
  const cancel = vi.fn();
  vi.stubGlobal("fetch", () => new Promise(() => {}));
  let r = make();
  r.record(fact());
  let attempt = r.flush();
  await vi.advanceTimersByTimeAsync(3000);
  expect((await attempt).lastError).toBe("timeout");
  await r.close();
  vi.stubGlobal(
    "fetch",
    async () =>
      new Response(
        new ReadableStream({
          start(c) {
            c.enqueue(new TextEncoder().encode("{"));
          },
          cancel,
        })
      )
  );
  r = make();
  r.record(fact());
  attempt = r.flush();
  await vi.advanceTimersByTimeAsync(3000);
  expect((await attempt).lastError).toBe("timeout");
  expect(cancel).toHaveBeenCalledTimes(1);
});

it("15min queued age expires without a new attempt", async () => {
  vi.useFakeTimers();
  const fetcher = vi.fn(async () => new Response("", { status: 503 }));
  vi.stubGlobal("fetch", fetcher);
  const r = make();
  r.record(fact());
  await r.flush();
  vi.setSystemTime(Date.now() + 900001);
  await r.flush();
  expect(fetcher).toHaveBeenCalledTimes(1);
  expect(r.stats).toMatchObject({ dropped: "1", pending: 0 });
});

it("health-auth overlapping successful event reconciles once; close waits for active health", async () => {
  let release!: (r: Response) => void;
  vi.stubGlobal("fetch", (url: string) =>
    url.endsWith("gate-events")
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : Promise.resolve(new Response("", { status: 403 }))
  );
  const r = make();
  r.record(fact());
  const pending = r.flush();
  await r.health();
  release(ack());
  await pending;
  expect(r.stats).toMatchObject({ delivered: "1", dropped: "0", stopped: true });
  let releaseHealth!: (r: Response) => void;
  vi.stubGlobal(
    "fetch",
    () =>
      new Promise<Response>((resolve) => {
        releaseHealth = resolve;
      })
  );
  const h = make();
  const health = h.health();
  let closed = false;
  const close = h.close().then(() => {
    closed = true;
  });
  await new Promise((resolve) => setImmediate(resolve));
  expect(closed).toBe(false);
  releaseHealth(new Response(JSON.stringify({ version: 2, duplicate: false })));
  expect(await health).toBe(true);
  await close;
  expect(await h.health()).toBe(false);
  expect(h.record(fact())).toBe(false);
});

it("SEC-SDK-01: health retry spacing keeps independent <=12/min cap", async () => {
  vi.useFakeTimers();
  const times: number[] = [];
  vi.stubGlobal("fetch", async () => {
    times.push(Date.now());
    return new Response("", { status: 503 });
  });
  const r = make();
  await r.health();
  for (let n = 1; n < 60; n++) {
    await vi.advanceTimersByTimeAsync(1000);
    await r.health();
  }
  expect(times.length).toBeLessThanOrEqual(12); // cap covers failed attempts too
  for (let n = 1; n < times.length; n++) expect(times[n] - times[n - 1]).toBeGreaterThanOrEqual(5000);
});

it.each([
  "https://foreign.invalid/v1/quote",
  "https://api.aifinpay.io/v1/pay",
  "https://api.aifinpay.io/.well-known/jwks.json",
  "https://api.aifinpay.io/v1/quote?q=raw",
  "https://api.aifinpay.io/v1/quote#raw",
  "https://api.aifinpay.io@foreign.invalid/v1/quote",
  "http://api.aifinpay.io/v1/quote",
])("payer header refuses noncanonical endpoint %s", (url) => {
  expect(reportingHeaders(CAP, url)).toEqual({});
});

it("payer quote capability is call-scoped and redirect manual; never body or retained agent state", async () => {
  const fetcher = vi.fn(async () => new Response("{}"));
  const a = Agent.new({ fetchImpl: fetcher, baseUrl: "https://aifinpay.io" });
  await a.quoteSplit({ chain: "polygon", merchantAmount: "1", reportingToken: CAP });
  await a.quoteSplit({ chain: "polygon", merchantAmount: "1" });
  expect(new Headers(fetcher.mock.calls[0][1].headers).get("AIFP-Reporting-Token")).toBe(CAP);
  expect(fetcher.mock.calls[0][1].redirect).toBe("manual");
  expect(new Headers(fetcher.mock.calls[1][1].headers).has("AIFP-Reporting-Token")).toBe(false);
  expect(JSON.stringify(a)).not.toContain(CAP);
});

it("payer cached receipt survives reporter outage and upstream error without new payment/auth", async () => {
  const cache = new Aifp1ReceiptCache();
  cache.put({
    site: "https://gateway.aifinpay.io/fixture",
    merchantId: MID,
    receiptId: "independent",
    jwt: "synthetic-held-receipt",
    scope: "exact",
    resource: "/paid",
    unitQuota: 10,
    remaining: 10,
    expiresAt: Date.now() + 60000,
    amountUsd: 0.1,
  });
  const fetcher = vi.fn(async () => new Response("original upstream", { status: 503 }));
  const pay = vi.fn(() => {
    throw Error("must not repeat settlement");
  });
  const auth = vi.fn(() => {
    throw Error("must not sign again");
  });
  const deps: any = {
    cache,
    fetchImpl: fetcher,
    agentId: "observed-not-identity",
    payerAddress: "fixture",
    settle: pay,
    signPaymentAuthorization: auth,
  };
  for (let n = 0; n < 2; n++)
    expect(
      (
        await aifp1Fetch(
          deps,
          "https://gateway.aifinpay.io/fixture/paid",
          { headers: { "aifp-reporting-token": CAP } },
          { reportingToken: CAP }
        )
      )?.status
    ).toBe(503);
  expect(fetcher).toHaveBeenCalledTimes(2);
  expect(pay).not.toHaveBeenCalled();
  expect(auth).not.toHaveBeenCalled();
  for (const [, init] of fetcher.mock.calls) {
    expect(new Headers(init.headers).get("AIFP-Receipt")).toBe("synthetic-held-receipt");
    expect(new Headers(init.headers).has("AIFP-Reporting-Token")).toBe(false);
    expect(init.redirect).toBe("manual");
  }
  expect(JSON.stringify(cache.list())).not.toContain(CAP);
});

async function listen(s: Server) {
  await new Promise<void>((resolve, reject) => {
    s.once("error", reject);
    s.listen(0, "127.0.0.1", resolve);
  });
  servers.push(s);
  return `http://127.0.0.1:${(s.address() as any).port}`;
}

it("actual HTTP collector lost ack commits once; retransmits identical bytes with correct logical response URL", async () => {
  const bytes: string[] = [],
    accepted = new Map<string, string>();
  const base = await listen(
    createServer((req, res) => {
      let body = "";
      req.on("data", (b) => {
        body += b;
      });
      req.on("end", () => {
        bytes.push(body);
        const events = JSON.parse(body).events;
        if (bytes.length === 1) {
          for (const e of events) accepted.set(e.id, JSON.stringify(e));
          res.destroy();
          return;
        }
        res.end(
          JSON.stringify({ version: 2, accepted: 0, duplicates: events.length, received_at: new Date().toISOString() })
        );
      });
    })
  );
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    expect(url).toBe(`https://api.aifinpay.io/v2/merchants/${MID}/gate-events`);
    const response = await nativeFetch(base + new URL(url).pathname, init);
    Object.defineProperty(response, "url", { value: url });
    return response;
  });
  const r = make();
  r.record(fact());
  await r.flush();
  await new Promise((resolve) => setTimeout(resolve, 1100));
  await r.flush();
  expect(bytes).toHaveLength(2);
  expect(bytes[1]).toBe(bytes[0]);
  expect(accepted.size).toBe(1);
  expect(r.stats).toMatchObject({ delivered: "1", dropped: "0", pending: 0 });
});

for (const major of ["express", "express4"]) {
  it.each([200, 302, 503, "abort"])(
    `${major}: real paid terminal %s once, privacy, telemetry503 preserves quota`,
    async (status) => {
      const observations: any[] = [];
      const iss = await issuer();
      const r = make();
      const originalObserve = r.observe.bind(r);
      vi.spyOn(r, "observe").mockImplementation((e) => {
        observations.push(e);
        return originalObserve(e);
      });
      const app = require(major)(),
        memory = new gate.MemoryStore();
      vi.stubGlobal("fetch", async () => new Response("outage", { status: 503 }));
      app.get(
        "/paid",
        gate.aifpGate({
          merchantId: MID,
          resource: "/paid",
          jwks: iss.jwks,
          store: memory,
          reporting: { version: 2, reporter: r },
        }),
        (_req: any, res: any) => {
          if (status === "abort") {
            res.writeHead(200);
            res.write("partial");
            setImmediate(() => res.destroy());
          } else res.status(status).end("original");
        }
      );
      const base = await listen(createServer(app));
      const receipt = await iss.sign({ aud: MID, resource: "/paid", unit_quota: 10, receipt_id: "independent-paid" });
      try {
        const response = await nativeFetch(base + "/paid", {
          redirect: "manual",
          headers: {
            "AIFP-Receipt": receipt,
            "AIFP-Reporting-Token": CAP,
            "User-Agent": "wallet-spoof",
            "X-Forwarded-For": "192.0.2.1",
            "AIFP-Agent-Id": "forged-wallet",
          },
        });
        if (status !== "abort") expect(response.status).toBe(status);
        await response.text();
      } catch (err) {
        if (status !== "abort") throw err;
      }
      await new Promise((resolve) => setImmediate(resolve));
      await r.flush();
      expect(observations.map((e) => e.name)).toEqual(["access_admitted", "resource_response_completed"]);
      expect(observations[1].outcome).toBe(
        status === "abort" ? "abort" : status === 200 ? "success" : status === 302 ? "redirect" : "error"
      );
      expect(
        observations.every(
          (e) => e.reporting_token === CAP && e.channel === "unknown" && e.consent === "unknown" && !e.client_id
        )
      ).toBe(true);
      expect(JSON.stringify(observations)).not.toMatch(/192\.0\.2\.1|wallet-spoof|forged-wallet|independent-paid/);
      expect(await memory.get("aifp:used:independent-paid")).toBe(1);
    }
  );
  it(`${major}: emitted402 only, malicious context cannot grant receipt-free access`, async () => {
    const seen: any[] = [],
      r = make(),
      iss = await issuer();
    vi.spyOn(r, "observe").mockImplementation((e) => {
      seen.push(e);
      return true;
    });
    const app = require(major)();
    let access = 0;
    app.get(
      "/paid",
      gate.aifpGate({
        merchantId: MID,
        resource: "/paid",
        jwks: iss.jwks,
        store: new gate.MemoryStore(),
        reporting: {
          version: 2,
          reporter: r,
          context: () => ({ channel: "browser", consent: "denied", client_id: id() }),
        },
      }),
      (_req: any, res: any) => {
        access++;
        res.end("must not reach");
      }
    );
    const base = await listen(createServer(app));
    const resp = await nativeFetch(base + "/paid", { headers: { "AIFP-Reporting-Token": CAP } });
    expect(resp.status).toBe(402);
    await resp.text();
    await new Promise((resolve) => setImmediate(resolve));
    expect(access).toBe(0);
    expect(seen.map((e) => e.name)).toEqual(["access_challenged"]);
    expect(seen[0].client_id).toBeUndefined();
    expect(seen[0].reporting_token).toBe(CAP);
  });
}
