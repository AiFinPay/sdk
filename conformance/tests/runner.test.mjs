// The suite is only worth something if it goes red. A small honest gate passes; each way of breaking it must fail the named case.
import assert from "node:assert/strict";
import { verify as edVerify } from "node:crypto";
import { createServer } from "node:http";
import { test } from "node:test";
import { eventViolation } from "../lib/control-plane.mjs";
import { lenientPath } from "../lib/origin.mjs";
import { loadVectors, runSubject } from "../lib/runner.mjs";
import { keyFromSeed, mintReceipt } from "../lib/tokens.mjs";

const vectors = loadVectors();
const { fixtures } = vectors;

/** Enough of a gate for the challenge, receipt-less and metering cases, with knobs to break it. */
function tinyGate(ctx, breakage = {}) {
  const used = new Map();
  const golden = JSON.stringify(vectors.golden["challenge.standard"]).replaceAll("{{api}}", ctx.api);
  return createServer((req, res) => {
    const receipt = req.headers["aifp-receipt"];
    const browser = !req.headers["aifp-agent-id"] && !receipt && /Chrome/.test(req.headers["user-agent"] ?? "");
    if (browser) {
      res.writeHead(200, { "aifp-paywall": "exempt", "x-origin-hit": "1", "cache-control": "no-store" });
      return res.end(fixtures.marker);
    }
    if (!receipt) {
      if (breakage.serveWithoutReceipt) {
        res.writeHead(200, { "x-origin-hit": "1" });
        return res.end(fixtures.marker);
      }
      res.writeHead(402, { "content-type": "application/json", "cache-control": breakage.storable402 ? "public" : "no-store" });
      return res.end(golden);
    }
    const [h, p, s] = String(receipt).split(".");
    const key = keyFromSeed(fixtures.keys.issuer);
    let claims = null;
    try {
      if (edVerify(null, Buffer.from(`${h}.${p}`), key.privateKey, Buffer.from(s ?? "", "base64url")) || breakage.acceptAnySignature) claims = JSON.parse(Buffer.from(p, "base64url"));
    } catch { /* refused below */ }
    if (!claims || claims.aud !== fixtures.merchant_id) {
      res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify({ error: "AIFP-403", detail: "receipt verification failed (signature/issuer/audience)" }));
    }
    const next = (used.get(claims.receipt_id) ?? 0) + 1;
    if (!breakage.neverCount) used.set(claims.receipt_id, next);
    if (next > claims.unit_quota) {
      res.writeHead(402, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(JSON.stringify(vectors.golden["challenge.exhausted"]).replaceAll("{{api}}", ctx.api));
    }
    res.writeHead(200, { "aifp-quota-remaining": String(claims.unit_quota - next), "x-origin-hit": "1", "cache-control": "no-store" });
    res.end(fixtures.marker);
  });
}

const subject = (breakage) => ({
  id: "tiny",
  label: "tiny",
  capabilities: [],
  supports: (profile, name) => (name === "content-enforce" ? null : "not this profile"),
  async start(ctx) {
    const server = tinyGate(ctx, breakage);
    await new Promise((r) => server.listen(ctx.port, "127.0.0.1", r));
    return { baseUrl: `http://127.0.0.1:${ctx.port}`, stop: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) };
  },
});

const ONLY = /^(challenge\.payable|receipt\.valid|receipt\.tampered|meter\.drain|cache\.challenge)$/;
const statusOf = (report, id) => report.results.find((r) => r.id === id).status;

test("an honest gate passes the cases it can run", async () => {
  const report = await runSubject(subject({}), { only: ONLY });
  assert.deepEqual(report.results.filter((r) => r.status !== "pass").map((r) => [r.id, r.errors]), []);
  assert.equal(report.results.length, 5);
});

for (const [breakage, red] of [
  [{ serveWithoutReceipt: true }, "challenge.payable"],
  [{ storable402: true }, "cache.challenge"],
  [{ acceptAnySignature: true }, "receipt.tampered"],
  [{ neverCount: true }, "meter.drain"],
]) {
  test(`a gate with ${Object.keys(breakage)[0]} fails ${red}`, async () => {
    const report = await runSubject(subject(breakage), { only: ONLY });
    assert.equal(statusOf(report, red), "fail");
  });
}

test("a profile a subject cannot serve is recorded as not applicable, with its reason", async () => {
  const report = await runSubject(subject({}), { only: /^challenge\.premium$/ });
  assert.deepEqual(report.results.map((r) => [r.status, r.reason]), [["na", "not this profile"]]);
});

test("the ingest rules refuse what the real ingest refuses", () => {
  const base = { id: "2f1c9b1e-8a9b-4c3d-9e2f-0123456789ab", kind: "402", resource: "/paid/*", at: new Date().toISOString() };
  const rules = { patterns: new Set(["/paid/*"]), operators: vectors.operators, uaClasses: vectors.ua_classes, now: Date.now() };
  assert.equal(eventViolation(base, rules), null);
  assert.equal(eventViolation({ ...base, operator: "openai", ua_class: "ai_crawler", verified: false }, rules), null);
  assert.match(eventViolation({ ...base, resource: "/paid/a" }, rules), /unregistered/);
  assert.match(eventViolation({ ...base, kind: "403" }, rules), /kind/);
  assert.match(eventViolation({ ...base, path: "/x" }, rules), /key set/);
  assert.match(eventViolation({ ...base, operator: "acme", ua_class: "ai_crawler", verified: false }, rules), /identity/);
});

test("a tampered receipt really fails verification and a minted one really passes", () => {
  const keys = { issuer: keyFromSeed(fixtures.keys.issuer), other: keyFromSeed(fixtures.keys.other) };
  const mint = (definition) => mintReceipt(definition, { fixtures, keys, payer: "0xabc", seed: "s", now: 1 });
  const check = (token) => {
    const [h, p, s] = token.split(".");
    return edVerify(null, Buffer.from(`${h}.${p}`), keys.issuer.privateKey, Buffer.from(s, "base64url"));
  };
  assert.equal(check(mint({})), true);
  assert.equal(check(mint({ sign: { mutate: "tamper_payload" } })), false);
  assert.equal(check(mint({ sign: { key: "other" } })), false);
  assert.equal(JSON.parse(Buffer.from(mint({ claims: { exp: null } }).split(".")[1], "base64url")).exp, undefined);
});

test("the test origin resolves the spellings the vectors try", () => {
  for (const raw of ["/PAID/a", "/paid/a/", "//paid//a", "/%70aid/a", "/paid/./a", "/x/../paid/a", "/paid/a;x=1", "/paid;x=1/a", "/;x/paid/a", "/.;/paid/a", "/x/..;/paid/a", "/paid%2fa"]) {
    assert.equal(lenientPath(raw), "/paid/a", raw);
  }
});

test("every case names a known profile and a known level", () => {
  for (const c of vectors.cases) {
    assert.ok(vectors.profiles[c.profile], c.id);
    assert.ok(["must", "parity", "should"].includes(c.level), c.id);
  }
  assert.equal(new Set(vectors.cases.map((c) => c.id)).size, vectors.cases.length);
});
