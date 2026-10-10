import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as api from "../src/index.js";
import { createRequire } from "node:module";
import { createServer, request, type Server } from "node:http";
import { issuer } from "./helpers.js";

const merchantId = "mrch_0123456789abcdef";
const id = "10000000-0000-4000-8000-000000000001";
const token = "A".repeat(43);
const event = () => ({
  id,
  name: "access_challenged",
  resource: "/api/items/*",
  at: new Date().toISOString(),
  channel: "api",
  consent: "denied",
});
const reporters: any[] = [];
const servers: Server[] = [];
const nativeFetch = globalThis.fetch;
const require = createRequire(import.meta.url);
const make = () => {
  const reporter = (api as any).createGateReporterV2({
    version: 2,
    merchantId,
    merchantSecret: "synthetic-test-only",
    supported: ["access_challenged", "access_admitted", "resource_response_completed"],
  });
  reporters.push(reporter);
  return reporter;
};
const ack = (count = 1) =>
  new Response(JSON.stringify({ version: 2, accepted: count, duplicates: 0, received_at: new Date().toISOString() }), {
    status: 200,
  });
// Exact body of the backend's POST /v2/merchants/:id/reporting/health handler.
const healthAck = (duplicate = false) => new Response(JSON.stringify({ version: 2, duplicate }), { status: 200 });
beforeEach(() => {
  vi.spyOn(Math, "random").mockReturnValue(0.5);
});
afterEach(async () => {
  for (const reporter of reporters.splice(0)) await reporter.close();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("frozen Node reporting v2 producer", () => {
  it("exports a distinct opt-in factory and sends only the frozen v2 batch", async () => {
    const transport = vi.fn(async () => ack());
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    const original = event();
    expect(reporter.record(original)).toBe(true);
    await reporter.flush();
    const [url, init] = transport.mock.calls[0] as any;
    expect(url).toBe(`https://api.aifinpay.io/v2/merchants/${merchantId}/gate-events`);
    expect(JSON.parse(init.body)).toEqual({ version: 2, events: [original] });
    expect(init.redirect).toBe("manual");
    expect(new Headers(init.headers).get("AIFP-Merchant-Secret")).toBe("synthetic-test-only");
    expect(reporter.stats.pending).toBe(0);
  });
  it.each(["wallet", "body", "ip", "JWT", "mode", "source", "amount"])(
    "refuses extra %s without transporting it",
    async (key) => {
      const transport = vi.fn();
      vi.stubGlobal("fetch", transport);
      const reporter = make();
      expect(reporter.record({ ...event(), [key]: "sensitive" })).toBe(false);
      await reporter.flush();
      expect(transport).not.toHaveBeenCalled();
    }
  );
  it("rejects identity without granted consent and authoritative/browser claims", () => {
    const reporter = make();
    expect(reporter.record({ ...event(), client_id: id })).toBe(false);
    for (const name of ["payment_confirmed", "quote_created", "paywall_viewed", "merchant_signup_completed"])
      expect(reporter.record({ ...event(), name })).toBe(false);
  });
  it("deduplicates equal pending IDs, rejects changed facts, and snapshots caller mutation", async () => {
    const transport = vi.fn(async () => ack());
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    const original = event();
    expect(reporter.record(original)).toBe(true);
    expect(reporter.record({ ...original })).toBe(true);
    expect(reporter.record({ ...original, channel: "browser" })).toBe(false);
    original.resource = "/changed";
    await reporter.flush();
    expect(JSON.parse((transport.mock.calls[0] as any)[1].body).events[0].resource).toBe("/api/items/*");
  });
  it("bounds queue including inflight records to 1000 and batches to50", async () => {
    const transport = vi.fn(async (_url, init) => ack(JSON.parse(init.body).events.length));
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    for (let n = 0; n < 1001; n++)
      reporter.observe({ name: "access_challenged", resource: "/api/items/*", channel: "unknown", consent: "unknown" });
    expect(reporter.stats.pending).toBe(1000);
    expect(reporter.stats.dropped).toBe("1");
    await reporter.flush();
    expect(transport).toHaveBeenCalledTimes(20);
    for (const [, init] of transport.mock.calls) expect(JSON.parse(init.body).events.length).toBe(50);
  });
  it("keeps immutable facts and IDs across a lost acknowledgement", async () => {
    vi.useFakeTimers();
    const transport = vi.fn().mockRejectedValueOnce(new Error("lost ack")).mockResolvedValue(ack());
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    reporter.record(event());
    await reporter.flush();
    expect(reporter.stats.retries).toBe("1");
    await reporter.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(transport).toHaveBeenCalledTimes(2);
    expect(transport.mock.calls[1][1].body).toBe(transport.mock.calls[0][1].body);
  });
  it.each([400, 403, 409])("does not retry permanent HTTP%s", async (status) => {
    const transport = vi.fn(
      async () => new Response(JSON.stringify({ version: 2, error: "event_conflict", retryable: false }), { status })
    );
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    reporter.record(event());
    await reporter.flush();
    await reporter.flush();
    expect(transport).toHaveBeenCalledTimes(1);
    expect(reporter.stats.pending).toBe(0);
    expect(reporter.stats.dropped).toBe("1");
  });
  it("mints the exact scoped flow; invalid telemetry returns null", async () => {
    const response = {
      version: 2,
      flow_id: id,
      reporting_token: token,
      expires_at: new Date(Date.now() + 900000).toISOString(),
      mode: "live",
      resource: "/api/items/*",
    };
    const transport = vi.fn(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    const request = { version: 2, request_id: id, resource: "/api/items/*", channel: "api", consent: "denied" };
    expect(await reporter.mintFlow(request)).toEqual(response);
    expect(transport.mock.calls[0][0]).toBe(`https://api.aifinpay.io/v2/merchants/${merchantId}/reporting/flows`);
    expect(JSON.parse((transport.mock.calls[0] as any)[1].body)).toEqual(request);
    expect(await reporter.mintFlow({ ...request, client_id: id })).toBeNull();
  });
  it("health is an exact monotonic sample, restart creates a fresh producer", async () => {
    const transport = vi.fn(async () => healthAck());
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    expect(reporter.stats.lastSample).toBeNull();
    expect(await reporter.health()).toBe(true);
    const sample = JSON.parse((transport.mock.calls[0] as any)[1].body);
    expect(Object.keys(sample).sort()).toEqual(
      ["version", "producer_id", "sequence", "at", "supported", "pending", "dropped", "retries", "last_error"].sort()
    );
    expect(sample).toMatchObject({
      version: 2,
      sequence: "1",
      pending: 0,
      dropped: "0",
      retries: "0",
      last_error: "none",
    });
    expect(make().stats.producerId).not.toBe(reporter.stats.producerId);
  });
  it("waits1s, retries at1/2/4/8s, and exhausts after exactly5 attempts", async () => {
    vi.useFakeTimers();
    const transport = vi.fn(async () => new Response("", { status: 503 }));
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    reporter.record(event());
    await vi.advanceTimersByTimeAsync(999);
    expect(transport).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(transport).toHaveBeenCalledTimes(1);
    for (const [delay, count] of [
      [1000, 2],
      [2000, 3],
      [4000, 4],
      [8000, 5],
    ]) {
      await vi.advanceTimersByTimeAsync(delay - 1);
      expect(transport).toHaveBeenCalledTimes(count - 1);
      await vi.advanceTimersByTimeAsync(1);
      expect(transport).toHaveBeenCalledTimes(count);
    }
    expect(reporter.stats).toMatchObject({ pending: 0, dropped: "1", retries: "4", lastError: "retry_exhausted" });
  });
  it("enforces3s even for an uncooperative transport", async () => {
    vi.useFakeTimers();
    vi.stubGlobal(
      "fetch",
      vi.fn(() => new Promise(() => {}))
    );
    const reporter = make();
    reporter.record(event());
    const flush = reporter.flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await flush).lastError).toBe("timeout");
  });
  it("enforces body deadline and cancels a stalled response stream", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            new ReadableStream({
              start(controller) {
                controller.enqueue(new TextEncoder().encode('{"version":2'));
              },
              cancel,
            })
          )
      )
    );
    const reporter = make();
    reporter.record(event());
    const flush = reporter.flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect((await flush).lastError).toBe("timeout");
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it("does not retry an expired15minute queue and rejects invalid/future calendar times", async () => {
    vi.useFakeTimers();
    const transport = vi.fn();
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    reporter.record(event());
    vi.setSystemTime(Date.now() + 900000);
    await reporter.flush();
    expect(transport).not.toHaveBeenCalled();
    expect(reporter.stats.dropped).toBe("1");
    for (const at of [
      "2026-02-30T12:00:00.000Z",
      new Date(Date.now() + 300001).toISOString(),
      new Date(Date.now() - 86400001).toISOString(),
    ])
      expect(reporter.record({ ...event(), at })).toBe(false);
  });
  it("accepts an equal near24h retry before age checks and leaves facts stable", async () => {
    vi.useFakeTimers();
    const transport = vi.fn().mockRejectedValueOnce(new Error("lost ack")).mockResolvedValue(ack());
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    const original = { ...event(), at: new Date(Date.now() - 86399999).toISOString(), reporting_token: token };
    reporter.record(original);
    await reporter.flush();
    vi.setSystemTime(Date.now() + 1000);
    expect(reporter.record({ ...original })).toBe(true);
    await reporter.flush();
    expect(transport.mock.calls[1][1].body).toBe(transport.mock.calls[0][1].body);
  });
  it("accepts the backend health acknowledgment, including a duplicate retry, and refuses other shapes", async () => {
    for (const body of [
      { version: 2, accepted: 1, duplicates: 0, received_at: new Date().toISOString() },
      { duplicate: false },
      { version: 1, duplicate: false },
      { version: 2, duplicate: "false" },
      { version: 2, duplicate: false, accepted: 1 },
    ]) {
      vi.stubGlobal("fetch", async () => new Response(JSON.stringify(body), { status: 200 }));
      const reporter = make();
      expect(await reporter.health()).toBe(false);
      expect(reporter.stats.lastSample).toBeNull();
    }
    for (const duplicate of [false, true]) {
      vi.stubGlobal("fetch", async () => healthAck(duplicate));
      const reporter = make();
      expect(await reporter.health()).toBe(true);
      expect(reporter.stats.lastSample).not.toBeNull();
    }
  });
  it("retains health facts/sequence across retry, advances after acknowledgement and enforces sample rate", async () => {
    vi.useFakeTimers();
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error())
      .mockImplementation(async () => healthAck());
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    expect(await reporter.health()).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect(await reporter.health()).toBe(false);
    await vi.advanceTimersByTimeAsync(3999);
    expect(await reporter.health()).toBe(false);
    expect(transport).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(await reporter.health()).toBe(true);
    expect(transport.mock.calls[1][1].body).toBe(transport.mock.calls[0][1].body);
    expect(await reporter.health()).toBe(false);
    await vi.advanceTimersByTimeAsync(5000);
    expect(await reporter.health()).toBe(true);
    expect(JSON.parse(transport.mock.calls[2][1].body).sequence).toBe("2");
  });
  it.each([200, 503])("caps every health attempt across a complete minute with HTTP %s", async (status) => {
    vi.useFakeTimers();
    const times: number[] = [];
    const bodies: string[] = [];
    const start = Date.now();
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      times.push(Date.now() - start);
      bodies.push(init.body as string);
      return status === 200 ? healthAck() : new Response("", { status });
    });
    const reporter = make();
    for (let second = 0; second < 60; second++) {
      if (second) await vi.advanceTimersByTimeAsync(1000);
      await reporter.health();
    }
    expect(times).toEqual(
      status === 200
        ? [0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 55].map((s) => s * 1000)
        : [0, 5, 10, 15, 23, 28, 33, 38, 43, 51, 56].map((s) => s * 1000)
    );
    for (let i = 1; i < times.length; i++) expect(times[i] - times[i - 1]).toBeGreaterThanOrEqual(5000);
    if (status === 503) {
      expect(new Set(bodies.slice(0, 5)).size).toBe(1);
      expect(new Set(bodies.slice(5, 10)).size).toBe(1);
      expect(bodies.slice(10).map((body) => JSON.parse(body).sequence)).toEqual(["3"]);
      expect(reporter.stats.lastSample).toBeNull();
    }
  });
  it("preserves mint requestID/body on retry and isolates errors with no raw diagnostics", async () => {
    vi.useFakeTimers();
    const response = {
      version: 2,
      flow_id: id,
      reporting_token: token,
      expires_at: new Date(Date.now() + 900000).toISOString(),
      mode: "live",
      resource: "/api/items/*",
    };
    const transport = vi
      .fn()
      .mockRejectedValueOnce(new Error("secret-body-wallet"))
      .mockResolvedValue(new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    const flow = reporter.mintFlow({
      version: 2,
      request_id: id,
      resource: "/api/items/*",
      channel: "api",
      consent: "unknown",
    });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await flow).toEqual(response);
    expect(transport.mock.calls[1][1].body).toBe(transport.mock.calls[0][1].body);
    expect(JSON.stringify(reporter.stats)).not.toContain("secret-body-wallet");
  });
  it.each([
    { outcome: "success", status: 302 },
    { outcome: "redirect", status: 200 },
    { outcome: "error", status: 200 },
    { outcome: "success" },
    { outcome: "abort", status: 600 },
    { outcome: "success", status: null },
  ])("refuses inconsistent terminal facts: %j", (terminal) => {
    expect(make().record({ ...event(), name: "resource_response_completed", ...terminal })).toBe(false);
  });
  it("refuses ACK extra fields/oversized responses/redirects without false delivery", async () => {
    const transport = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            version: 2,
            accepted: 1,
            duplicates: 0,
            received_at: new Date().toISOString(),
            wallet: "forged",
          })
        )
      )
      .mockResolvedValueOnce(new Response("X".repeat(9000)))
      .mockResolvedValueOnce(new Response("", { status: 302, headers: { Location: "https://other.example" } }));
    vi.stubGlobal("fetch", transport);
    vi.useFakeTimers();
    const reporter = make();
    reporter.record(event());
    await reporter.flush();
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    expect(reporter.stats).toMatchObject({ delivered: "0", pending: 0, dropped: "1" });
    expect(transport).toHaveBeenCalledTimes(3);
  });
  it("refuses dual wiring and never exposes an unmatched registry fallback path", async () => {
    const reporter = make();
    const iss = await issuer();
    const reporting = { version: 2 as const, reporter };
    expect(() =>
      api.createGate({ merchantId, resource: "/api/search", jwks: iss.jwks, reporting, onEvent: () => {} })
    ).toThrow(/dual-send/);
    const gate = api.createGate({
      merchantId,
      registry: { neverLoaded: false, match: () => null } as any,
      jwks: iss.jwks,
      store: new api.MemoryStore(),
      reporting,
    });
    const result = await gate({ path: "/caller-private-value", header: () => undefined });
    expect(result.status).toBe(402);
    expect(result.reportingResource).toBeUndefined();
  });
  it("unknown/denied context cannot acquire an identity or silently retain extra fields", () => {
    const reporter = make();
    expect(api.validReportingContext({ channel: "browser", consent: "denied", client_id: id })).toBe(false);
    expect(api.validReportingContext({ channel: "api", consent: "granted", client_id: id })).toBe(true);
    expect(
      reporter.observe({
        name: "access_admitted",
        resource: "/api/search",
        channel: "api",
        consent: "unknown",
        id,
      } as any)
    ).toBe(false);
    expect(reporter.record({ ...event(), status: 402 })).toBe(false);
  });
  it("holds queue capacity while the actual batch request is in flight", async () => {
    let release!: (response: Response) => void;
    const transport = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      )
      .mockImplementation(async (_url, init) => ack(JSON.parse(init.body).events.length));
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    for (let n = 0; n < 1000; n++)
      reporter.observe({ name: "access_admitted", resource: "/api/search", channel: "api", consent: "unknown" });
    const flush = reporter.flush();
    expect(reporter.stats.pending).toBe(1000);
    expect(
      reporter.observe({ name: "access_admitted", resource: "/api/search", channel: "api", consent: "unknown" })
    ).toBe(false);
    release(ack(50));
    expect((await flush).delivered).toBe("1000");
    expect(reporter.stats.dropped).toBe("1");
  });
  it("flow validates exactkeys/scope/UUID and keeps a caller mutation out of transport", async () => {
    const response = {
      version: 2,
      flow_id: id,
      reporting_token: token,
      expires_at: new Date(Date.now() + 900000).toISOString(),
      mode: "live",
      resource: "/api/items/*",
    };
    const transport = vi.fn(async () => new Response(JSON.stringify(response)));
    vi.stubGlobal("fetch", transport);
    const reporter = make();
    const request = { version: 2, request_id: id, resource: "/api/items/*", channel: "api", consent: "unknown" };
    const flow = reporter.mintFlow(request);
    request.resource = "/other";
    expect(await flow).toEqual(response);
    for (const changed of [
      { wallet: "forged" },
      { request_id: {} },
      { resource: "/api/items?id=raw" },
      { resource: "/api/:client" },
      { consent: "unknown", client_id: id },
    ])
      expect(await reporter.mintFlow({ ...request, ...changed })).toBeNull();
    expect(transport).toHaveBeenCalledTimes(1);
  });
  it("concurrent health auth refusal cannot count an acknowledged inflight event as dropped", async () => {
    let release!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn((url) =>
        String(url).endsWith("/gate-events")
          ? new Promise<Response>((resolve) => {
              release = resolve;
            })
          : Promise.resolve(new Response("", { status: 403 }))
      )
    );
    const reporter = make();
    reporter.record(event());
    const flush = reporter.flush();
    expect(await reporter.health()).toBe(false);
    release(ack());
    await flush;
    expect(reporter.stats).toMatchObject({ pending: 0, delivered: "1", dropped: "0", stopped: true });
  });
  it("close waits for an outstanding bounded health request and stops timers", async () => {
    let release!: (response: Response) => void;
    vi.stubGlobal(
      "fetch",
      vi.fn(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      )
    );
    const reporter = make();
    const health = reporter.health();
    let done = false;
    const close = reporter.close().then(() => {
      done = true;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(done).toBe(false);
    release(ack());
    await health;
    await close;
    expect(done).toBe(true);
    expect(await reporter.health()).toBe(false);
    expect(reporter.stats.closed).toBe(true);
  });
});

async function listen(server: Server): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  servers.push(server);
  return `http://127.0.0.1:${(server.address() as any).port}`;
}

for (const major of ["express", "express4"])
  describe(`${major} actual terminal adapters + HTTP collector`, () => {
    async function setup(status = 200, abort = false, badTelemetry = false, meterWait?: Promise<void>) {
      const batches: any[] = [];
      const collector = await listen(
        createServer((req, res) => {
          let bytes = "";
          req.on("data", (chunk) => {
            bytes += chunk;
          });
          req.on("end", () => {
            expect(req.url).toBe(`/v2/merchants/${merchantId}/gate-events`);
            expect(req.headers["aifp-merchant-secret"]).toBe("synthetic-test-only");
            const body = JSON.parse(bytes);
            batches.push(body);
            res.setHeader("Content-Type", "application/json");
            if (badTelemetry) {
              res.statusCode = 503;
              res.end(JSON.stringify({ version: 2, error: "reporting_unavailable", retryable: true }));
            } else
              res.end(
                JSON.stringify({
                  version: 2,
                  accepted: body.events.length,
                  duplicates: 0,
                  received_at: new Date().toISOString(),
                })
              );
          });
        })
      );
      // Only the fixed collector URL is translated to our owned loopback fixture.
      vi.stubGlobal("fetch", (input: any, init: any) => {
        const target = new URL(String(input));
        if (target.origin !== "https://api.aifinpay.io" || !target.pathname.startsWith(`/v2/merchants/${merchantId}/`))
          throw new Error("unexpected outbound request");
        return nativeFetch(`${collector}${target.pathname}`, init).then((response) => {
          // This injected transport maps one fixed logical origin to owned HTTP.
          // Preserve actual streamed bytes/status while restoring the logical URL.
          Object.defineProperty(response, "url", { value: String(input) });
          return response;
        });
      });
      const reporter = make();
      const iss = await issuer();
      const app = require(major)();
      const memory = new api.MemoryStore();
      const store = meterWait
        ? {
            incrBy: async (...args: Parameters<typeof memory.incrBy>) => {
              await meterWait;
              return memory.incrBy(...args);
            },
            decrBy: memory.decrBy.bind(memory),
          }
        : memory;
      app.get(
        "/api/search",
        api.aifpGate({
          merchantId,
          resource: "/api/search",
          issuer: "https://api.aifinpay.io",
          jwks: iss.jwks,
          store,
          reporting: { version: 2, reporter, context: () => ({ channel: "api", consent: "denied" }) },
        }),
        (_req: any, res: any) => {
          if (abort) {
            res.writeHead(status);
            res.write("start");
            setImmediate(() => res.destroy());
          } else res.status(status).end("original");
        }
      );
      const base = await listen(createServer(app));
      const receipt = await iss.sign({ aud: merchantId, unit_quota: 10 });
      return { base, reporter, receipt, batches };
    }
    it("emitted402 produces challenge only, never view/admission/completion", async () => {
      const f = await setup();
      const response = await nativeFetch(`${f.base}/api/search`, {
        headers: { "AIFP-Agent-Id": "wallet-not-identity", "AIFP-Reporting-Token": token },
      });
      expect(response.status).toBe(402);
      await response.text();
      await f.reporter.flush();
      const events = f.batches.flatMap((b) => b.events);
      expect(events.map((e) => e.name)).toEqual(["access_challenged"]);
      expect(events[0]).toMatchObject({ channel: "api", consent: "denied", reporting_token: token });
      expect(events[0].client_id).toBeUndefined();
      expect(f.reporter.stats.delivered).toBe("1");
      expect(JSON.stringify(events)).not.toContain("wallet-not-identity");
    });
    it.each([
      [200, "success"],
      [302, "redirect"],
      [404, "error"],
      [500, "error"],
    ])("finished%s records admission + once-only%s", async (status, outcome) => {
      const f = await setup(status as number);
      const response = await nativeFetch(`${f.base}/api/search`, {
        headers: { "AIFP-Receipt": f.receipt },
        redirect: "manual",
      });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("original");
      await f.reporter.flush();
      const events = f.batches.flatMap((b) => b.events);
      expect(events.map((e) => e.name)).toEqual(["access_admitted", "resource_response_completed"]);
      expect(events[1]).toMatchObject({ outcome, status });
      expect(f.reporter.stats.delivered).toBe("2");
      expect(JSON.stringify(events)).not.toContain(f.receipt);
    });
    it("actual interrupted stream records admission + abort once, never success", async () => {
      const f = await setup(200, true);
      await new Promise<void>((resolve) => {
        const req = request(`${f.base}/api/search`, { headers: { "AIFP-Receipt": f.receipt } }, (res) => {
          res.resume();
          res.once("aborted", resolve);
          res.once("end", resolve);
          res.once("error", () => resolve());
        });
        req.once("error", () => resolve());
        req.end();
      });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await f.reporter.flush();
      const events = f.batches.flatMap((b) => b.events);
      expect(events.map((e) => e.name)).toEqual(["access_admitted", "resource_response_completed"]);
      expect(events[1]).toMatchObject({ outcome: "abort", reason: "client_abort", status: 200 });
    });
    it("collector503 does not change original receipt result or consume it twice", async () => {
      const f = await setup(200, false, true);
      const response = await nativeFetch(`${f.base}/api/search`, { headers: { "AIFP-Receipt": f.receipt } });
      expect(response.status).toBe(200);
      expect(response.headers.get("AIFP-Quota-Remaining")).toBe("9");
      expect(await response.text()).toBe("original");
      await f.reporter.flush();
      expect(f.reporter.stats.pending).toBe(2);
      expect(f.reporter.stats.lastError).toBe("storage");
    });
    it("disconnect while awaiting metering still records a single abort without status", async () => {
      let release!: () => void;
      const wait = new Promise<void>((resolve) => {
        release = resolve;
      });
      const f = await setup(200, false, false, wait);
      await new Promise<void>((resolve) => {
        const req = request(`${f.base}/api/search`, { headers: { "AIFP-Receipt": f.receipt } });
        req.on("error", () => resolve());
        req.end();
        setTimeout(() => req.destroy(), 25);
      });
      // Let the server's close event run before allowing the gate to complete.
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      release();
      await new Promise<void>((resolve) => setTimeout(resolve, 25));
      await f.reporter.flush();
      const events = f.batches.flatMap((b) => b.events);
      expect(events.map((e) => e.name)).toEqual(["access_admitted", "resource_response_completed"]);
      expect(events[1]).toMatchObject({ outcome: "abort", reason: "client_abort" });
      expect(events[1]).not.toHaveProperty("status");
    });
  });

describe("actual frozen-contract HTTP replay adapter", () => {
  it("lost ack retransmits one accepted fact unchanged after the new-event late bound", async () => {
    const requests: any[] = [];
    const stored = new Map<string, string>();
    const collector = await listen(
      createServer((req, res) => {
        let bytes = "";
        req.on("data", (chunk) => {
          bytes += chunk;
        });
        req.on("end", () => {
          const body = JSON.parse(bytes);
          requests.push(body);
          let accepted = 0,
            duplicates = 0;
          for (const fact of body.events) {
            const canonical = JSON.stringify(fact);
            const existing = stored.get(fact.id);
            if (existing) {
              expect(canonical).toBe(existing);
              duplicates++;
            } else {
              expect(Date.parse(fact.at)).toBeGreaterThanOrEqual(Date.now() - 86400000);
              stored.set(fact.id, canonical);
              accepted++;
            }
          }
          if (requests.length === 1) {
            res.destroy();
            return;
          }
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ version: 2, accepted, duplicates, received_at: new Date().toISOString() }));
        });
      })
    );
    vi.stubGlobal("fetch", (input: any, init: any) => {
      expect(String(input)).toBe(`https://api.aifinpay.io/v2/merchants/${merchantId}/gate-events`);
      return nativeFetch(`${collector}/v2/merchants/${merchantId}/gate-events`, init).then((response) => {
        Object.defineProperty(response, "url", { value: String(input) });
        return response;
      });
    });
    const reporter = make();
    const original = { ...event(), at: new Date(Date.now() - 86400000 + 500).toISOString(), reporting_token: token };
    reporter.record(original);
    await reporter.flush();
    expect(stored.size).toBe(1);
    await new Promise<void>((resolve) => setTimeout(resolve, 1200));
    await reporter.flush();
    expect(requests).toHaveLength(2);
    expect(requests[1]).toEqual(requests[0]);
    expect(Date.parse(original.at)).toBeLessThan(Date.now() - 86400000);
    expect(reporter.stats).toMatchObject({ pending: 0, delivered: "1", retries: "1", dropped: "0" });
  });
});
