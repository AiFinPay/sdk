// Gate identity and traffic: the lib agrees with every written expectation, and the runner cases go red on each way of breaking a gate.
import assert from "node:assert/strict";
import { randomUUID, verify as edVerify } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadVectors, runSubject } from "../lib/runner.mjs";
import { keyFromSeed } from "../lib/tokens.mjs";
import * as T from "../lib/traffic.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const read = (name) => JSON.parse(readFileSync(join(here, "../vectors", name), "utf8"));
const identity = read("gate-identity-v1.json");
const traffic = read("gate-traffic-v1.json");
const vectors = loadVectors();
const { fixtures } = vectors;

test("the identity vectors agree with the lib", () => {
  for (const v of identity.format) assert.deepEqual(T.formatGate(v.input), { user_agent: v.user_agent, header: v.header }, v.name);
  for (const v of identity.parse) assert.deepEqual(T.parseGateHeader(v.header), v.gate, v.name);
  for (const v of identity.user_agents) assert.deepEqual(T.parseGateUserAgent(v.user_agent), v.gate, v.name);
  assert.equal(T.parseGateHeader(undefined), null);
  assert.equal(T.parseGateUserAgent(42), null);
  assert.throws(() => T.formatGate({ pkg: "nginx", ver: "1", platform: "x", mode: "shadow", charge: "agents" }));
});

test("the traffic vectors agree with the lib", () => {
  const ctx = (seen = new Set()) => ({ now: traffic.now, operators: traffic.operators, uaClasses: traffic.ua_classes, seen });
  const text = (v) => (Object.hasOwn(v, "raw") ? v.raw : JSON.stringify(v.body));
  for (const v of traffic.sections) assert.equal(T.sectionOf(v.target), v.section, v.target);
  for (const v of traffic.counted) assert.equal(T.counted(v.target, v.outcome), v.counted, `${v.target} ${v.outcome}`);
  for (const v of traffic.countries) assert.equal(T.countryOf(v.value), v.country, JSON.stringify(v.value));
  for (const v of traffic.networks) assert.equal(T.networkOf(v.value), v.network, JSON.stringify(v.value));
  for (const v of traffic.build) assert.equal(T.buildTraffic(v.window, v.platform, v.requests), v.body, v.name);
  for (const v of traffic.accept) {
    const got = T.validateTraffic(text(v), ctx());
    assert.deepEqual([got.status, got.duplicate, got.rows, got.skipped, got.skipped_rows], [200, false, v.rows, v.skipped, v.skipped_rows], v.name);
  }
  for (const v of traffic.reject) assert.equal(T.validateTraffic(text(v), ctx()).status, v.status, v.name);
  for (const v of traffic.duplicates) {
    const seen = new Set();
    const got = v.bodies.map((b) => T.validateTraffic(JSON.stringify(b), ctx(seen))).map((r) => ({ accepted: true, duplicate: r.duplicate, rows: r.rows, skipped: r.skipped }));
    assert.deepEqual(got, v.answers, v.name);
  }
  for (const v of traffic.sender.scenarios) assert.deepEqual(T.senderRun(v.steps), v.expect, v.name);
  for (const v of traffic.edge_counted.values) assert.equal(T.edgeCounted(v.lines), v.edge_counted, v.name);
  for (const v of traffic.edge_counted.build) assert.equal(T.buildTraffic(v.window, v.platform, v.requests), v.body, v.name);
});

test("two build bodies written out by hand equal the lib", () => {
  const body = (name) => {
    const v = traffic.build.find((b) => b.name === name);
    return T.buildTraffic(v.window, v.platform, v.requests);
  };
  assert.equal(body("mixed"), '{"v":1,"id":"7b0c6f0e-3d0a-4c58-9a51-0f2d6c1b9e77","from":"2026-11-25T10:00:00Z","to":"2026-11-25T10:05:00Z","mode":"enforce","charge":"agents","sample":1,"classes":[["ai_crawler","challenged",3],["aifp_agent","paid",1],["human","served",3],["unknown","served",1]],"operators":[["aifinpay","aifp_agent","paid",1],["openai","ai_crawler","challenged",3],["unknown","unknown","served",1]],"sections":[["/api","aifp_agent",1],["/blog","ai_crawler",2],["/docs","ai_crawler",1],["_other","unknown",1]],"countries":[["DE","aifp_agent",1],["US","ai_crawler",2],["US","human",3],["ZZ","ai_crawler",1],["ZZ","unknown",1]],"networks":[["AS0","ai_crawler",1],["AS0","unknown",1],["AS16509","aifp_agent",1],["AS8075","ai_crawler",2]]}');
  assert.equal(body("readers_only"), '{"v":1,"id":"7b0c6f0e-3d0a-4c58-9a51-0f2d6c1b9e77","from":"2026-11-25T10:00:00Z","to":"2026-11-25T10:05:00Z","mode":"enforce","charge":"agents","sample":1,"classes":[["human","served",7]],"countries":[["UA","human",2],["US","human",5]]}');
});

const ORDER = ["v", "id", "from", "to", "mode", "charge", "sample", "classes", "operators", "sections", "countries", "networks"];
const iso = (seconds) => new Date(seconds * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
const isProtected = (p) => p === "/paid" || p.startsWith("/paid/");

function classify(req) {
  if (req.headers["aifp-receipt"] || req.headers["aifp-agent-id"]) return ["aifp_agent", "aifinpay"];
  const ua = req.headers["user-agent"];
  if (!ua) return ["unknown", "unknown"];
  if (/gptbot/i.test(ua)) return ["ai_crawler", "openai"];
  if (/claudebot/i.test(ua)) return ["ai_crawler", "anthropic"];
  return ["human", "unknown"];
}

/** A gate small enough to read: decides, reports events, counts windows and runs the sender, with knobs to break it. */
function trafficGate(ctx, breakage) {
  const { profile } = ctx;
  const shadow = profile.mode === "shadow";
  const id = T.formatGate({ pkg: "kit", ver: "0.0.1", platform: "node", mode: breakage.enforceFromShadow ? "enforce" : profile.mode, charge: profile.charge });
  const fresh = () => ({ events: [], eventsStopped: false, open: null, held: [], pausedUntil: 0, used: new Map() });
  let state = fresh();
  const post = async (route, body) => {
    const headers = { "content-type": "application/json", "aifp-merchant-secret": ctx.secret, "user-agent": id.user_agent, ...(breakage.noGateHeader ? {} : { "aifp-gate": id.header }) };
    try {
      const res = await fetch(`${ctx.api}/v1/merchants/${ctx.merchantId}/${route}`, { method: "POST", headers, body, redirect: "manual", signal: AbortSignal.timeout(10000) });
      await res.arrayBuffer();
      return res.status;
    } catch {
      return "none";
    }
  };
  const count = (target, ua_class, operator, outcome) => {
    // The lib skips assets; a trailing slash hides the extension from it.
    const seen = breakage.countAssets && !T.counted(target, outcome) ? `${target.split("?")[0]}/` : target;
    state.open ??= { from: Math.floor(Date.now() / 1000), requests: [] };
    state.open.requests.push({ target: seen, ua_class, operator, outcome, country: null, network: null });
  };
  const withHumanSections = (body, requests) => {
    const o = JSON.parse(body);
    const human = requests.filter((r) => r.ua_class === "human" && T.counted(r.target, r.outcome)).map((r) => [T.sectionOf(r.target), "human", 1]);
    if (!human.length) return body;
    o.sections = [...(o.sections ?? []), ...human].sort((a, b) => (a[0] + a[1] < b[0] + b[1] ? -1 : 1));
    return JSON.stringify(Object.fromEntries(ORDER.filter((k) => o[k] !== undefined).map((k) => [k, o[k]])));
  };

  async function flushEvents() {
    if (state.eventsStopped || !state.events.length) return;
    await post("gate-events", JSON.stringify({ events: state.events.splice(0, 50) }));
  }

  async function flushTraffic() {
    const now = Math.floor(Date.now() / 1000);
    if (state.pausedUntil && now >= state.pausedUntil) state.pausedUntil = 0;
    if (state.open) {
      const { from, requests } = state.open;
      state.open = null;
      const to = Math.max(now, from + 1);
      let body = T.buildTraffic({ id: randomUUID(), from: iso(from), to: iso(to), mode: profile.mode, charge: profile.charge, sample: 1 }, { country: false, network: false }, requests);
      if (body && breakage.humanSections) body = withHumanSections(body, requests);
      if (body && breakage.lowercaseCountry) body = `${body.slice(0, -1)},"countries":[["us","unknown",1]]}`;
      if (body && !state.pausedUntil) state.held.push({ to, body });
    }
    if (state.held.length > 3) state.held.splice(0, state.held.length - 3);
    state.held = state.held.filter((w) => w.to >= now - 3600);
    while (!state.pausedUntil && state.held.length) {
      const w = state.held[0];
      const status = await post("gate-traffic", w.body);
      if (typeof status === "number" && status >= 200 && status < 300) {
        state.held.shift();
        continue;
      }
      if (status === "none" || status === 408 || status === 429 || status >= 500) {
        if (breakage.newIdOnRetry) w.body = w.body.replace(/"id":"[^"]+"/, `"id":"${randomUUID()}"`);
        break;
      }
      state.held = [];
      state.pausedUntil = now + (status === 404 ? 21600 : 86400);
      if (status === 404 && breakage.eventsStopAfter404) state.eventsStopped = true;
    }
  }

  const server = createServer((req, res) => {
    const target = req.url;
    const path = target.split("?")[0];
    const [uaClass, operator] = classify(req);
    const edgeLines = req.rawHeaders.filter((_, i, all) => i % 2 === 1 && all[i - 1].toLowerCase() === "aifp-edge-counted");
    const edge = breakage.anyEdgeValue ? edgeLines.some((line) => line.trim()) : T.edgeCounted(edgeLines);
    const rule = (profile.operator_rules ?? []).find((r) => r.operator === operator && uaClass !== "human");
    let outcome = "served";
    if (isProtected(path) && !(uaClass === "human" && profile.charge === "agents")) {
      if (rule?.action === "allow") outcome = "served";
      else if (rule?.action === "block") outcome = "blocked";
      else if (req.headers["aifp-receipt"]) {
        const [h, p, s] = String(req.headers["aifp-receipt"]).split(".");
        let claims = null;
        try {
          if (edVerify(null, Buffer.from(`${h}.${p}`), keyFromSeed(fixtures.keys.issuer).privateKey, Buffer.from(s ?? "", "base64url"))) claims = JSON.parse(Buffer.from(p, "base64url"));
        } catch { /* refused below */ }
        outcome = claims?.aud === fixtures.merchant_id ? "paid" : "blocked";
      } else outcome = "challenged";
    }
    if (isProtected(path) && (outcome === "challenged" || outcome === "paid") && !(breakage.edgeSkipsEvent && edge)) {
      state.events.push({ id: randomUUID(), at: new Date().toISOString(), kind: outcome === "paid" ? "serve" : "402", resource: "/paid/*", operator, ua_class: uaClass, verified: outcome === "paid" });
    }
    if (!edge || breakage.ignoreEdge) count(target, uaClass, operator, breakage.shadowServed && shadow && outcome === "challenged" ? "served" : outcome);
    let left = {};
    if (outcome === "paid") {
      const token = String(req.headers["aifp-receipt"]);
      state.used.set(token, (state.used.get(token) ?? 0) + 1);
      left = { "aifp-quota-remaining": String(3 - state.used.get(token)) };
    }
    if (shadow || outcome === "served" || outcome === "paid") {
      const status = { challenged: "402", blocked: "403" }[outcome];
      res.writeHead(200, { "x-origin-hit": "1", "cache-control": "no-store", ...left, ...(shadow ? { "aifp-mode": "shadow", ...(status ? { "aifp-shadow-status": status } : {}) } : {}) });
      return res.end(fixtures.marker);
    }
    if (outcome === "challenged") {
      res.writeHead(402, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(vectors.golden["challenge.standard"]).replaceAll("{{api}}", ctx.api));
    }
    res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
    res.end(JSON.stringify({ error: "AIFP-403", detail: "blocked by merchant policy (operator rule)" }));
  });
  return { server, flushEvents, flushTraffic, restart: () => { state = fresh(); } };
}

const PROFILES = ["content-enforce", "content-shadow", "policy-enforce"];
const trafficSubject = (breakage = {}, capabilities = ["identity", "traffic", "events", "restart"]) => ({
  id: "tiny-traffic",
  label: "tiny traffic gate",
  capabilities,
  supports: (profile, name) => (PROFILES.includes(name) ? null : "not this profile"),
  async start(ctx) {
    const gate = trafficGate(ctx, breakage);
    await new Promise((r) => gate.server.listen(ctx.port, "127.0.0.1", r));
    return {
      baseUrl: `http://127.0.0.1:${ctx.port}`,
      flushEvents: gate.flushEvents,
      flushTraffic: gate.flushTraffic,
      restart: async () => gate.restart(),
      stop: () => new Promise((r) => { gate.server.closeAllConnections(); gate.server.close(r); }),
    };
  },
});

const ONLY = /^(identity|traffic)\./;
const red = (report) => report.results.filter((r) => r.status !== "pass").map((r) => r.id).sort();

test("an honest gate passes every identity and traffic case", async () => {
  const report = await runSubject(trafficSubject(), { only: ONLY });
  assert.deepEqual(report.results.filter((r) => r.status !== "pass").map((r) => [r.id, r.errors]), []);
  assert.equal(report.results.length, 13);
});

for (const [breakage, named, alsoRed = []] of [
  // No header at all also leaves the shadow site unnamed.
  [{ noGateHeader: true }, "identity.header", ["identity.shadow"]],
  [{ enforceFromShadow: true }, "identity.shadow"],
  // traffic.asset has a reader too, so a human section row turns it red as well.
  [{ humanSections: true }, "traffic.window", ["traffic.asset", "traffic.edge_counted"]],
  [{ shadowServed: true }, "traffic.shadow"],
  [{ countAssets: true }, "traffic.asset"],
  [{ newIdOnRetry: true }, "traffic.resend"],
  [{ eventsStopAfter404: true }, "traffic.old_api"],
  // No case compares countries: only the skipped row gives it away, in every window that is accepted.
  [{ lowercaseCountry: true }, "traffic.window", ["traffic.asset", "traffic.blocked", "traffic.edge_counted", "traffic.paid", "traffic.resend", "traffic.shadow"]],
  [{ ignoreEdge: true }, "traffic.edge_counted", ["traffic.edge_counted_only"]],
  [{ anyEdgeValue: true }, "traffic.edge_counted"],
  [{ edgeSkipsEvent: true }, "traffic.edge_counted", ["traffic.edge_counted_only"]],
]) {
  test(`a gate with ${Object.keys(breakage)[0]} fails ${named}`, async () => {
    const report = await runSubject(trafficSubject(breakage), { only: ONLY });
    assert.deepEqual(red(report), [named, ...alsoRed].sort());
  });
}

test("a subject without the capabilities records every identity and traffic case as not applicable", async () => {
  const report = await runSubject(trafficSubject({}, ["events"]), { only: ONLY });
  assert.equal(report.results.length, 13);
  for (const r of report.results) assert.deepEqual([r.status, r.reason], ["na", `needs ${r.id.split(".")[0]}`], r.id);
});
