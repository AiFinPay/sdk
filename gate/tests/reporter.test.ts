import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGateReporter, createGate, MemoryStore } from "../src/index.js";
import { issuer, req } from "./helpers.js";
import type { GateReporter } from "../src/index.js";
const options = { merchantId: "mrch_0123456789abcdef", merchantSecret: "test-secret" };
let reporters: GateReporter[];
const make = () => {
  const reporter = createGateReporter(options);
  reporters.push(reporter);
  return reporter;
};
const ok = (count: number, duplicates = 0) =>
  new Response(JSON.stringify({ accepted: count - duplicates, duplicates }));
beforeEach(() => {
  reporters = [];
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_url, init) => ok(JSON.parse(init.body as string).events.length))
  );
  await Promise.all(reporters.map((reporter) => reporter.close()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("opt-in gate reporter", () => {
  it("sends only allowed fields, excludes exempt/other events, batches and shares mounts", async () => {
    const request = vi.fn(async (_url, init) => ok(JSON.parse(init.body as string).events.length));
    vi.stubGlobal("fetch", request);
    const reporter = make();
    reporter.onEvent({ kind: "serve", resource: "/human", weight: 1, exempt: true });
    reporter.onEvent({ kind: "403", resource: "/api", weight: 1 });
    for (let i = 0; i < 51; i++)
      reporter.onEvent({
        kind: "402",
        resource: "/api/*",
        weight: 1,
        agent: "private-agent",
        receipt_id: "private-receipt",
        detail: "private-content",
      });
    expect(request).not.toHaveBeenCalled();
    await reporter.flush();
    expect(request).toHaveBeenCalledTimes(2);
    const [url, init] = request.mock.calls[0];
    expect(url).toBe("https://api.aifinpay.io/v1/merchants/mrch_0123456789abcdef/gate-events");
    expect(init.redirect).toBe("manual");
    expect(init.headers["AIFP-Merchant-Secret"]).toBe("test-secret");
    const events = JSON.parse(init.body as string).events;
    expect(events).toHaveLength(50);
    expect(Object.keys(events[0]).sort()).toEqual(["at", "id", "kind", "resource"]);
    expect(events[0].id).toMatch(/^[0-9a-f-]{36}$/);
    expect(events[0].at).toMatch(/Z$/);
    expect(JSON.stringify(reporter)).not.toContain("test-secret");
    expect(reporter.stats.delivered).toBe(51);
    for (const resource of ["/a", "/b"]) {
      const gate = createGate({
        merchantId: options.merchantId,
        resource,
        store: new MemoryStore(),
        onEvent: reporter.onEvent,
      });
      expect((await gate({ path: resource, header: () => undefined })).status).toBe(402);
    }
    expect(reporter.stats.queued).toBe(2);
  });
  it("retains identical IDs after ambiguous failure and acknowledges duplicates", async () => {
    const request = vi.fn().mockRejectedValueOnce(new Error("secret server text")).mockResolvedValueOnce(ok(1, 1));
    vi.stubGlobal("fetch", request);
    const reporter = make();
    reporter.onEvent({ kind: "serve", resource: "/api", weight: 1 });
    await reporter.flush();
    expect(reporter.stats).toMatchObject({ queued: 1, retries: 1, lastError: "network" });
    await reporter.flush();
    expect(request.mock.calls[0][1].body).toBe(request.mock.calls[1][1].body);
    expect(reporter.stats).toMatchObject({ queued: 0, delivered: 1, lastError: null });
  });
  it("bounds queue, expires old events, and never changes gate results", async () => {
    const reporter = make();
    for (let i = 0; i < 1002; i++) reporter.onEvent({ kind: "402", resource: "/api", weight: 1 });
    expect(reporter.stats).toMatchObject({ queued: 1000, dropped: 2, lastError: "queue_full" });
    const gate = createGate({
      merchantId: options.merchantId,
      resource: "/api",
      store: new MemoryStore(),
      onEvent: reporter.onEvent,
    });
    expect((await gate({ path: "/api", header: () => undefined })).status).toBe(402);
    expect(reporter.stats.dropped).toBe(3);
    vi.setSystemTime(Date.now() + 15 * 60_000);
    reporter.onEvent({ kind: "402", resource: "/fresh", weight: 1 });
    expect(reporter.stats).toMatchObject({ queued: 1, dropped: 1003, lastError: "expired" });
  });
  it("does not report real human exemption callbacks", async () => {
    const reporter = make();
    const gate = createGate({
      merchantId: options.merchantId,
      resource: "/api",
      shouldCharge: () => false,
      store: new MemoryStore(),
      onEvent: reporter.onEvent,
    });
    expect((await gate({ path: "/api", header: () => undefined })).status).toBe(200);
    expect(reporter.stats.queued).toBe(0);
  });
  it("counts in-flight events toward queue capacity", async () => {
    let release!: (response: Response) => void;
    const request = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<Response>((resolve) => {
            release = resolve;
          })
      )
      .mockImplementation(async (_url, init) => ok(JSON.parse(init.body as string).events.length));
    vi.stubGlobal("fetch", request);
    const reporter = make();
    for (let i = 0; i < 1000; i++) reporter.onEvent({ kind: "402", resource: "/api", weight: 1 });
    const pending = reporter.flush();
    reporter.onEvent({ kind: "402", resource: "/api", weight: 1 });
    expect(reporter.stats).toMatchObject({ queued: 1000, dropped: 1 });
    release(ok(50));
    await pending;
    expect(reporter.stats).toMatchObject({ delivered: 1000, queued: 0, dropped: 1 });
  });
  it("outage does not change verified paid quota or downstream admission", async () => {
    const request = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", request);
    const reporter = make();
    const iss = await issuer();
    const token = await iss.sign({ aud: options.merchantId, unit_quota: 2 });
    const gate = createGate({
      merchantId: options.merchantId,
      resource: "/api/search",
      jwks: iss.jwks,
      store: new MemoryStore(),
      onEvent: reporter.onEvent,
    });
    const call = () => gate(req("/api/search", { "AIFP-Receipt": token }));
    const first = await call();
    expect(first.status).toBe(200);
    if (first.ok) expect(first.aifp.remaining).toBe(1);
    await reporter.flush();
    const second = await call();
    expect(second.status).toBe(200);
    if (second.ok) expect(second.aifp.remaining).toBe(0);
    expect((await call()).status).toBe(402);
  });
  it("caps response bytes and preserves retry identity on malformed acknowledgements", async () => {
    const request = vi.fn(async () => new Response("x".repeat(4097)));
    vi.stubGlobal("fetch", request);
    const reporter = make();
    reporter.onEvent({ kind: "402", resource: "/api", weight: 1 });
    await reporter.flush();
    expect(reporter.stats).toMatchObject({ queued: 1, lastError: "invalid_response" });
    await reporter.flush();
    expect(request.mock.calls[0][1].body).toBe(request.mock.calls[1][1].body);
  });
  it.each([401, 403, 400, 302, 307])("stops permanently after HTTP %i without following redirects", async (status) => {
    const request = vi.fn(
      async () => new Response(null, { status, headers: { location: "https://attacker.invalid" } })
    );
    vi.stubGlobal("fetch", request);
    const reporter = make();
    reporter.onEvent({ kind: "402", resource: "/api", weight: 1 });
    await reporter.flush();
    reporter.onEvent({ kind: "402", resource: "/api", weight: 1 });
    await reporter.flush();
    expect(request).toHaveBeenCalledTimes(1);
    expect(reporter.stats).toMatchObject({ stopped: true, dropped: 2, queued: 0 });
  });
  it("has finite retries and discards unsent events on close", async () => {
    const request = vi.fn(async () => new Response(null, { status: 503 }));
    vi.stubGlobal("fetch", request);
    const reporter = make();
    reporter.onEvent({ kind: "402", resource: "/api", weight: 1 });
    for (let i = 0; i < 5; i++) await reporter.flush();
    expect(request).toHaveBeenCalledTimes(5);
    expect(reporter.stats).toMatchObject({ queued: 0, dropped: 1, lastError: "retry_exhausted" });
    reporter.onEvent({ kind: "402", resource: "/other", weight: 1 });
    await reporter.close();
    expect(reporter.stats).toMatchObject({ queued: 0, closed: true, dropped: 2, lastError: "shutdown" });
  });
  it("isolates timeouts and safely retries in the background", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener("abort", () => reject(new Error("secret timeout")));
          })
      )
    );
    const reporter = make();
    reporter.onEvent({ kind: "402", resource: "/api", weight: 1 });
    const pending = reporter.flush();
    await vi.advanceTimersByTimeAsync(3000);
    await pending;
    expect(reporter.stats).toMatchObject({ queued: 1, lastError: "timeout", retries: 1 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(reporter.stats.retries).toBe(2);
  });
  it.each([
    "/api?secret=x",
    "https://host/api",
    "/api#x",
    "/api/../x",
    "//host",
    "/a%2Fb",
    "/bad\\x",
    "/café",
    "/a+b",
    "/" + "x".repeat(512),
  ])("rejects invalid resource %s without changing identity", (resource) => {
    const reporter = make();
    reporter.onEvent({ kind: "402", resource, weight: 1 });
    expect(reporter.stats).toMatchObject({ queued: 0, dropped: 1, lastError: "invalid_event" });
  });
  it.each([
    "http://api.aifinpay.io",
    "https://user:pass@host",
    "https://host/api",
    "https://host?x=y",
    "https://host#x",
  ])("rejects unsafe apiBase %s", (apiBase) => {
    expect(() => createGateReporter({ ...options, apiBase })).toThrow("HTTPS origin");
  });
});
