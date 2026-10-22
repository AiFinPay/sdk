// ──────────────────────────────────────────────────────────────────────────
// Who asked — operator, ua_class, verified on every gate event.
//
// The "who is hitting my site" report is built from these three fields, so
// the case that would quietly poison it is not a wrong operator name: it is a
// scanner sending "ChatGPT-User" and being reported as a verified OpenAI
// agent. A User-Agent is a claim. Only a receipt this gate verified makes an
// event verified, and the raw User-Agent never leaves the request.
// ──────────────────────────────────────────────────────────────────────────
import * as jose from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  AI_AGENT_UA_MARKERS,
  AI_AGENT_UA_TABLE,
  GATE_OPERATORS,
  UA_CLASSES,
  classifyAgent,
  createGate,
  createGateReporter,
  knownAiAgent,
  MemoryStore,
} from "../src/index.js";
import type { GateEvent, GateReporter, GateStore } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req, signReceipt } from "./helpers.js";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const CHATGPT_USER_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const IDENTITY_KEYS = ["operator", "ua_class", "verified"];

async function recordingGate(overrides: Record<string, unknown> = {}) {
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

describe("the marker table", () => {
  it("is the one source of the markers, and every row uses the closed enums", () => {
    expect([...AI_AGENT_UA_MARKERS]).toEqual(AI_AGENT_UA_TABLE.map((row) => row.marker));
    expect(new Set(AI_AGENT_UA_MARKERS).size).toBe(AI_AGENT_UA_MARKERS.length);
    for (const row of AI_AGENT_UA_TABLE) {
      expect(row.marker).toBe(row.marker.toLowerCase());
      expect(GATE_OPERATORS).toContain(row.operator);
      expect(UA_CLASSES).toContain(row.ua_class);
    }
  });

  it("the operator enum is exactly the one the ingest and the site check share", () => {
    expect([...GATE_OPERATORS]).toEqual([
      "openai",
      "anthropic",
      "perplexity",
      "google",
      "microsoft",
      "meta",
      "bytedance",
      "apple",
      "amazon",
      "commoncrawl",
      "aifinpay",
      "unknown",
    ]);
    expect([...UA_CLASSES]).toEqual(["ai_crawler", "ai_agent_browser", "aifp_agent", "human", "unknown"]);
  });

  it("every marker classifies to its own row, never verified", () => {
    for (const row of AI_AGENT_UA_TABLE) {
      const ua = `Mozilla/5.0 (compatible; ${row.marker.toUpperCase()}/1.0; +https://example.invalid/bot)`;
      expect(classifyAgent(req("/", { "User-Agent": ua })), row.marker).toEqual({
        operator: row.operator,
        ua_class: row.ua_class,
        verified: false,
      });
    }
  });

  it("maps the published User-Agents of the big operators", () => {
    const cases: [string, string, string][] = [
      [
        "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
        "openai",
        "ai_crawler",
      ],
      ["Mozilla/5.0 (compatible; OAI-SearchBot/1.0; +https://openai.com/searchbot)", "openai", "ai_crawler"],
      [CHATGPT_USER_UA, "openai", "ai_agent_browser"],
      ["Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "anthropic", "ai_crawler"],
      ["Mozilla/5.0 (compatible; Claude-SearchBot/1.0; +https://www.anthropic.com)", "anthropic", "ai_crawler"],
      ["Mozilla/5.0 (compatible; Claude-User/1.0; +Claude-User@anthropic.com)", "anthropic", "ai_agent_browser"],
      ["Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "perplexity", "ai_crawler"],
      [
        "Mozilla/5.0 (compatible; Perplexity-User/1.0; +https://perplexity.ai/perplexity-user)",
        "perplexity",
        "ai_agent_browser",
      ],
      ["CCBot/2.0 (https://commoncrawl.org/faq/)", "commoncrawl", "ai_crawler"],
      [
        "Mozilla/5.0 (Linux; Android 5.0) AppleWebKit/537.36 (compatible; Bytespider; spider-feedback@bytedance.com)",
        "bytedance",
        "ai_crawler",
      ],
      [
        "meta-externalagent/1.1 (+https://developers.facebook.com/docs/sharing/webmasters/crawler)",
        "meta",
        "ai_crawler",
      ],
      [
        "Mozilla/5.0 (compatible; Amazonbot/0.1; +https://developer.amazon.com/support/amazonbot)",
        "amazon",
        "ai_crawler",
      ],
      ["aifinpay-agent-node/0.3.0", "aifinpay", "aifp_agent"],
      [
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36",
        "unknown",
        "unknown",
      ],
    ];
    for (const [ua, operator, ua_class] of cases) {
      expect(classifyAgent(req("/", { "User-Agent": ua })), ua).toEqual({ operator, ua_class, verified: false });
    }
  });

  it("a browser is human, no User-Agent is unknown, and AIFP headers beat any User-Agent", () => {
    expect(classifyAgent(req("/", { "User-Agent": BROWSER_UA }))).toEqual({
      operator: "unknown",
      ua_class: "human",
      verified: false,
    });
    expect(classifyAgent(req("/", {}))).toEqual({ operator: "unknown", ua_class: "unknown", verified: false });
    for (const header of ["AIFP-Agent-Id", "AIFP-Receipt"]) {
      expect(classifyAgent(req("/", { "User-Agent": CHATGPT_USER_UA, [header]: "x" }))).toEqual({
        operator: "aifinpay",
        ua_class: "aifp_agent",
        verified: false,
      });
    }
  });

  it("knownAiAgent is the classifier's 'not human', so the two cannot disagree", () => {
    const headerSets: Record<string, string>[] = [
      {},
      { "User-Agent": BROWSER_UA },
      { "User-Agent": CHATGPT_USER_UA },
      { "User-Agent": BROWSER_UA, "AIFP-Agent-Id": "agt_1" },
      ...AI_AGENT_UA_MARKERS.map((marker) => ({ "User-Agent": `x ${marker} y` })),
    ];
    for (const headers of headerSets) {
      const r = req("/", headers);
      expect(knownAiAgent(r), JSON.stringify(headers)).toBe(classifyAgent(r).ua_class !== "human");
    }
  });
});

describe("gate events carry the identity", () => {
  it("a spoofed ChatGPT-User without a receipt is reported as claimed, not verified", async () => {
    for (const shouldCharge of [undefined, knownAiAgent]) {
      const { gate, events } = await recordingGate(shouldCharge ? { shouldCharge } : {});
      const r = await gate(req("/api/search", { "User-Agent": CHATGPT_USER_UA }));
      expect(r.status).toBe(402);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        kind: "402",
        operator: "openai",
        ua_class: "ai_agent_browser",
        verified: false,
      });
    }
  });

  it("a spoofed ChatGPT-User with a receipt signed by someone else stays unverified", async () => {
    const { gate, events } = await recordingGate();
    const stranger = await jose.generateKeyPair("Ed25519");
    const forged = await signReceipt(stranger.privateKey as CryptoKey, {});
    const r = await gate(req("/api/search", { "User-Agent": CHATGPT_USER_UA, "AIFP-Receipt": forged }));
    expect(r.status).toBe(403);
    expect(events[0]).toMatchObject({ kind: "403", operator: "aifinpay", ua_class: "aifp_agent", verified: false });
  });

  it("an expired receipt is not verified", async () => {
    const { gate, iss, events } = await recordingGate();
    const r = await gate(req("/api/search", { "AIFP-Receipt": await iss.sign({ expiresInSec: -3600 }) }));
    expect(r.status).toBe(402);
    expect(events[0]).toMatchObject({ kind: "402", verified: false, ua_class: "aifp_agent" });
  });

  it("a valid AIFP receipt is verified, whatever the User-Agent claims", async () => {
    const { gate, iss, events } = await recordingGate();
    const token = await iss.sign({ unit_quota: 1 });
    const headers = { "User-Agent": CHATGPT_USER_UA, "AIFP-Receipt": token };
    expect((await gate(req("/api/search", headers))).status).toBe(200);
    // Single-use: the replay check refuses the second spend — still verified,
    // because the identity is settled even when the spend is refused.
    expect((await gate(req("/api/search", headers))).status).toBe(403);
    expect(events.map((e) => [e.kind, e.operator, e.ua_class, e.verified])).toEqual([
      ["serve", "aifinpay", "aifp_agent", true],
      ["403", "aifinpay", "aifp_agent", true],
    ]);
  });

  it("an exhausted batch is a verified 402", async () => {
    const { gate, iss, events } = await recordingGate();
    const token = await iss.sign({ unit_quota: 2 });
    for (let i = 0; i < 3; i++) await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(events.map((e) => [e.kind, e.verified])).toEqual([
      ["serve", true],
      ["serve", true],
      ["402", true],
    ]);
  });

  it("every event kind carries all three fields", async () => {
    const seen = new Map<string, GateEvent>();
    const onEvent = (e: GateEvent) => seen.set(e.kind, e);
    const iss = await issuer();
    const base = { merchantId: MERCHANT, issuer: ISSUER, jwks: iss.jwks, onEvent };
    const token = await iss.sign({ unit_quota: 5 });
    const failing = { incrBy: async () => Promise.reject(new Error("store down")) } as unknown as GateStore;

    await createGate({ ...base, resource: "/api/search", store: new MemoryStore() })(req("/api/search"));
    await createGate({ ...base, resource: "/api/search", store: new MemoryStore() })(
      req("/api/search", { "AIFP-Receipt": token })
    );
    // Scoped to /api/search, presented at /api/other.
    await createGate({ ...base, resource: "/api/other", store: new MemoryStore() })(
      req("/api/other", { "AIFP-Receipt": token })
    );
    await createGate({ ...base, resource: "/api/search", store: failing })(
      req("/api/search", { "AIFP-Receipt": token })
    );
    await createGate({ ...base, registry: { neverLoaded: true, match: () => null } as never })(req("/api/search"));

    expect([...seen.keys()].sort()).toEqual(["402", "403", "meter_error", "pricing_unavailable", "serve"]);
    for (const [kind, e] of seen) {
      for (const key of IDENTITY_KEYS) expect(e, `${kind}.${key}`).toHaveProperty(key);
      expect(GATE_OPERATORS).toContain(e.operator);
      expect(UA_CLASSES).toContain(e.ua_class);
      expect(typeof e.verified).toBe("boolean");
    }
    expect(seen.get("serve")?.verified).toBe(true);
    expect(seen.get("meter_error")?.verified).toBe(true);
    expect(seen.get("pricing_unavailable")?.verified).toBe(false);
  });

  it("an exempt human read is a human serve; exempt semantics are unchanged", async () => {
    const { gate, events } = await recordingGate({ shouldCharge: knownAiAgent });
    const r = await gate(req("/api/search", { "User-Agent": BROWSER_UA }));
    expect(r.ok && r.aifp.mode).toBe("exempt");
    expect(events).toEqual([
      expect.objectContaining({ kind: "serve", exempt: true, operator: "unknown", ua_class: "human", verified: false }),
    ]);
  });

  it("never copies the User-Agent, IP or any header into an event", async () => {
    const { gate, iss, events } = await recordingGate();
    const ua = "Mozilla/5.0 (compatible; GPTBot/1.2; secret-tracking-token-123)";
    const headers = { "User-Agent": ua, "X-Forwarded-For": "203.0.113.7", Cookie: "session=abc" };
    await gate(req("/api/search", headers));
    await gate(req("/api/search", { ...headers, "AIFP-Receipt": await iss.sign({ unit_quota: 3 }) }));
    expect(events).toHaveLength(2);
    const text = JSON.stringify(events);
    for (const leaked of ["GPTBot", "secret-tracking-token", "203.0.113.7", "session=abc", "Mozilla"]) {
      expect(text).not.toContain(leaked);
    }
  });
});

describe("the reporter forwards the identity", () => {
  let reporters: GateReporter[] = [];
  const options = { merchantId: "mrch_0123456789abcdef", merchantSecret: "test-secret" };
  const ok = (count: number) => new Response(JSON.stringify({ accepted: count, duplicates: 0 }));
  const echo = async (_url: unknown, init: RequestInit) => ok(JSON.parse(init.body as string).events.length);
  const sent = (call: unknown[]) => JSON.parse((call[1] as RequestInit).body as string).events;
  const keys = (events: Record<string, unknown>[]) => events.map((e) => Object.keys(e).sort());
  const LEGACY = ["at", "id", "kind", "resource"];
  const make = () => {
    const reporter = createGateReporter(options);
    reporters.push(reporter);
    return reporter;
  };
  afterEach(async () => {
    vi.stubGlobal("fetch", vi.fn(echo));
    await Promise.all(reporters.map((reporter) => reporter.close()));
    reporters = [];
    vi.unstubAllGlobals();
  });

  it("sends the three fields, an exempt serve only for agents, and nothing for a human read", async () => {
    const request = vi.fn(echo);
    vi.stubGlobal("fetch", request);
    const reporter = make();
    const at = { resource: "/api/*", weight: 1 };
    reporter.onEvent({ kind: "402", ...at, operator: "openai", ua_class: "ai_crawler", verified: false });
    reporter.onEvent({
      kind: "serve",
      ...at,
      exempt: true,
      operator: "anthropic",
      ua_class: "ai_agent_browser",
      verified: false,
    });
    reporter.onEvent({ kind: "serve", ...at, exempt: true, operator: "unknown", ua_class: "human", verified: false });
    reporter.onEvent({ kind: "serve", ...at, exempt: true, operator: "unknown", ua_class: "unknown", verified: false });
    reporter.onEvent({ kind: "serve", ...at, exempt: true });
    reporter.onEvent({
      kind: "serve",
      ...at,
      agent: "agt_private",
      receipt_id: "rcpt_private",
      operator: "aifinpay",
      ua_class: "aifp_agent",
      verified: true,
    });
    await reporter.flush();
    const events = sent(request.mock.calls[0]);
    expect(keys(events)).toEqual([
      ["at", "id", "kind", "operator", "resource", "ua_class", "verified"],
      ["at", "exempt", "id", "kind", "operator", "resource", "ua_class", "verified"],
      ["at", "id", "kind", "operator", "resource", "ua_class", "verified"],
    ]);
    expect(events[1]).toMatchObject({ kind: "serve", exempt: true, operator: "anthropic" });
    expect(events[2]).toMatchObject({ operator: "aifinpay", ua_class: "aifp_agent", verified: true });
    expect(JSON.stringify(events)).not.toMatch(/private/);
  });

  it("an identity outside the enums goes out without it instead of getting the batch refused", async () => {
    const request = vi.fn(echo);
    vi.stubGlobal("fetch", request);
    const reporter = make();
    const at = { resource: "/api/*", weight: 1 };
    reporter.onEvent({ kind: "402", ...at, operator: "Mozilla/5.0" as never, ua_class: "ai_crawler", verified: false });
    reporter.onEvent({ kind: "402", ...at, operator: "openai", ua_class: "ai_crawler", verified: "yes" as never });
    reporter.onEvent({
      kind: "serve",
      ...at,
      exempt: true,
      operator: "openai",
      ua_class: "bot" as never,
      verified: false,
    });
    await reporter.flush();
    expect(keys(sent(request.mock.calls[0]))).toEqual([LEGACY, LEGACY]);
  });

  it("a backend that predates the fields gets the legacy shape instead of losing all reporting", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: "AIFP-400" }), { status: 400 }))
      .mockImplementation(echo);
    vi.stubGlobal("fetch", request);
    const reporter = make();
    const crawler = {
      resource: "/api/*",
      weight: 1,
      operator: "openai",
      ua_class: "ai_crawler",
      verified: false,
    } as const;
    reporter.onEvent({ kind: "402", ...crawler });
    reporter.onEvent({ kind: "serve", ...crawler, exempt: true });
    await reporter.flush();
    // The exempt serve is dropped: an old backend would count it as a paid serve.
    expect(reporter.stats).toMatchObject({ stopped: false, queued: 1, dropped: 1, lastError: "rejected" });
    await reporter.flush();
    expect(keys(sent(request.mock.calls[1]))).toEqual([LEGACY]);
    expect(sent(request.mock.calls[1])[0].id).toBe(sent(request.mock.calls[0])[0].id);
    reporter.onEvent({ kind: "402", ...crawler });
    reporter.onEvent({ kind: "serve", ...crawler, exempt: true });
    await reporter.flush();
    expect(keys(sent(request.mock.calls[2]))).toEqual([LEGACY]);
    expect(reporter.stats).toMatchObject({ stopped: false, queued: 0, delivered: 2, lastError: null });
  });

  it("a 400 for the legacy shape still stops the reporter, as before", async () => {
    const request = vi.fn(async () => new Response("{}", { status: 400 }));
    vi.stubGlobal("fetch", request);
    const reporter = make();
    reporter.onEvent({
      kind: "402",
      resource: "/api/*",
      weight: 1,
      operator: "openai",
      ua_class: "ai_crawler",
      verified: false,
    });
    await reporter.flush();
    await reporter.flush();
    expect(request).toHaveBeenCalledTimes(2);
    expect(keys(sent(request.mock.calls[1]))).toEqual([LEGACY]);
    expect(reporter.stats).toMatchObject({ stopped: true, lastError: "rejected" });
  });
});
