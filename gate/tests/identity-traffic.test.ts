// Gate identity on every merchant-secret request and the traffic summary sender, against the shared vectors.
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AifpMerchant,
  createGate,
  createGateReporter,
  createGateReporterV2,
  createReaderProof,
  GATE_VERSION,
  knownAiAgent,
  MemoryStore,
  ResourceRegistry,
  unprovenPays,
} from "../src/index.js";
import type { GateReporter } from "../src/index.js";
import { chargeOf, gateHeaders } from "../src/identity.js";
import {
  counted,
  countryOf,
  createTrafficSender,
  edgeCounted,
  networkOf,
  sectionOf,
  TrafficTally,
  type TrafficClock,
  type TrafficRecord,
} from "../src/traffic.js";
import { issuer, req } from "./helpers.js";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name: string) => JSON.parse(readFileSync(resolve(here, "../../conformance/vectors", name), "utf8"));
const identity = read("gate-identity-v1.json");
const traffic = read("gate-traffic-v1.json");

const merchantId = "mrch_0123456789abcdef";
const API = `https://api.aifinpay.io/v1/merchants/${merchantId}`;
const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const BROWSER = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/124.0 Safari/537.36";
const PARSE = (header: string) => Object.fromEntries(header.split("; ").map((part) => part.split("=")));

type Call = { url: string; headers: Record<string, string>; body: string };
function stubApi(status: (url: string) => number = () => 200) {
  const calls: Call[] = [];
  const fetchMock = vi.fn(async (url: string, init: RequestInit) => {
    const body = String(init.body ?? "");
    calls.push({ url, headers: { ...(init.headers as Record<string, string>) }, body });
    const code = status(url);
    if (code !== 200) return new Response("{}", { status: code });
    if (url.includes("/v2/")) {
      return new Response(
        JSON.stringify({
          version: 2,
          accepted: JSON.parse(body).events.length,
          duplicates: 0,
          received_at: new Date().toISOString(),
        })
      );
    }
    if (url.endsWith("/gate-events")) {
      const n = JSON.parse(body).events.length;
      return new Response(JSON.stringify({ accepted: n, duplicates: 0 }));
    }
    if (url.endsWith("/receipt-use")) {
      const n = JSON.parse(body).uses.length;
      return new Response(JSON.stringify({ applied: n, ignored: 0 }));
    }
    if (url.endsWith("/resources")) return new Response(JSON.stringify({ resources: [] }));
    if (url.endsWith(`/merchants/${merchantId}`)) return new Response(JSON.stringify({ merchant_id: merchantId }));
    return new Response(JSON.stringify({ accepted: true, duplicate: false, rows: 1, skipped: 0 }));
  });
  vi.stubGlobal("fetch", fetchMock);
  return calls;
}

const reporters: { close(): Promise<unknown> }[] = [];
const newReporter = () => {
  const r = createGateReporter({ merchantId, merchantSecret: "test-secret" });
  reporters.push(r);
  return r;
};
afterEach(async () => {
  stubApi();
  for (const r of reporters.splice(0)) await r.close();
  vi.unstubAllGlobals();
});

describe("gate identity", () => {
  it("the version is the manifest's", () => {
    const manifest = JSON.parse(readFileSync(resolve(here, "../package.json"), "utf8"));
    expect(GATE_VERSION).toBe(manifest.version);
  });

  it("formats every vector exactly", () => {
    for (const v of identity.format) {
      expect(gateHeaders(v.input), v.name).toEqual({ "User-Agent": v.user_agent, "AIFP-Gate": v.header });
    }
  });

  it("names the charge rule: agents, unproven, everyone, custom", () => {
    const proof = createReaderProof({ key: "k".repeat(32) });
    expect(chargeOf(knownAiAgent)).toBe("agents");
    expect(chargeOf(unprovenPays({ readerProof: proof }))).toBe("unproven");
    expect(chargeOf(undefined)).toBe("everyone");
    expect(chargeOf((r: unknown) => knownAiAgent(r as never))).toBe("custom");
  });

  it("the gate sends its own mode, charge and platform", async () => {
    const calls = stubApi();
    const cases = [
      [knownAiAgent, "agents"],
      [unprovenPays({ readerProof: createReaderProof({ key: "k".repeat(32) }) }), "unproven"],
      [undefined, "everyone"],
      [() => true, "custom"],
    ] as const;
    for (const [shouldCharge, charge] of cases) {
      const reporter = newReporter();
      const gate = createGate({
        merchantId,
        resource: "/api",
        mode: "shadow",
        shouldCharge,
        onEvent: reporter.onEvent,
      });
      await gate(req("/api", { "User-Agent": GPTBOT }));
      await reporter.flush();
      const sent = calls.filter((c) => c.url.endsWith("/gate-events")).at(-1)!;
      expect(PARSE(sent.headers["AIFP-Gate"])).toEqual({
        pkg: "node",
        ver: GATE_VERSION,
        platform: "node",
        mode: "shadow",
        charge,
      });
      expect(sent.headers["User-Agent"]).toBe(`aifinpay-gate-node/${GATE_VERSION}`);
    }
  });

  it("is on all five kinds of merchant-secret request", async () => {
    const calls = stubApi();
    const merchant = new AifpMerchant({ merchantId, secret: "test-secret", retries: 0 });
    const registry = new ResourceRegistry({ merchant, refreshMs: 3_600_000 });
    const reporter = newReporter();
    const v2 = createGateReporterV2({
      version: 2,
      merchantId,
      merchantSecret: "test-secret",
      supported: ["access_challenged"],
    });
    reporters.push(v2);
    const iss = await issuer();
    const token = await iss.sign({
      aud: merchantId,
      unit_quota: 5,
      receipt_id: "rcpt_00000000000000c4",
      resource: "/api/x",
    });
    const gate = createGate({
      merchantId,
      registry,
      registryUnavailable: "mount-default",
      jwks: iss.jwks,
      store: new MemoryStore(),
      onEvent: reporter.onEvent,
    });
    createGate({ merchantId, resource: "/v2", reporting: { version: 2, reporter: v2 } });
    await registry.refresh();
    expect((await gate(req("/api/x", { "User-Agent": GPTBOT }))).status).toBe(402);
    expect((await gate(req("/api/x", { "AIFP-Receipt": token }))).status).toBe(200);
    await reporter.flush();
    await reporter.flushTraffic();
    v2.observe({
      name: "access_challenged",
      resource: "/v2",
      channel: "api",
      consent: "denied",
      reason: "receipt_missing",
    });
    await v2.flush();
    const kinds = ["/resources", "/gate-events", "/receipt-use", "/gate-traffic", "/v2/merchants"];
    for (const kind of kinds) {
      const hits = calls.filter((c) => c.url.includes(kind));
      expect(hits.length, kind).toBeGreaterThan(0);
      for (const hit of hits) {
        expect(hit.headers["AIFP-Gate"], kind).toMatch(
          /^pkg=node; ver=[0-9.]+; platform=node; mode=enforce; charge=everyone$/
        );
        expect(hit.headers["User-Agent"], kind).toBe(`aifinpay-gate-node/${GATE_VERSION}`);
      }
    }
  });

  it("an Express mount says express", async () => {
    const calls = stubApi();
    const { aifpGate } = await import("../src/express.js");
    const reporter = newReporter();
    const handler = aifpGate({ merchantId, resource: "/api", onEvent: reporter.onEvent });
    await new Promise<void>((done) => {
      const res = {
        set: () => res,
        append: () => res,
        status: () => res,
        json: () => done(),
        once: () => res,
        getHeader: () => undefined,
        setHeader: () => undefined,
        writeHead: () => res,
      };
      handler(
        {
          baseUrl: "",
          path: "/api",
          header: (n: string) => (n.toLowerCase() === "user-agent" ? GPTBOT : undefined),
        } as never,
        res as never,
        done
      );
    });
    await reporter.flush();
    const sent = calls.find((c) => c.url.endsWith("/gate-events"))!;
    expect(PARSE(sent.headers["AIFP-Gate"]).platform).toBe("express");
  });
});

describe("traffic summary rules", () => {
  it("sections, counted, countries and networks as the vectors say", () => {
    for (const v of traffic.sections) expect(sectionOf(v.target), v.target).toBe(v.section);
    for (const v of traffic.counted) expect(counted(v.target, v.outcome), `${v.target} ${v.outcome}`).toBe(v.counted);
    for (const v of traffic.countries) expect(countryOf(v.value), JSON.stringify(v.value)).toBe(v.country);
    for (const v of traffic.networks) expect(networkOf(v.value), JSON.stringify(v.value)).toBe(v.network);
  });

  it("builds every vector body byte for byte", () => {
    for (const v of traffic.build) {
      const tally = new TrafficTally();
      for (const r of v.requests) {
        tally.add(
          {
            ...r,
            country: v.platform.country ? r.country : undefined,
            network: v.platform.network ? r.network : undefined,
          },
          r.n ?? 1
        );
      }
      expect(tally.body(v.window), v.name).toBe(v.body);
    }
  });

  it("an edge-counted request as the vectors say, its field lines joined as Node joins them", () => {
    const joined = (lines: string[] | undefined) => (lines?.length ? lines.join(", ") : undefined);
    for (const v of traffic.edge_counted.values) expect(edgeCounted(joined(v.lines)), v.name).toBe(v.edge_counted);
    for (const v of traffic.edge_counted.build) {
      const tally = new TrafficTally();
      for (const r of v.requests) if (!edgeCounted(joined(r.edge_counted))) tally.add(r, r.n ?? 1);
      expect(tally.body(v.window), v.name).toBe(v.body);
    }
  });
});

describe("traffic from the gate", () => {
  const contentGate = (reporter: GateReporter, extra = {}) =>
    createGate({ merchantId, resource: "/blog", shouldCharge: knownAiAgent, onEvent: reporter.onEvent, ...extra });
  const windows = (calls: Call[]) =>
    calls.filter((c) => c.url.endsWith("/gate-traffic")).map((c) => JSON.parse(c.body));

  it("counts a reader in the summary and never forwards it as an event", async () => {
    const calls = stubApi();
    const reporter = newReporter();
    const gate = contentGate(reporter);
    expect((await gate(req("/blog/a-title", { "User-Agent": BROWSER }))).status).toBe(200);
    expect((await gate(req("/blog/a-title", { "User-Agent": GPTBOT }))).status).toBe(402);
    await reporter.flush();
    const events = calls.filter((c) => c.url.endsWith("/gate-events")).flatMap((c) => JSON.parse(c.body).events);
    expect(events.map((e: { kind: string; ua_class: string }) => [e.kind, e.ua_class])).toEqual([
      ["402", "ai_crawler"],
    ]);
    await reporter.flushTraffic();
    const [w] = windows(calls);
    expect(w.classes).toEqual([
      ["ai_crawler", "challenged", 1],
      ["human", "served", 1],
    ]);
    expect(w.operators).toEqual([["openai", "ai_crawler", "challenged", 1]]);
    expect(w.sections).toEqual([["/blog", "ai_crawler", 1]]);
    expect(w.countries).toEqual([
      ["ZZ", "ai_crawler", 1],
      ["ZZ", "human", 1],
    ]);
    expect(w.networks).toBeUndefined();
    expect(JSON.stringify(w)).not.toContain("a-title");
    expect(Object.keys(w)).toEqual([
      "v",
      "id",
      "from",
      "to",
      "mode",
      "charge",
      "sample",
      "classes",
      "operators",
      "sections",
      "countries",
    ]);
    expect([w.mode, w.charge]).toEqual(["enforce", "agents"]);
  });

  it("counts an unregistered path a registry gate decides", async () => {
    const calls = stubApi((url) => (url.endsWith("/resources") ? 503 : 200));
    const merchant = new AifpMerchant({ merchantId, secret: "test-secret", retries: 0 });
    const registry = new ResourceRegistry({ merchant, refreshMs: 3_600_000 });
    const reporter = newReporter();
    const gate = createGate({ merchantId, registry, shouldCharge: knownAiAgent, onEvent: reporter.onEvent });
    await gate(req("/docs/page", { "User-Agent": BROWSER }));
    await reporter.flushTraffic();
    expect(windows(calls)[0].classes).toEqual([["human", "served", 1]]);
  });

  it("does not count an asset served free", async () => {
    const calls = stubApi();
    const reporter = newReporter();
    const gate = contentGate(reporter);
    await gate(req("/blog/app.js", { "User-Agent": BROWSER }));
    await gate(req("/blog/logo.PNG", { "User-Agent": BROWSER }));
    await reporter.flushTraffic();
    expect(windows(calls)).toEqual([]);
    await gate(req("/blog/app.js", { "User-Agent": GPTBOT }));
    await reporter.flushTraffic();
    expect(windows(calls)[0].classes).toEqual([["ai_crawler", "challenged", 1]]);
  });

  it("reads country and network only from the headers the site names, never a network for a reader", async () => {
    const calls = stubApi();
    const reporter = newReporter();
    const gate = contentGate(reporter, { countryHeader: "x-country", networkHeader: "x-asn" });
    await gate(req("/blog/a", { "User-Agent": BROWSER, "x-country": "de", "x-asn": "3320", "cf-ipcountry": "US" }));
    await gate(req("/blog/a", { "User-Agent": GPTBOT, "x-country": "US", "x-asn": "AS8075" }));
    await reporter.flushTraffic();
    const [w] = windows(calls);
    expect(w.countries).toEqual([
      ["DE", "human", 1],
      ["US", "ai_crawler", 1],
    ]);
    expect(w.networks).toEqual([["AS8075", "ai_crawler", 1]]);
  });

  it("countryHeader null sends no countries", async () => {
    const calls = stubApi();
    const reporter = newReporter();
    const gate = contentGate(reporter, { countryHeader: null });
    await gate(req("/blog/a", { "User-Agent": BROWSER, "cf-ipcountry": "US" }));
    await reporter.flushTraffic();
    expect(windows(calls)[0].countries).toBeUndefined();
  });

  it("shadow reports the decision it served past, and a paid admission is paid", async () => {
    const calls = stubApi();
    const reporter = newReporter();
    const iss = await issuer();
    const token = await iss.sign({
      aud: merchantId,
      unit_quota: 5,
      receipt_id: "rcpt_00000000000000c5",
      resource: "/blog",
    });
    const shadow = createGate({
      merchantId,
      resource: "/blog",
      mode: "shadow",
      jwks: iss.jwks,
      onEvent: reporter.onEvent,
    });
    expect((await shadow(req("/blog/a", { "User-Agent": GPTBOT }))).status).toBe(200);
    expect((await shadow(req("/blog/a", { "AIFP-Receipt": token }))).status).toBe(200);
    await reporter.flushTraffic();
    const [w] = windows(calls);
    expect(w.classes).toEqual([
      ["ai_crawler", "challenged", 1],
      ["aifp_agent", "paid", 1],
    ]);
    expect(w.mode).toBe("shadow");
  });

  it("an edge-counted request is answered and reported as without the header, and left out of the summary", async () => {
    const iss = await issuer();
    const token = await iss.sign({ aud: merchantId, unit_quota: 5, receipt_id: "rcpt_00000000000000c7", resource: "/blog" });
    const run = async (extra: Record<string, string>) => {
      const calls = stubApi();
      const reporter = newReporter();
      const gate = contentGate(reporter, { jwks: iss.jwks, store: new MemoryStore() });
      const answers = [];
      for (const headers of [{ "User-Agent": BROWSER }, { "User-Agent": GPTBOT }, { "AIFP-Receipt": token }, { "AIFP-Receipt": token }]) {
        answers.push(JSON.stringify(await gate(req("/blog/a", { ...headers, ...extra }))));
      }
      await reporter.flush();
      await reporter.flushTraffic();
      const events = calls
        .filter((c) => c.url.endsWith("/gate-events"))
        .flatMap((c) => JSON.parse(c.body).events)
        .map(({ id: _id, at: _at, ...e }: Record<string, unknown>) => e);
      return { answers, events, windows: windows(calls) };
    };
    const marked = await run({ "AIFP-Edge-Counted": "1" });
    const plain = await run({});
    expect(marked.answers).toEqual(plain.answers);
    expect(JSON.parse(marked.answers[1]).status).toBe(402);
    expect(marked.events).toEqual(plain.events);
    expect(marked.events.map((e: { kind: string }) => e.kind)).toEqual(["402", "serve", "serve"]);
    expect(marked.windows).toEqual([]);
    expect(plain.windows[0].classes).toEqual([
      ["ai_crawler", "challenged", 1],
      ["aifp_agent", "paid", 2],
      ["human", "served", 1],
    ]);
  });

  it("only one value of exactly 1 leaves a request out of the summary", async () => {
    const calls = stubApi();
    const reporter = newReporter();
    const gate = contentGate(reporter);
    const left = ["1", " 1 ", "\t1"];
    const kept = ["0", "true", "", "1, 1", "1,", "01", "yes"];
    for (const value of [...left, ...kept]) {
      expect((await gate(req("/blog/a", { "User-Agent": GPTBOT, "aifp-edge-counted": value }))).status).toBe(402);
    }
    await gate(req("/blog/a", { "User-Agent": GPTBOT }));
    await reporter.flushTraffic();
    expect(windows(calls)[0].classes).toEqual([["ai_crawler", "challenged", kept.length + 1]]);
  });

  it("traffic: false sends nothing", async () => {
    const calls = stubApi();
    const reporter = newReporter();
    const gate = contentGate(reporter, { traffic: false });
    await gate(req("/blog/a", { "User-Agent": GPTBOT }));
    await reporter.flushTraffic();
    await reporter.close();
    expect(windows(calls)).toEqual([]);
    expect(calls.filter((c) => c.url.endsWith("/gate-events"))).toHaveLength(1);
  });

  it("a 404 from the traffic route leaves events, receipt use and serving untouched", async () => {
    const calls = stubApi((url) => (url.endsWith("/gate-traffic") ? 404 : 200));
    const reporter = newReporter();
    const iss = await issuer();
    const token = await iss.sign({
      aud: merchantId,
      unit_quota: 5,
      receipt_id: "rcpt_00000000000000c6",
      resource: "/blog",
    });
    const gate = contentGate(reporter, { jwks: iss.jwks, store: new MemoryStore() });
    await gate(req("/blog/a", { "User-Agent": GPTBOT }));
    await reporter.flushTraffic();
    expect(reporter.stats.traffic.pausedUntil).not.toBeNull();
    expect((await gate(req("/blog/a", { "User-Agent": GPTBOT }))).status).toBe(402);
    expect((await gate(req("/blog/a", { "User-Agent": BROWSER }))).status).toBe(200);
    expect((await gate(req("/blog/a", { "AIFP-Receipt": token }))).status).toBe(200);
    await reporter.flush();
    await reporter.flushTraffic();
    expect(reporter.stats.stopped).toBe(false);
    expect(reporter.stats.delivered).toBe(3);
    expect(reporter.stats.uses.delivered).toBe(1);
    expect(calls.filter((c) => c.url.endsWith("/gate-traffic"))).toHaveLength(1);
    // And the other way round: a refused event batch leaves traffic sending.
    const calls2 = stubApi((url) => (url.endsWith("/gate-events") ? 401 : 200));
    const other = newReporter();
    const gate2 = contentGate(other);
    await gate2(req("/blog/a", { "User-Agent": GPTBOT }));
    await other.flush();
    expect(other.stats.stopped).toBe(true);
    await gate2(req("/blog/a", { "User-Agent": GPTBOT }));
    await other.flushTraffic();
    expect(windows(calls2)[0].classes).toEqual([["ai_crawler", "challenged", 2]]);
  });
});

describe("traffic sender", () => {
  function fakeClock(start = 0) {
    let now = start;
    const timers = new Map<number, { at: number; fn: () => void }>();
    let next = 1;
    const clock: TrafficClock = {
      now: () => now,
      setTimeout: (fn, ms) => {
        timers.set(next, { at: now + ms, fn });
        return next++;
      },
      clearTimeout: (h) => void timers.delete(h as number),
    };
    const advance = (to: number) => {
      now = to;
      for (const [h, t] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (t.at <= now && timers.has(h)) {
          timers.delete(h);
          t.fn();
        }
      }
    };
    return { clock, advance, set: (to: number) => void (now = to) };
  }
  const agentHit = (target = "/blog/a"): TrafficRecord => ({
    target,
    ua_class: "ai_crawler",
    operator: "openai",
    outcome: "challenged",
    mode: "enforce",
    charge: "agents",
  });
  const senderWith = (answers: (number | "none")[], start = 0) => {
    const c = fakeClock(start);
    const bodies: string[] = [];
    const fetchMock = vi.fn(async (_url: string, init: RequestInit) => {
      bodies.push(String(init.body));
      const a = answers.shift() ?? "none";
      if (a === "none") throw new Error("no answer");
      return new Response("{}", { status: a });
    });
    const sender = createTrafficSender({
      endpoint: `${API}/gate-traffic`,
      secret: "s",
      headers: () => ({}),
      clock: c.clock,
      fetch: fetchMock as never,
    });
    return { sender, bodies, answers, ...c };
  };

  it("follows every scenario of the vectors", async () => {
    for (const scenario of traffic.sender.scenarios) {
      const answers: (number | "none")[] = [];
      const s = senderWith(answers);
      const byFrom = new Map<string, string>();
      for (const [i, step] of scenario.steps.entries()) {
        const at = step.at * 1000;
        if (step.closed != null) {
          s.set(at - 1000);
          s.sender.record(agentHit());
          byFrom.set(new Date(at - 1000).toISOString().replace(".000Z", "Z"), step.closed);
        }
        s.set(at);
        answers.splice(0, answers.length, ...step.answers);
        const before = s.bodies.length;
        await s.sender.flush();
        const sent = s.bodies.slice(before).map((b) => byFrom.get(JSON.parse(b).from));
        const want = scenario.expect[i];
        expect(sent, `${scenario.name} step ${i} sent`).toEqual(want.sent);
        expect(s.sender.stats.held, `${scenario.name} step ${i} held`).toBe(want.held.length);
        expect(s.sender.stats.pausedUntil, `${scenario.name} step ${i} pause`).toBe(
          want.paused_until === null ? null : want.paused_until * 1000
        );
      }
    }
  });

  it("closes a window 300 s after its first request, on its own timer", async () => {
    const s = senderWith([200], 1_764_064_800_000);
    s.sender.record(agentHit());
    s.advance(1_764_064_800_000 + 299_999);
    expect(s.bodies).toHaveLength(0);
    s.advance(1_764_064_800_000 + 300_000);
    await s.sender.flush();
    const w = JSON.parse(s.bodies[0]);
    expect([w.from, w.to]).toEqual(["2025-11-25T10:00:00Z", "2025-11-25T10:05:00Z"]);
  });

  it("resends a window it could not deliver with the same bytes, and never merges two", async () => {
    const s = senderWith([503]);
    s.sender.record(agentHit());
    s.set(10_000);
    await s.sender.flush();
    s.set(20_000);
    s.sender.record(agentHit("/docs/x"));
    s.set(30_000);
    s.answers.push(200, 200);
    await s.sender.flush();
    expect(s.bodies).toHaveLength(3);
    expect(s.bodies[1]).toBe(s.bodies[0]);
    expect(JSON.parse(s.bodies[2]).id).not.toBe(JSON.parse(s.bodies[0]).id);
    expect(JSON.parse(s.bodies[2]).sections).toEqual([["/docs", "ai_crawler", 1]]);
    expect(s.sender.stats).toMatchObject({ held: 0, sent: 2 });
  });

  it("holds at most three windows and drops one an hour old", async () => {
    const s = senderWith([]);
    for (let i = 1; i <= 5; i++) {
      s.set(i * 400_000 - 1000);
      s.sender.record(agentHit());
      s.set(i * 400_000);
      s.answers.push(503);
      await s.sender.flush();
    }
    expect(s.sender.stats.held).toBe(3);
    s.set(5 * 400_000 + 3_600_001);
    await s.sender.flush();
    expect(s.sender.stats.held).toBe(0);
  });

  it("a 400 pauses a day and a 429 keeps the window", async () => {
    const s = senderWith([429]);
    s.sender.record(agentHit());
    s.set(5000);
    await s.sender.flush();
    expect(s.sender.stats).toMatchObject({ held: 1, pausedUntil: null });
    s.answers.push(400);
    s.set(6000);
    await s.sender.flush();
    expect(s.sender.stats).toMatchObject({ held: 0, pausedUntil: 6000 + 86_400_000 });
    s.sender.record(agentHit());
    s.set(7000);
    await s.sender.flush();
    expect(s.bodies).toHaveLength(2);
  });

  it("record never waits on the network", () => {
    const s = senderWith([]);
    const fetchMock = vi.fn(() => new Promise<Response>(() => {}));
    const sender = createTrafficSender({
      endpoint: "x",
      secret: "s",
      headers: () => ({}),
      clock: s.clock,
      fetch: fetchMock as never,
    });
    for (let i = 0; i < 1000; i++) sender.record(agentHit());
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
