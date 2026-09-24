#!/usr/bin/env node
// Records what @aifinpay/gate (../gate, built) answers, so the Python port can
// be held to it: tests/test_parity.py replays every scenario and requires the
// same status, headers and body. Regenerate after changing the Node gate:
//
//   (cd ../gate && npm ci && npm run build) && node scripts/gen-parity-fixtures.mjs
//   node scripts/gen-parity-fixtures.mjs --check   # CI: fail if the fixture is stale
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, createPublicKey } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const gateDir = resolve(here, "../../gate");
const G = await import(resolve(gateDir, "dist/index.js"));
const { SignJWT } = await import(resolve(gateDir, "node_modules/jose/dist/node/esm/index.js")).catch(() =>
  import(resolve(gateDir, "node_modules/jose/dist/webapi/index.js"))
);
const out = resolve(here, "../tests/fixtures/parity.json");

// Fixed test key (seed 0x07 * 32) — never used outside these fixtures.
const seed = Buffer.alloc(32, 7);
const priv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), seed]), format: "der", type: "pkcs8" });
const pubJwk = { ...createPublicKey(priv).export({ format: "jwk" }), kid: "fixture-1", alg: "EdDSA", use: "sig" };
const otherPriv = createPrivateKey({ key: Buffer.concat([Buffer.from("302e020100300506032b657004220420", "hex"), Buffer.alloc(32, 9)]), format: "der", type: "pkcs8" });

const ISS = "https://api.aifinpay.io", MID = "mrch_parity", FAR = 4102444800;
const base = { iss: ISS, aud: MID, sub: "0x00000000000000000000000000000000000000a1", iat: 1758700000, exp: FAR,
  resource: "/paid", scope: "exact", amount: "0.1", unit_quota: 3, receipt_id: "rcpt_0000000000000001", nonce: "n-1" };
async function sign(claims, { key = priv, kid = "fixture-1", header = {} } = {}) {
  return new SignJWT(claims).setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid, ...header }).sign(key);
}
const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const hs256 = `${b64({ alg: "HS256", typ: "JWT", kid: "fixture-1" })}.${b64(base)}.c2lnbmF0dXJl`;
const none = `${b64({ alg: "none", typ: "JWT" })}.${b64(base)}.`;
const t = async (over, opts) => sign({ ...base, ...over }, opts);

const scenarios = [
  { name: "no receipt → 402", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: {} }] },
  { name: "batch of 3 drains then 402", opts: { resource: "/paid" }, reqs: Array(4).fill({ path: "/paid", headers: { "AIFP-Receipt": await t({}) } }) },
  { name: "premium weight 10 on 25 units", opts: { resource: "/paid", tier: "premium" },
    reqs: Array(3).fill({ path: "/paid", headers: { "AIFP-Receipt": await t({ unit_quota: 25, receipt_id: "rcpt_0000000000000002" }) } }) },
  { name: "custom weight", opts: { resource: "/paid", weight: 2 }, reqs: Array(2).fill({ path: "/paid", headers: { "AIFP-Receipt": await t({ unit_quota: 3 }) } }) },
  { name: "other merchant", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({ aud: "mrch_other" }) } }] },
  { name: "unknown issuer", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({ iss: "https://evil.example" }) } }] },
  { name: "expired → 402", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({ exp: 1000000000 }) } }] },
  { name: "not yet valid", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({ nbf: FAR }) } }] },
  { name: "wrong scope", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({ resource: "/other" }) } }] },
  { name: "prefix scope covers", opts: { resource: "/articles/1" }, reqs: [{ path: "/articles/1", headers: { "AIFP-Receipt": await t({ scope: "prefix", resource: "/articles/" }) } }] },
  { name: "prefix boundary", opts: { resource: "/articles-internal" }, reqs: [{ path: "/articles-internal", headers: { "AIFP-Receipt": await t({ scope: "prefix", resource: "/articles" }) } }] },
  { name: "merchant scope", opts: { resource: "/anything" }, reqs: [{ path: "/anything", headers: { "AIFP-Receipt": await t({ scope: "merchant", resource: "*" }) } }] },
  { name: "wildcard exact", opts: { resource: "/movies/11" }, reqs: [{ path: "/movies/11", headers: { "AIFP-Receipt": await t({ resource: "/movies/*" }) } }] },
  { name: "garbage", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": "not.a.jwt" } }] },
  { name: "HS256 confusion", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": hs256 } }] },
  { name: "alg none", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": none } }] },
  { name: "unknown key", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({}, { key: otherPriv }) } }] },
  { name: "action receipt", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({ typ_aifp: "action" }) } }] },
  { name: "explicit quota type", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({ typ_aifp: "quota" }) } }] },
  { name: "no receipt_id", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({ receipt_id: undefined }) } }] },
  { name: "single-use replay", opts: { resource: "/paid" }, reqs: Array(2).fill({ path: "/paid", headers: { "AIFP-Receipt": await t({ unit_quota: 1, receipt_id: "rcpt_0000000000000003", nonce: "n-single" }) } }) },
  { name: "single-use without nonce", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({ unit_quota: 1, nonce: undefined }) } }] },
  { name: "legacy quota at tier weight", opts: { resource: "/paid" }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({ unit_quota: undefined, quota: 2, tier: "complex" }) } }] },
  { name: "agent mismatch", opts: { resource: "/paid", requireAgentMatch: true }, reqs: [{ path: "/paid", headers: { "AIFP-Receipt": await t({}), "AIFP-Agent-Id": "0xsomeoneelse" } }] },
  { name: "human browser exempt", opts: { resource: "/paid", shouldCharge: "known" }, reqs: [{ path: "/paid", headers: { "User-Agent": "Mozilla/5.0 (Macintosh) Safari/605.1.15" } }] },
  { name: "crawler charged", opts: { resource: "/paid", shouldCharge: "known" }, reqs: [{ path: "/paid", headers: { "User-Agent": "Mozilla/5.0 (compatible; GPTBot/1.1)" } }] },
  { name: "empty UA charged", opts: { resource: "/paid", shouldCharge: "known" }, reqs: [{ path: "/paid", headers: {} }] },
  { name: "paying agent with browser UA metered", opts: { resource: "/paid", shouldCharge: "known" },
    reqs: [{ path: "/paid", headers: { "User-Agent": "Mozilla/5.0 Safari", "AIFP-Receipt": await t({}) } }] },
  { name: "api base override", opts: { resource: "/paid", apiBase: "https://staging.example/" }, reqs: [{ path: "/paid", headers: {} }] },
];

const results = [];
for (const s of scenarios) {
  const gate = G.createGate({
    merchantId: MID, jwks: { keys: [pubJwk] }, resource: s.opts.resource, tier: s.opts.tier, weight: s.opts.weight,
    requireAgentMatch: s.opts.requireAgentMatch, apiBase: s.opts.apiBase,
    ...(s.opts.shouldCharge === "known" ? { shouldCharge: G.knownAiAgent } : {}),
  });
  const reqs = [];
  for (const r of s.reqs) {
    const lower = Object.fromEntries(Object.entries(r.headers).map(([k, v]) => [k.toLowerCase(), v]));
    const res = await gate({ path: r.path, header: (n) => lower[n.toLowerCase()] });
    reqs.push({ ...r, result: res });
  }
  results.push({ name: s.name, opts: s.opts, requests: reqs });
}

const tiers = ["standard", "complex", "premium"];
const scopeCases = [];
for (const scope of ["exact", "prefix", "merchant", undefined, "bogus"])
  for (const resource of ["/", "/a", "/a/", "/a/*", "/a/b"])
    for (const path of ["/", "/a", "/a/", "/a/b", "/a/b/c", "/ab", "/b"])
      scopeCases.push([scope ?? null, resource, path, G.scopeCovers(scope, resource, path)]);

const fixture = {
  generated_from: "@aifinpay/gate " + JSON.parse(readFileSync(resolve(gateDir, "package.json"), "utf8")).version,
  jwks: { keys: [pubJwk] },
  merchant_id: MID,
  constants: {
    DETAIL_QUOTA_EXHAUSTED: G.DETAIL_QUOTA_EXHAUSTED, DETAIL_RECEIPT_EXPIRED: G.DETAIL_RECEIPT_EXPIRED,
    DETAIL_VERIFY_FAILED: G.DETAIL_VERIFY_FAILED, HEADER_QUOTA_REMAINING: G.HEADER_QUOTA_REMAINING,
    AI_AGENT_UA_MARKERS: G.AI_AGENT_UA_MARKERS, TIER_WEIGHTS: G.TIER_WEIGHTS, UNIT_PRICE_USD: G.UNIT_PRICE_USD,
    min_requests: Object.fromEntries(tiers.map((t) => [t, G.minRequestsForTier(t)])),
    REDIS_INCRBY_SCRIPT: G.REDIS_INCRBY_SCRIPT,
  },
  challenges: tiers.flatMap((tier) => [
    { args: { merchant_id: MID, resource: "/api/x", tier, weight: G.weightForTier(tier) },
      body: G.buildChallenge({ merchantId: MID, resource: "/api/x", tier, weight: G.weightForTier(tier) }) },
    { args: { merchant_id: MID, resource: "/api/*", tier, weight: 7, detail: "custom", scope: "prefix", api_base: "https://staging.example//" },
      body: G.buildChallenge({ merchantId: MID, resource: "/api/*", tier, weight: 7, detail: "custom", scope: "prefix", apiBase: "https://staging.example//" }) },
  ]),
  discovery: {
    args: { merchant_id: MID, resources: [{ resource: "/api/a" }, { resource: "/api/*", tier: "premium", scope: "prefix", name: "All" }], api_base: "https://api.aifinpay.io/" },
    body: G.buildDiscoveryDocument({ merchantId: MID, resources: [{ resource: "/api/a" }, { resource: "/api/*", tier: "premium", scope: "prefix", name: "All" }], apiBase: "https://api.aifinpay.io/" }),
  },
  scope_cases: scopeCases,
  scenarios: results,
};

const text = JSON.stringify(fixture, null, 1) + "\n";
if (process.argv.includes("--check")) {
  // Tokens are freshly signed each run (Ed25519 is deterministic, so they are
  // stable) — any difference means the Node gate changed.
  const cur = readFileSync(out, "utf8");
  if (cur !== text) { console.error("parity fixture is stale — run scripts/gen-parity-fixtures.mjs"); process.exit(1); }
  console.log("parity fixture up to date");
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}: ${results.length} scenarios, ${scopeCases.length} scope cases`);
}
