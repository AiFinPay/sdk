import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { startControlPlane } from "./control-plane.mjs";
import { startOrigin } from "./origin.mjs";
import { freePort, startRedis } from "./redis.mjs";
import { keyFromSeed, mintReceipt, uniqueHex } from "./tokens.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const loadVectors = () => JSON.parse(readFileSync(join(here, "../vectors/gate-v1.json"), "utf8"));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(base, hostHeader, { method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const url = new URL(base);
    const req = httpRequest({ host: url.hostname, port: url.port, method, path, agent: false, headers: { ...(hostHeader ? { Host: hostHeader } : {}), ...headers, ...(body ? { "content-length": String(body.length) } : {}) } }, (res) => {
      const chunks = [];
      res.on("data", (c) => chunks.push(c));
      res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks).toString() }));
    });
    req.setTimeout(30000, () => req.destroy(new Error("request timed out")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

const substitute = (value, api) => JSON.parse(JSON.stringify(value).replaceAll("{{api}}", api));
const originReached = (res, marker) => res.headers["x-origin-hit"] === "1" || res.body.includes(marker) || res.body.includes("ORIGIN-503");

function compareHeaders(expected, res, errors) {
  for (const [name, rule] of Object.entries(expected ?? {})) {
    const actual = res.headers[name];
    if (rule === null) {
      if (actual !== undefined) errors.push(`header ${name}: expected absent, got ${JSON.stringify(actual)}`);
    } else if (typeof rule === "string") {
      if (actual !== rule) errors.push(`header ${name}: expected ${JSON.stringify(rule)}, got ${JSON.stringify(actual)}`);
    } else if (rule.contains !== undefined) {
      const seen = String(actual ?? "").toLowerCase();
      if (!seen.includes(rule.contains.toLowerCase())) errors.push(`header ${name}: expected to contain ${JSON.stringify(rule.contains)}, got ${JSON.stringify(actual)}`);
      if (rule.excludes && seen.includes(rule.excludes.toLowerCase())) errors.push(`header ${name}: expected no ${JSON.stringify(rule.excludes)}, got ${JSON.stringify(actual)}`);
    } else if (rule.present && actual === undefined) {
      errors.push(`header ${name}: expected present`);
    }
  }
}

const canonical = (value) => {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object") return Object.fromEntries(Object.keys(value).sort().map((k) => [k, canonical(value[k])]));
  return value;
};

function compareBody(rule, res, ctx, errors) {
  if (!rule) return;
  if (rule.text !== undefined) {
    if (!res.body.includes(rule.text)) errors.push(`body: expected to contain ${JSON.stringify(rule.text)}, got ${JSON.stringify(res.body.slice(0, 200))}`);
    return;
  }
  let parsed;
  try { parsed = JSON.parse(res.body); } catch {
    errors.push(`body: not JSON: ${JSON.stringify(res.body.slice(0, 200))}`);
    return;
  }
  if (rule.subset) {
    const want = substitute(rule.subset, ctx.api);
    for (const [key, value] of Object.entries(want)) {
      if (JSON.stringify(parsed[key]) !== JSON.stringify(value)) errors.push(`body.${key}: expected ${JSON.stringify(value)}, got ${JSON.stringify(parsed[key])}`);
    }
  }
  if (rule.golden) {
    const want = substitute(ctx.vectors.golden[rule.golden], ctx.api);
    if (JSON.stringify(canonical(parsed)) !== JSON.stringify(canonical(want))) {
      const keys = new Set([...Object.keys(want), ...Object.keys(parsed)]);
      for (const key of keys) {
        if (JSON.stringify(parsed[key]) !== JSON.stringify(want[key])) errors.push(`body.${key}: expected ${JSON.stringify(want[key])?.slice(0, 160)}, got ${JSON.stringify(parsed[key])?.slice(0, 160)}`);
      }
    } else if (rule.order && JSON.stringify(parsed) !== JSON.stringify(want)) {
      errors.push("body: same fields in a different order");
    }
  }
  if (rule.resource_tier) {
    for (const [resource, tier] of Object.entries(rule.resource_tier)) {
      const row = (parsed.resources ?? []).find((r) => r.resource === resource);
      if (row?.tier !== tier) errors.push(`resources[${resource}].tier: expected ${tier}, got ${row?.tier}`);
    }
  }
}

function compareResponse(expect, res, ctx, errors) {
  const statuses = Array.isArray(expect.status) ? expect.status : [expect.status];
  if (expect.refusal_names !== undefined && res.status >= 400 && !res.body.includes(expect.refusal_names)) errors.push(`a refusal must name ${expect.refusal_names}, got ${res.body.slice(0, 200)}`);
  if (expect.status !== undefined && !statuses.includes(res.status)) errors.push(`status: expected ${statuses.join("|")}, got ${res.status}`);
  const reached = originReached(res, ctx.vectors.fixtures.marker);
  if (expect.origin === true && !reached) errors.push("origin: expected the content, it did not arrive");
  if (expect.origin === false && reached) errors.push("origin: the content was served");
  compareHeaders(expect.headers, res, errors);
  compareBody(expect.body, res, ctx, errors);
  if (expect.weight_at_least !== undefined && res.status === 402) {
    try {
      const weight = JSON.parse(res.body).unit_weight;
      if (!(weight >= expect.weight_at_least)) errors.push(`unit_weight: expected at least ${expect.weight_at_least}, got ${weight}`);
    } catch { errors.push("unit_weight: 402 body is not JSON"); }
  }
  if (expect.origin_did_not_see) {
    const saw = String(res.headers["x-origin-saw"] ?? "").split(",");
    for (const name of expect.origin_did_not_see) if (saw.includes(name)) errors.push(`origin saw ${name}`);
  }
}

function buildRequest(step, c) {
  const { fixtures } = c.vectors;
  const r = step.request;
  const headers = { ...(r.headers ?? {}) };
  const agents = fixtures.user_agents;
  const ua = Object.hasOwn(agents, r.ua) ? agents[r.ua] : r.ua;
  if (ua) headers["User-Agent"] = ua;
  if (r.agent === "payer") headers["AIFP-Agent-Id"] = c.payer;
  else if (r.agent === "other") headers["AIFP-Agent-Id"] = "0x" + uniqueHex(`other:${c.seed}`, 40);
  else if (r.agent === "payer_upper") headers["AIFP-Agent-Id"] = "0x" + c.payer.slice(2).toUpperCase();
  if (r.receipt) headers["AIFP-Receipt"] = c.tokens[r.receipt];
  let body;
  if (r.body_bytes) {
    body = randomBytes(r.body_bytes);
    c.lastBodySha = createHash("sha256").update(body).digest("hex");
    headers["content-type"] = "application/octet-stream";
  }
  return { method: r.method ?? "GET", path: (c.pathPrefix ?? "") + r.path, headers, body };
}

async function runSteps(testCase, c, instance, errors) {
  for (const [index, step] of testCase.steps.entries()) {
    if (step.action === "restart") {
      await instance.restart({ cold: false });
      continue;
    }
    if (step.action === "origin_up") {
      await c.origin.start();
      continue;
    }
    const request = buildRequest(step, c);
    const expect = step.expect;
    if (expect.concurrent) {
      const answers = await Promise.all(Array.from({ length: expect.concurrent }, () => send(instance.baseUrl, instance.hostHeader, request)));
      const served = answers.filter((a) => a.status === 200 && originReached(a, c.vectors.fixtures.marker)).length;
      const refused = answers.filter((a) => expect.refused_status.includes(a.status)).length;
      if (served !== expect.served) errors.push(`step ${index}: served ${served}, expected exactly ${expect.served}`);
      if (refused !== expect.refused) errors.push(`step ${index}: refused ${refused}, expected ${expect.refused} (statuses ${answers.map((a) => a.status).join(",")})`);
      continue;
    }
    const res = await send(instance.baseUrl, instance.hostHeader, request);
    const stepErrors = [];
    compareResponse(expect, res, { vectors: c.vectors, api: c.api }, stepErrors);
    if (expect.body_sha256 && res.headers["x-origin-sha256"] !== c.lastBodySha) stepErrors.push("origin received a different body");
    errors.push(...stepErrors.map((e) => (testCase.steps.length > 1 ? `step ${index}: ${e}` : e)));
    c.observed.push(res.status);
    if (c.receiptFunded) await c.receiptFunded();
  }
}

const eventKey = (e) => JSON.stringify([e.kind, e.resource, e.operator ?? null, e.ua_class ?? null, e.verified ?? null, e.exempt ?? false]);

async function collectEvents(testCase, cp, instance, errors) {
  const want = testCase.events.map(eventKey).sort();
  const until = Date.now() + 8000;
  while (Date.now() < until) {
    await instance.flushEvents?.();
    if (cp.state.events.length >= want.length && want.length > 0) break;
    if (want.length === 0) { await sleep(400); break; }
    await sleep(100);
  }
  await sleep(150);
  await instance.flushEvents?.();
  const got = cp.state.events.map(eventKey).sort();
  if (JSON.stringify(got) !== JSON.stringify(want)) errors.push(`events: expected ${want.join(" ")} got ${got.join(" ") || "none"}`);
  if (cp.state.violations.length) errors.push(`ingest refused: ${cp.state.violations.join("; ")}`);
}

/** Runs every case for one subject, one profile at a time. */
export async function runSubject(subject, { only = null, log = () => {} } = {}) {
  const vectors = loadVectors();
  const { fixtures } = vectors;
  const dir = mkdtempSync(join(tmpdir(), "aifp-conformance-"));
  const runId = randomBytes(6).toString("hex");
  const keys = { issuer: keyFromSeed(fixtures.keys.issuer), other: keyFromSeed(fixtures.keys.other) };
  const cp = await startControlPlane({ fixtures, operators: vectors.operators, uaClasses: vectors.ua_classes, jwk: keys.issuer.jwk, dir });
  const origin = await startOrigin(fixtures.marker);
  const redis = subject.usesRedis ? await startRedis(dir) : null;
  const results = [];
  const caps = new Set(subject.capabilities ?? []);
  const record = (testCase, status, extra = {}) => results.push({ id: testCase.id, group: testCase.group, level: testCase.level, profile: testCase.profile, title: testCase.title, status, ...extra });
  const profiles = [...new Set(vectors.cases.map((c) => c.profile))];
  try {
    for (const profileName of profiles) {
      const profile = vectors.profiles[profileName];
      const cases = vectors.cases.filter((c) => c.profile === profileName && (!only || only.test(c.id)));
      if (!cases.length) continue;
      const unsupported = subject.supports?.(profile, profileName) ?? null;
      if (unsupported) {
        for (const c of cases) record(c, "na", { reason: unsupported });
        log(`  ${profileName}: not applicable (${unsupported})`);
        continue;
      }
      cp.state.profile = profile;
      Object.assign(cp.state.faults, { jwks: false, record: false, ingest: 0 });
      const port = await freePort();
      const ctx = {
        vectors, fixtures, profile, profileName, dir, port, cp, origin, redis, keys,
        merchantId: fixtures.merchant_id, secret: fixtures.merchant_secret,
        api: cp.url, apiHttps: cp.httpsUrl, jwksUri: `${cp.url}/.well-known/jwks.json`, caFile: cp.caFile,
        setSiteUrl: (url) => { cp.state.siteUrl = url; },
        log,
      };
      cp.state.siteUrl = `http://127.0.0.1:${port}/`;
      let instance;
      try {
        instance = await subject.start(ctx);
      } catch (err) {
        const short = String(err.message).slice(0, 400);
        for (const c of cases) record(c, "error", { errors: [`subject did not start: ${short}`] });
        log(`  ${profileName}: subject did not start: ${short}`);
        continue;
      }
      const api = instance.apiBase ?? cp.url;
      log(`  ${profileName}: ${cases.length} cases`);
      for (const testCase of cases) {
        const missing = (testCase.needs ?? []).filter((n) => !caps.has(n));
        if (missing.length) {
          record(testCase, "na", { reason: `needs ${missing.join(", ")}` });
          continue;
        }
        if (testCase.unless && caps.has(testCase.unless)) {
          record(testCase, "na", { reason: `not needed: subject has ${testCase.unless}` });
          continue;
        }
        const errors = [];
        const seed = `${runId}:${testCase.id}`;
        const payer = "0x" + uniqueHex(`payer:${seed}`, 40);
        const c = { vectors, api, seed, payer, tokens: {}, observed: [], pathPrefix: instance.pathPrefix, origin };
        const now = Math.floor(Date.now() / 1000);
        for (const [name, definition] of Object.entries(testCase.receipts ?? {})) {
          c.tokens[name] = mintReceipt(definition, { fixtures, keys, payer, seed: `${seed}:${name}`, now });
          await instance.fundReceipt?.({ payer, definition, name, seed: `${seed}:${name}` });
        }
        const fault = testCase.fault ?? {};
        try {
          if (fault.jwks || fault.record) {
            if (fault.jwks) cp.state.faults.jwks = true;
            if (fault.record) cp.state.faults.record = true;
            await instance.restart({ cold: true });
          }
          if (fault.ingest) cp.state.faults.ingest = fault.ingest;
          if (fault.origin) await origin.stop();
          if (fault.store) await instance.breakStore();
          if (fault.decision) await instance.breakDecision();
          if (testCase.events) {
            // A reporter may stop for good on one refused batch: every event case starts from a fresh process.
            if (caps.has("restart")) await instance.restart({ cold: false });
            await instance.flushEvents?.();
            await sleep(100);
            cp.state.events.length = 0;
            cp.state.violations.length = 0;
          }
          await runSteps(testCase, c, instance, errors);
          if (testCase.events) await collectEvents(testCase, cp, instance, errors);
        } catch (err) {
          errors.push(`exception: ${err.message}`);
        } finally {
          try {
            if (fault.jwks || fault.record) {
              cp.state.faults.jwks = false;
              cp.state.faults.record = false;
              await instance.restart({ cold: true });
            }
            if (fault.ingest) cp.state.faults.ingest = 0;
            if (fault.origin) await origin.start();
            if (fault.store) await instance.healStore();
            if (fault.decision) await instance.healDecision();
          } catch (err) {
            errors.push(`could not restore after the fault: ${err.message}`);
          }
        }
        record(testCase, errors.length ? "fail" : "pass", errors.length ? { errors } : {});
      }
      await instance.stop();
    }
  } finally {
    await redis?.stop();
    await origin.close();
    await cp.close();
    rmSync(dir, { recursive: true, force: true });
  }
  return { subject: subject.id, label: subject.label, version: subject.version?.() ?? null, reference: vectors.reference, results };
}

export function summarize(report) {
  const out = { must: { pass: 0, fail: 0, na: 0 }, parity: { pass: 0, fail: 0, na: 0 }, should: { pass: 0, fail: 0, na: 0 } };
  for (const r of report.results) out[r.level][r.status === "error" ? "fail" : r.status]++;
  return out;
}
