import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGate, createGateReporter, MemoryStore } from "../src/index.js";
import type { GateReporter } from "../src/index.js";
import { issuer, req } from "./helpers.js";

const vectors = JSON.parse(
  readFileSync(
    resolve(dirname(fileURLToPath(import.meta.url)), "../../conformance/vectors/receipt-use-v1.json"),
    "utf8"
  )
) as {
  path: string;
  auth_header: string;
  vectors: { name: string; spends: { receipt_id: unknown; remaining: unknown }[]; bodies: string[] }[];
};

const merchantId = "mrch_0123456789abcdef";
const USE_URL = `https://api.aifinpay.io/v1/merchants/${merchantId}/receipt-use`;
const EVENTS_URL = `https://api.aifinpay.io/v1/merchants/${merchantId}/gate-events`;
const RECEIPT = "rcpt_00000000000000c4";

type Call = [string, RequestInit];
const answer = (url: string, init: RequestInit) =>
  url.endsWith("/receipt-use")
    ? new Response(JSON.stringify({ applied: JSON.parse(init.body as string).uses.length, ignored: 0 }))
    : new Response(JSON.stringify({ accepted: JSON.parse(init.body as string).events.length, duplicates: 0 }));
const useCalls = (fetch: { mock: { calls: unknown[][] } }) =>
  (fetch.mock.calls as Call[]).filter(([url]) => url === USE_URL);

let reporters: GateReporter[];
const make = () => {
  const reporter = createGateReporter({ merchantId, merchantSecret: "test-secret" });
  reporters.push(reporter);
  return reporter;
};
const spend = (reporter: GateReporter, receipt_id: unknown, remaining: unknown) =>
  reporter.onEvent({ kind: "serve", resource: "/api", weight: 1, receipt_id, remaining } as never);

beforeEach(() => {
  reporters = [];
  vi.useFakeTimers();
});
afterEach(async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init: RequestInit) => answer(url, init))
  );
  await Promise.all(reporters.map((reporter) => reporter.close()));
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function paidGate(reporter: GateReporter, unit_quota = 40) {
  const iss = await issuer();
  const token = await iss.sign({ aud: merchantId, unit_quota, receipt_id: RECEIPT });
  const gate = createGate({
    merchantId,
    resource: "/api/search",
    jwks: iss.jwks,
    store: new MemoryStore(),
    onEvent: reporter.onEvent,
  });
  return { token, call: () => gate(req("/api/search", { "AIFP-Receipt": token })) };
}

describe("receipt use", () => {
  it("a paid spend holds one use with the remaining and the flush sends the exact body with auth", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => answer(url, init));
    vi.stubGlobal("fetch", request);
    const reporter = make();
    const { token, call } = await paidGate(reporter);
    const result = await call();
    expect(result.status).toBe(200);
    expect(reporter.stats.uses.queued).toBe(1);
    await reporter.flush();
    const calls = useCalls(request);
    expect(calls).toHaveLength(1);
    const [, init] = calls[0];
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("manual");
    expect((init.headers as Record<string, string>)["AIFP-Merchant-Secret"]).toBe("test-secret");
    expect(init.body).toBe(`{"uses":[{"receipt_id":"${RECEIPT}","remaining":39}]}`);
    expect(init.body).not.toContain(token);
    expect(reporter.stats.uses).toEqual({ queued: 0, delivered: 1, dropped: 0, lastError: null });
  });

  it("two spends of one receipt send one item with the lowest remaining", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => answer(url, init));
    vi.stubGlobal("fetch", request);
    const reporter = make();
    const { call } = await paidGate(reporter);
    await call();
    await call();
    spend(reporter, RECEIPT, 39);
    expect(reporter.stats.uses.queued).toBe(1);
    await reporter.flush();
    expect(useCalls(request).map(([, init]) => init.body)).toEqual([
      `{"uses":[{"receipt_id":"${RECEIPT}","remaining":38}]}`,
    ]);
  });

  it.each(vectors.vectors.map((vector) => [vector.name, vector] as const))(
    "vector %s: the flush sends the vector's bodies byte for byte",
    async (_name, vector) => {
      const request = vi.fn(async (url: string, init: RequestInit) => answer(url, init));
      vi.stubGlobal("fetch", request);
      const reporter = make();
      for (const { receipt_id, remaining } of vector.spends) spend(reporter, receipt_id, remaining);
      await reporter.flush();
      const calls = useCalls(request);
      expect(calls.map(([, init]) => init.body)).toEqual(vector.bodies);
      for (const [url, init] of calls) {
        expect(url).toBe(`https://api.aifinpay.io${vectors.path.replace("{merchant_id}", merchantId)}`);
        expect((init.headers as Record<string, string>)[vectors.auth_header]).toBe("test-secret");
      }
    }
  );

  it("404 drops what is held without throwing, leaves pages and gate events alone, and the next spend tries again", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) =>
      url === USE_URL ? new Response(JSON.stringify({ error: "not_found" }), { status: 404 }) : answer(url, init)
    );
    vi.stubGlobal("fetch", request);
    const reporter = make();
    const { call } = await paidGate(reporter);
    expect((await call()).status).toBe(200);
    reporter.onEvent({ kind: "402", resource: "/api", weight: 1 });
    await expect(reporter.flush()).resolves.toBeTruthy();
    expect(reporter.stats.uses).toEqual({ queued: 0, delivered: 0, dropped: 1, lastError: "rejected" });
    expect(reporter.stats).toMatchObject({ stopped: false, delivered: 2, queued: 0, lastError: null });
    expect(useCalls(request)).toHaveLength(1);
    // No retry loop: nothing more is sent until the next spend.
    await vi.advanceTimersByTimeAsync(120_000);
    expect(useCalls(request)).toHaveLength(1);
    const again = await call();
    expect(again.status).toBe(200);
    if (again.ok) expect(again.aifp.remaining).toBe(38);
    await vi.advanceTimersByTimeAsync(1000);
    expect(useCalls(request)).toHaveLength(2);
    expect((request.mock.calls as Call[]).filter(([url]) => url === EVENTS_URL).length).toBeGreaterThan(0);
  });

  it("a failed send is caught: flush resolves, the page is served, the use stays for a bounded retry", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => {
      if (url === USE_URL) throw new Error("connection refused");
      return answer(url, init);
    });
    vi.stubGlobal("fetch", request);
    const reporter = make();
    const { call } = await paidGate(reporter);
    expect((await call()).status).toBe(200);
    await expect(reporter.flush()).resolves.toMatchObject({ uses: { queued: 1, lastError: "network" } });
    const second = await call();
    expect(second.status).toBe(200);
    for (let i = 0; i < 6; i++) await reporter.flush();
    expect(reporter.stats.uses).toMatchObject({ queued: 0, dropped: 1, lastError: "retry_exhausted" });
    expect(useCalls(request)).toHaveLength(5);
  });

  it("5xx keeps the use and the scheduled retry delivers it", async () => {
    let fail = true;
    const request = vi.fn(async (url: string, init: RequestInit) =>
      url === USE_URL && fail ? new Response(null, { status: 503 }) : answer(url, init)
    );
    vi.stubGlobal("fetch", request);
    const reporter = make();
    spend(reporter, RECEIPT, 7);
    await vi.advanceTimersByTimeAsync(1000);
    expect(reporter.stats.uses).toMatchObject({ queued: 1, lastError: "server" });
    fail = false;
    await vi.advanceTimersByTimeAsync(2000);
    expect(reporter.stats.uses).toEqual({ queued: 0, delivered: 1, dropped: 0, lastError: null });
    expect(useCalls(request).map(([, init]) => init.body)).toEqual([
      `{"uses":[{"receipt_id":"${RECEIPT}","remaining":7}]}`,
      `{"uses":[{"receipt_id":"${RECEIPT}","remaining":7}]}`,
    ]);
  });

  it("no merchant secret, no reporter: a spend sends nothing", async () => {
    const request = vi.fn(async (url: string, init: RequestInit) => answer(url, init));
    vi.stubGlobal("fetch", request);
    expect(() => createGateReporter({ merchantId, merchantSecret: "" })).toThrow();
    const iss = await issuer();
    const token = await iss.sign({ aud: merchantId, unit_quota: 3, receipt_id: RECEIPT });
    const gate = createGate({ merchantId, resource: "/api/search", jwks: iss.jwks, store: new MemoryStore() });
    expect((await gate(req("/api/search", { "AIFP-Receipt": token }))).status).toBe(200);
    await vi.advanceTimersByTimeAsync(5000);
    expect(request).not.toHaveBeenCalled();
  });

  it("a shadow serve, an exempt serve and a token-shaped id record nothing", async () => {
    const reporter = make();
    const iss = await issuer();
    const token = await iss.sign({ aud: merchantId, unit_quota: 3, receipt_id: RECEIPT });
    const shadow = createGate({
      merchantId,
      resource: "/api/search",
      jwks: iss.jwks,
      store: new MemoryStore(),
      mode: "shadow",
      onEvent: reporter.onEvent,
    });
    expect((await shadow(req("/api/search", { "AIFP-Receipt": token }))).status).toBe(200);
    reporter.onEvent({ kind: "serve", resource: "/api", weight: 1, exempt: true });
    spend(reporter, token, 2);
    expect(reporter.stats.uses.queued).toBe(0);
  });

  it("a use recorded after close is dropped and close drops what it could not send", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(null, { status: 503 }))
    );
    const reporter = make();
    spend(reporter, RECEIPT, 3);
    await reporter.close();
    spend(reporter, RECEIPT, 2);
    expect(reporter.stats.uses).toEqual({ queued: 0, delivered: 0, dropped: 2, lastError: "shutdown" });
  });
});
