#!/usr/bin/env node
// Writes vectors/gate-v1.json. Golden bodies come from the built ../gate, so a change there shows as a stale file.
//   (cd ../gate && npm ci && npm run build) && node scripts/gen-vectors.mjs
//   node scripts/gen-vectors.mjs --check
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const gateDir = resolve(here, "../../gate");
const G = await import(resolve(gateDir, "dist/index.js"));
const out = resolve(here, "../vectors/gate-v1.json");

const MERCHANT = "mrch_0123456789abcdef";
const API = "{{api}}";
const PAID = "/paid/a";
const PATTERN = "/paid/*";

const fixtures = {
  merchant_id: MERCHANT,
  other_merchant_id: "mrch_fedcba9876543210",
  merchant_secret: "msec_" + "c0".repeat(24),
  issuer: "https://api.aifinpay.io",
  marker: "AIFP-CONFORMANCE-ORIGIN",
  keys: {
    issuer: { kid: "fixture-1", seed_hex: "07".repeat(32) },
    other: { kid: "fixture-1", seed_hex: "09".repeat(32) },
  },
  user_agents: {
    chrome: "Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    gptbot: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    claudebot: "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    perplexity: "Mozilla/5.0 (compatible; PerplexityBot/1.0)",
    chatgpt: "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0",
    sdk: "aifinpay-agent-node/2.14.0",
    none: null,
  },
};

const STANDARD = [{ pattern: PATTERN, tier: "standard" }, { pattern: "/paid-internal/*", tier: "standard" }, { pattern: "/report", tier: "standard" }];
const base = { network_mode: "live", site_verified: true };
const profiles = {
  "content-enforce": { ...base, mode: "enforce", charge: "agents", resources: STANDARD },
  "content-shadow": { ...base, mode: "shadow", charge: "agents", resources: STANDARD },
  "api-enforce": { ...base, mode: "enforce", charge: "everyone", resources: STANDARD },
  "premium-enforce": { ...base, mode: "enforce", charge: "agents", resources: [{ pattern: PATTERN, tier: "premium" }] },
  "complex-enforce": { ...base, mode: "enforce", charge: "agents", resources: [{ pattern: PATTERN, tier: "complex" }] },
  "mixed-enforce": {
    ...base, mode: "enforce", charge: "agents",
    resources: [{ pattern: PATTERN, tier: "standard" }, { pattern: "/paid/premium/*", tier: "premium" }, { pattern: "/open/*", tier: "standard", paywall: false }],
  },
  "testsite-enforce": { network_mode: "test", site_verified: false, mode: "enforce", charge: "agents", resources: STANDARD },
  "policy-enforce": {
    ...base, mode: "enforce", charge: "agents", resources: STANDARD,
    operator_rules: [{ operator: "openai", action: "allow" }, { operator: "anthropic", action: "block" }], operator_default: "charge",
  },
  "policy-shadow": {
    ...base, mode: "shadow", charge: "agents", resources: STANDARD,
    operator_rules: [{ operator: "openai", action: "allow" }, { operator: "anthropic", action: "block" }], operator_default: "charge",
  },
  "policy-block-all": { ...base, mode: "enforce", charge: "agents", resources: STANDARD, operator_rules: [], operator_default: "block" },
  "policy-verified": {
    ...base, mode: "enforce", charge: "agents", resources: STANDARD,
    operator_rules: [{ operator: "aifinpay", action: "allow", verified_only: true }, { ua_class: "aifp_agent", action: "block" }], operator_default: "charge",
  },
};

const challengeArgs = (tier, resource = PATTERN, detail) => ({ merchantId: MERCHANT, resource, tier, weight: G.weightForTier(tier), apiBase: API, ...(detail ? { detail } : {}) });
const golden = {
  "challenge.standard": G.buildChallenge(challengeArgs("standard")),
  "challenge.complex": G.buildChallenge(challengeArgs("complex")),
  "challenge.premium": G.buildChallenge(challengeArgs("premium")),
  "challenge.expired": G.buildChallenge(challengeArgs("standard", PATTERN, G.DETAIL_RECEIPT_EXPIRED)),
  "challenge.exhausted": G.buildChallenge(challengeArgs("standard", PATTERN, G.DETAIL_QUOTA_EXHAUSTED)),
  "discovery.standard": G.buildDiscoveryDocument({ merchantId: MERCHANT, apiBase: API, resources: [{ resource: PATTERN, tier: "standard", scope: "prefix" }] }),
};
const detail = {
  verify: G.DETAIL_VERIFY_FAILED,
  expired: G.DETAIL_RECEIPT_EXPIRED,
  exhausted: G.DETAIL_QUOTA_EXHAUSTED,
};

const cases = [];
const add = (id, level, profile, title, steps, extra = {}) => {
  if (cases.some((c) => c.id === id)) throw new Error(`duplicate case ${id}`);
  cases.push({ id, group: id.split(".")[0], level, profile, title, steps: Array.isArray(steps) ? steps : [steps], ...extra });
};
const get = (ua, path = PAID, more = {}) => ({ method: "GET", path, ua, ...more });
const pay = (receipt = "r", path = PAID, more = {}) => ({ method: "GET", path, ua: "sdk", receipt, agent: "payer", ...more });
const step = (request, expect) => ({ request, expect });
const NOT_SERVED = [301, 302, 307, 308, 400, 402, 403, 404];
// Served, redirected, or an origin with no such page: anything but a refusal of the receipt.
const PAID_SPELLING = [200, 301, 302, 307, 308, 404];
const noOrigin = (status) => ({ status, origin: false });
const served = (headers = {}) => ({ status: 200, origin: true, headers });
const refused403 = (bodyDetail) => ({ status: 403, origin: false, ...(bodyDetail ? { body: { subset: { error: "AIFP-403", detail: bodyDetail } } } : {}) });
const quota = (n) => served({ "aifp-quota-remaining": String(n) });
const noStore = { "cache-control": { contains: "no-store", excludes: "public" } };
const R = (claims = {}, sign = {}) => ({ claims, ...(Object.keys(sign).length ? { sign } : {}) });

// ── 402 body ──────────────────────────────────────────────────────────────
add("challenge.payable", "must", "content-enforce", "An agent without a receipt gets a 402 it can act on", step(get("gptbot"), {
  ...noOrigin(402),
  headers: { "content-type": { contains: "application/json" } },
  body: { subset: { error: "AIFP-402", protocol: "AIFP-1", merchant_id: MERCHANT, resource: PATTERN, tier: "standard", unit_weight: 1, unit_price_usd: "0.0005", min_requests: 40, scope: "exact" } },
}));
add("challenge.exact", "parity", "content-enforce", "The 402 body equals the reference, key order included", step(get("gptbot"), { ...noOrigin(402), body: { golden: "challenge.standard", order: true } }));
add("challenge.complex", "must", "complex-enforce", "A complex tier advertises its own price and weight", step(get("gptbot"), {
  ...noOrigin(402), body: { subset: { tier: "complex", unit_weight: 4, unit_price_usd: "0.002", min_requests: 10 } },
}));
add("challenge.premium", "must", "premium-enforce", "A premium tier advertises its own price and weight", step(get("gptbot"), {
  ...noOrigin(402), body: { subset: { tier: "premium", unit_weight: 10, unit_price_usd: "0.005", min_requests: 4 } },
}));
add("challenge.premium_exact", "parity", "premium-enforce", "The premium 402 equals the reference", step(get("gptbot"), { ...noOrigin(402), body: { golden: "challenge.premium", order: true } }));
add("challenge.query", "must", "content-enforce", "A query string changes nothing about the 402", step(get("gptbot", `${PAID}?utm_source=x`), { ...noOrigin(402), headers: noStore, body: { subset: { error: "AIFP-402", resource: PATTERN } } }));
add("challenge.no_link", "should", "content-enforce", "A JSON 402 carries no discovery Link", step(get("gptbot"), { ...noOrigin(402), headers: { link: null } }));

// ── shadow versus enforce ─────────────────────────────────────────────────
add("mode.enforce_silent", "parity", "content-enforce", "Enforce sends no AIFP-Mode", step(get("gptbot"), { ...noOrigin(402), headers: { "aifp-mode": null } }));
add("mode.shadow_serves_agent", "must", "content-shadow", "Shadow serves the agent enforce would have refused", step(get("gptbot"), served({ "aifp-mode": "shadow" })));
add("mode.shadow_status", "parity", "content-shadow", "Shadow names the status enforce would have sent", step(get("gptbot"), served({ "aifp-shadow-status": "402" })));
add("mode.shadow_human", "must", "content-shadow", "Shadow serves a reader with no would-be status", step(get("chrome"), served({ "aifp-mode": "shadow", "aifp-shadow-status": null })));
add("mode.shadow_elsewhere", "parity", "content-shadow", "Shadow says so outside the protected paths too", step(get("gptbot", "/free/a"), served({ "aifp-mode": "shadow" })));
add("mode.shadow_tampered", "must", "content-shadow", "Shadow never refuses a forged receipt", step(pay("forged"), served()), { receipts: { forged: R({}, { mutate: "tamper_payload" }) } });
add("mode.shadow_other_agent", "must", "content-shadow", "Shadow never refuses another agent's receipt", step(pay("r", PAID, { agent: "other" }), served()), { receipts: { r: R() } });
add("mode.shadow_tampered_status", "parity", "content-shadow", "Shadow verifies, so a forged receipt reads as a would-be 403", step(pay("forged"), served({ "aifp-shadow-status": "403" })), { receipts: { forged: R({}, { mutate: "tamper_payload" }) } });
add("mode.shadow_expired_status", "parity", "content-shadow", "An expired receipt reads as a would-be 402", step(pay("old"), served({ "aifp-shadow-status": "402" })), { receipts: { old: R({ exp: 1000000000 }) } });
add("mode.shadow_spends_nothing", "must", "content-shadow", "A good receipt is verified in shadow and nothing is spent", [1, 2, 3].map(() => step(pay("one"), served({ "aifp-shadow-status": null, "aifp-quota-remaining": null }))), { receipts: { one: R({ unit_quota: 1 }) } });
add("mode.shadow_drained_served", "must", "content-shadow", "A drained receipt never turns shadow into a refusal", Array.from({ length: 5 }, () => step(pay(), served())), { receipts: { r: R() } });

// ── receipts ──────────────────────────────────────────────────────────────
add("receipt.valid", "must", "content-enforce", "A valid receipt opens the page and meters one unit", step(pay(), quota(2)), { receipts: { r: R() } });
add("receipt.tampered", "must", "content-enforce", "A changed payload is refused", step(pay("x"), refused403()), { receipts: { x: R({}, { mutate: "tamper_payload" }) } });
add("receipt.tampered_detail", "parity", "content-enforce", "The refusal uses the reference sentence", step(pay("x"), refused403(detail.verify)), { receipts: { x: R({}, { mutate: "tamper_payload" }) } });
add("receipt.wrong_merchant", "must", "content-enforce", "A receipt for another merchant is refused", step(pay("x"), refused403()), { receipts: { x: R({ aud: "$other_merchant" }) } });
add("receipt.wrong_issuer", "must", "content-enforce", "A receipt from another issuer is refused", step(pay("x"), refused403()), { receipts: { x: R({ iss: "https://evil.example" }) } });
add("receipt.expired", "must", "content-enforce", "An expired receipt gets a new 402", step(pay("x"), { ...noOrigin(402), body: { subset: { error: "AIFP-402", detail: detail.expired } } }), { receipts: { x: R({ exp: 1000000000 }) } });
add("receipt.expired_exact", "parity", "content-enforce", "The expired 402 equals the reference", step(pay("x"), { ...noOrigin(402), body: { golden: "challenge.expired", order: true } }), { receipts: { x: R({ exp: 1000000000 }) } });
add("receipt.past_tolerance", "must", "content-enforce", "Two minutes past exp is expired", step(pay("x"), { ...noOrigin(402), body: { subset: { error: "AIFP-402", detail: detail.expired } } }), { receipts: { x: R({ exp_in: -120 }) } });
add("receipt.clock_tolerance", "parity", "content-enforce", "A receipt ten seconds past exp still verifies", step(pay("x"), served()), { receipts: { x: R({ exp_in: -10 }) } });
add("receipt.nbf_future", "must", "content-enforce", "A receipt not valid yet is refused", step(pay("x"), refused403()), { receipts: { x: R({ nbf: 4102444800 }) } });
add("receipt.iat_future", "parity", "content-enforce", "A future iat alone does not refuse", step(pay("x"), served()), { receipts: { x: R({ iat: 4102444000 }) } });
add("receipt.alg_none", "must", "content-enforce", "alg none is refused", step(pay("x"), refused403()), { receipts: { x: R({}, { mutate: "alg_none" }) } });
add("receipt.alg_hs256", "must", "content-enforce", "HS256 over the public key bytes is refused", step(pay("x"), refused403()), { receipts: { x: R({}, { mutate: "alg_hs256" }) } });
add("receipt.unknown_key", "must", "content-enforce", "A signature by an unknown key is refused", step(pay("x"), refused403()), { receipts: { x: R({}, { key: "other" }) } });
add("receipt.garbage", "must", "content-enforce", "A token that is not a JWT is refused", step(pay("x"), refused403()), { receipts: { x: R({}, { mutate: "garbage" }) } });
add("receipt.action_type", "must", "content-enforce", "A per-action billing receipt buys nothing", step(pay("x"), refused403()), { receipts: { x: R({ typ_aifp: "action" }) } });
add("receipt.quota_type", "must", "content-enforce", "An explicit quota type is spendable", step(pay("x"), served()), { receipts: { x: R({ typ_aifp: "quota" }) } });
add("receipt.no_receipt_id", "must", "content-enforce", "A receipt with no id cannot be metered", step(pay("x"), refused403()), { receipts: { x: R({ receipt_id: null }) } });
add("receipt.no_exp", "must", "content-enforce", "A receipt with no exp is refused", step(pay("x"), refused403()), { receipts: { x: R({ exp: null }) } });
add("receipt.bad_quota", "must", "content-enforce", "A non-numeric unit_quota never serves", step(pay("x"), noOrigin([402, 403])), { receipts: { x: R({ unit_quota: "abc" }) } });
add("receipt.zero_quota", "must", "content-enforce", "A zero unit_quota never serves", step(pay("x"), noOrigin([402, 403])), { receipts: { x: R({ unit_quota: 0 }) } });
add("receipt.legacy_quota", "parity", "content-enforce", "A legacy request quota converts at its tier weight", step(pay("x"), quota(7)), { receipts: { x: R({ unit_quota: null, quota: 2, tier: "complex" }) } });
add("receipt.query", "must", "content-enforce", "A query string does not stop a receipt", step(pay("r", `${PAID}?x=1`), quota(2)), { receipts: { r: R() } });
add("receipt.other_agent", "must", "content-enforce", "A receipt is not spent by an agent naming someone else", step(pay("r", PAID, { agent: "other" }), refused403()), { receipts: { r: R() } });
add("receipt.no_agent_header", "must", "content-enforce", "A receipt with no AIFP-Agent-Id is served, or the refusal says what to send, and it still opens the page with the header", [step(pay("r", PAID, { agent: null }), { status: [200, 403], refusal_names: "AIFP-Agent-Id" }), step(pay(), served())], { receipts: { r: R() } });
add("receipt.agent_case", "should", "content-enforce", "An EVM payer compares without checksum case", step(pay("r", PAID, { agent: "payer_upper" }), served()), { receipts: { r: R() } });
add("receipt.test_on_live", "must", "content-enforce", "A testnet receipt does not open a live site", step(pay("x"), refused403()), { receipts: { x: R({ network_mode: "test" }) } });
add("receipt.test_on_test", "must", "testsite-enforce", "A testnet receipt opens a test site", step(pay("x"), served()), { receipts: { x: R({ network_mode: "test" }) } });
add("receipt.live_on_test", "parity", "testsite-enforce", "A live receipt does not open a test site", step(pay("x"), refused403()), { receipts: { x: R() } });
add("receipt.no_kid", "parity", "content-enforce", "A signed token with no kid verifies against a one-key set", step(pay("x"), served()), { receipts: { x: R({}, { header: { kid: null } }) } });
add("receipt.no_typ", "parity", "content-enforce", "A signed token with no typ verifies", step(pay("x"), served()), { receipts: { x: R({}, { header: { typ: null } }) } });

// ── scope ─────────────────────────────────────────────────────────────────
add("scope.section_protected", "must", "content-enforce", "A wildcard protects the section root", step(get("gptbot", "/paid"), noOrigin(402)));
add("scope.section_root_spend", "must", "content-enforce", "A wildcard receipt covers the section root", step(pay("r", "/paid"), served()), { receipts: { r: R() } });
add("scope.prefix_section_root", "must", "content-enforce", "A batch the SDKs buy for a section opens the section page: they buy prefix /paid/ for a /paid/* 402", step(pay("x", "/paid"), served()), { receipts: { x: R({ resource: "/paid/", scope: "prefix" }) } });
add("scope.prefix_section_slash", "must", "content-enforce", "The same batch opens the section page with a slash", step(pay("x", "/paid/"), { status: [200, 301, 302, 307, 308] }), { receipts: { x: R({ resource: "/paid/", scope: "prefix" }) } });
add("scope.spelling_case", "must", "content-enforce", "A paid batch is not refused over the case of a path", step(pay("r", "/PAID/a"), { status: PAID_SPELLING }), { receipts: { r: R() } });
add("scope.spelling_slash", "must", "content-enforce", "A paid batch is not refused over a trailing slash", step(pay("r", "/paid/a/"), { status: PAID_SPELLING }), { receipts: { r: R() } });
add("scope.spelling_exact_slash", "must", "content-enforce", "A paid batch for an exact pattern is not refused over a trailing slash", step(pay("x", "/report/"), { status: PAID_SPELLING }), { receipts: { x: R({ resource: "/report" }) } });
add("scope.encoded_mark", "must", "content-enforce", "A batch bought for a page with an encoded mark opens that page", step(pay("x", "/paid/what%3Fx"), { status: PAID_SPELLING }), { receipts: { x: R({ resource: "/paid/what%3Fx" }) } });
add("scope.before_the_mark", "must", "content-enforce", "A batch for a page does not open a page that only starts like it", step(pay("x", "/paid/what%3Fx"), noOrigin([403, 404])), { receipts: { x: R({ resource: "/paid/what" }) } });
add("scope.mark_buys_the_page", "must", "content-enforce", "A path priced as the page before an escaped mark opens with a batch for that page", step(pay("x", "/report%3Fx"), { status: PAID_SPELLING }), { receipts: { x: R({ resource: "/report" }) } });
add("scope.encoded_resource", "must", "content-enforce", "A batch bought for an encoded spelling opens that page", step(pay("x", "/paid/my%20report"), { status: PAID_SPELLING }), { receipts: { x: R({ resource: "/paid/my%20report" }) } });
add("scope.other_path", "must", "content-enforce", "An exact receipt for another path is refused", step(pay("x"), refused403()), { receipts: { x: R({ resource: "/other" }) } });
add("scope.other_path_detail", "parity", "content-enforce", "The scope refusal names the scope", step(pay("x"), refused403("receipt is scoped to /other (exact), not /paid/a")), { receipts: { x: R({ resource: "/other" }) } });
add("scope.prefix_slash", "must", "content-enforce", "A prefix receipt covers paths under it", step(pay("x"), served()), { receipts: { x: R({ resource: "/paid/", scope: "prefix" }) } });
add("scope.prefix_bare", "must", "content-enforce", "A prefix without a slash covers paths under it", step(pay("x"), served()), { receipts: { x: R({ resource: "/paid", scope: "prefix" }) } });
add("scope.prefix_boundary", "must", "content-enforce", "A prefix stops at the segment boundary", step(pay("x", "/paid-internal/x"), refused403()), { receipts: { x: R({ resource: "/paid", scope: "prefix" }) } });
add("scope.merchant", "must", "content-enforce", "A merchant receipt covers every path", step(pay("x"), served()), { receipts: { x: R({ resource: "*", scope: "merchant" }) } });
add("scope.unknown_degrades", "parity", "content-enforce", "An unknown scope reads as exact", [step(pay("x"), served()), step(pay("x", "/paid-internal/x"), refused403())], { receipts: { x: R({ scope: "bogus" }) } });
add("scope.missing_resource", "parity", "content-enforce", "A receipt with no resource covers nothing", step(pay("x"), refused403()), { receipts: { x: R({ resource: null }) } });

// ── metering and exhaustion ───────────────────────────────────────────────
add("meter.drain", "must", "content-enforce", "A batch of three serves three times, then a 402", [
  step(pay(), quota(2)), step(pay(), quota(1)), step(pay(), quota(0)),
  step(pay(), { ...noOrigin(402), body: { subset: { error: "AIFP-402" } } }),
], { receipts: { r: R() } });
add("meter.exhausted_exact", "parity", "content-enforce", "The exhausted 402 equals the reference", [step(pay(), quota(1)), step(pay(), quota(0)), step(pay(), { ...noOrigin(402), body: { golden: "challenge.exhausted", order: true } })], { receipts: { r: R({ unit_quota: 2 }) } });
add("meter.weight", "must", "premium-enforce", "A premium call takes ten units", [step(pay(), quota(15)), step(pay(), quota(5)), step(pay(), noOrigin(402))], { receipts: { r: R({ unit_quota: 25, tier: "premium" }) } });
add("meter.weight_over_quota", "must", "premium-enforce", "A call heavier than the batch is not served", step(pay(), noOrigin(402)), { receipts: { r: R({ unit_quota: 5, tier: "premium" }) } });
add("meter.refused_keeps_units", "must", "mixed-enforce", "A call that does not fit takes nothing", [
  step(pay("r", "/paid/premium/x"), noOrigin(402)), step(pay("r", PAID), quota(4)),
], { receipts: { r: R({ unit_quota: 5, resource: "*", scope: "merchant" }) } });
add("meter.longest_match", "must", "mixed-enforce", "The longest pattern sets the price", step(get("gptbot", "/paid/premium/x"), { ...noOrigin(402), body: { subset: { resource: "/paid/premium/*", tier: "premium", unit_weight: 10 } } }));
add("meter.open_route", "parity", "mixed-enforce", "A route with the paywall off is served to an agent", step(get("gptbot", "/open/x"), served({ "aifp-paywall": "off" })));
add("meter.concurrent", "must", "content-enforce", "Twenty concurrent calls on five units serve exactly five", step(pay(), { concurrent: 20, served: 5, refused: 15, refused_status: [402] }), { receipts: { r: R({ unit_quota: 5 }) } });
add("meter.shared_counter", "must", "content-enforce", "One receipt has one counter across paths", [step(pay("r", "/paid/a"), quota(2)), step(pay("r", "/paid/b"), quota(1))], { receipts: { r: R({ resource: "/paid", scope: "prefix" }) } });
add("meter.single_use_replay", "must", "content-enforce", "A single-use receipt is served once", [step(pay(), served()), step(pay(), noOrigin([402, 403]))], { receipts: { r: R({ unit_quota: 1 }) } });
add("meter.single_use_no_nonce", "parity", "content-enforce", "A single-use receipt with no nonce is refused", step(pay(), refused403()), { receipts: { r: R({ unit_quota: 1, nonce: null }) } });
add("meter.survives_restart", "must", "content-enforce", "Spent units stay spent after a restart", [step(pay(), quota(2)), { action: "restart" }, step(pay(), quota(1))], { receipts: { r: R() }, needs: ["restart"] });

// ── cache ─────────────────────────────────────────────────────────────────
add("cache.challenge", "must", "content-enforce", "A 402 is never stored", step(get("gptbot"), { ...noOrigin(402), headers: noStore }));
add("cache.refusal", "must", "content-enforce", "A 403 is never stored", step(pay("x"), { ...noOrigin(403), headers: noStore }), { receipts: { x: R({}, { mutate: "tamper_payload" }) } });
add("cache.unavailable", "must", "content-enforce", "A 503 is never stored", step(pay(), { ...noOrigin(503), headers: noStore }), { receipts: { r: R() }, fault: { jwks: true }, needs: ["fault:jwks"] });
add("cache.paid", "must", "content-enforce", "A paid response is never stored, whatever the origin says", step(pay(), { status: 200, origin: true, headers: noStore }), { receipts: { r: R() } });
add("cache.paid_at_cdn", "must", "content-enforce", "A paid response carries nothing a CDN reads before Cache-Control as leave to store it", step(pay(), { status: 200, origin: true, headers: Object.fromEntries(["cdn-cache-control", "surrogate-control", "edge-control", "akamai-cache-control", "x-accel-expires"].map((name) => [name, { absentOr: ["no-store", "0"] }])) }), { receipts: { r: R() } });
add("cache.exempt", "must", "content-enforce", "A reader's copy of a protected page cannot answer an agent", step(get("chrome"), { status: 200, origin: true, headers: noStore }), { unless: "pre_cache" });
add("cache.shadow_agent", "should", "content-shadow", "An agent's shadow response is not stored", step(get("gptbot"), { status: 200, origin: true, headers: noStore }), { unless: "pre_cache" });
add("cache.shadow_keeps_origin", "should", "content-shadow", "Shadow leaves the origin's cache header alone before a cache it runs ahead of", step(get("gptbot"), served({ "cache-control": "public, max-age=600", "cdn-cache-control": "public, max-age=600", "surrogate-control": "max-age=600" })), { needs: ["pre_cache", "proxy"] });
add("cache.real_exempt_then_agent", "must", "content-enforce", "A real cache holding a reader's copy still answers an agent with a 402", [
  step(get("chrome", "/paid/cached"), { status: 200, origin: true }),
  step(get("chrome", "/paid/cached"), { status: 200, origin: true }),
  step(get("gptbot", "/paid/cached"), noOrigin(402)),
], { needs: ["real_cache"] });
add("cache.real_decision_not_cached", "must", "content-enforce", "A cached decision does not admit the next agent", [
  step(get("chrome", "/paid/decision"), { status: 200, origin: true }),
  step(get("gptbot", "/paid/decision"), noOrigin(402)),
  step(get("chrome", "/paid/decision"), { status: 200, origin: true }),
], { needs: ["real_cache"] });
add("cache.real_paid_not_stored", "must", "content-enforce", "A real cache never hands a paid response to the next caller", [
  step(pay("r", "/paid/stored"), quota(2)), step(get("gptbot", "/paid/stored"), noOrigin(402)),
], { receipts: { r: R() }, needs: ["real_cache"] });
add("cache.real_challenge_not_stored", "must", "content-enforce", "A real cache never hands a 402 to the agent that paid", [
  step(get("gptbot", "/paid/held"), noOrigin(402)), step(pay("r", "/paid/held"), quota(2)),
], { receipts: { r: R() }, needs: ["real_cache"] });

// ── human versus agent ────────────────────────────────────────────────────
add("classify.reader_exempt", "must", "content-enforce", "A browser is served free on a content site", step(get("chrome"), served({ "aifp-quota-remaining": null })));
add("classify.reader_header", "parity", "content-enforce", "A reader's response says it was exempt", step(get("chrome"), served({ "aifp-paywall": "exempt" })));
add("classify.table", "must", "content-enforce", "Every marker in the table is charged", G.AI_AGENT_UA_MARKERS.map((marker) => step(get(`Mozilla/5.0 (compatible; ${marker}/1.0)`), noOrigin(402))));
add("classify.empty_ua", "must", "content-enforce", "No User-Agent is charged", step(get("none"), noOrigin(402)));
add("classify.ua_case", "must", "content-enforce", "Markers match in any case", step(get("Mozilla/5.0 (compatible; GPTBOT/1.0)"), noOrigin(402)));
add("classify.browser_agent_id", "must", "content-enforce", "A browser User-Agent with an agent id pays", step(get("chrome", PAID, { agent: "payer" }), noOrigin(402)));
add("classify.browser_receipt", "must", "content-enforce", "A browser User-Agent with a receipt is metered", step(pay("r", PAID, { ua: "chrome" }), quota(2)), { receipts: { r: R() } });
add("classify.charge_everyone", "must", "api-enforce", "An API charges a browser too", step(get("chrome"), noOrigin(402)));
add("classify.unprotected", "should", "content-enforce", "A path outside every pattern is not gated", step(get("gptbot", "/free/a"), served()));

// ── events on the wire ────────────────────────────────────────────────────
const ev = (kind, operator, ua_class, verified, more = {}) => ({ kind, resource: PATTERN, operator, ua_class, verified, ...more });
const eventCase = (id, level, profile, title, steps, events, extra = {}) => add(id, level, profile, title, steps, { events, needs: ["events"], ...extra });
eventCase("events.challenge", "must", "content-enforce", "A 402 reports who asked", step(get("gptbot"), noOrigin(402)), [ev("402", "openai", "ai_crawler", false)]);
eventCase("events.serve", "must", "content-enforce", "A paid serve reports a verified AIFP agent", step(pay(), served()), [ev("serve", "aifinpay", "aifp_agent", true)], { receipts: { r: R() } });
eventCase("events.reader_silent", "must", "content-enforce", "A reader is never reported", step(get("chrome"), served()), []);
eventCase("events.shadow_challenge", "must", "content-shadow", "Shadow reports the same 402", step(get("gptbot"), served()), [ev("402", "openai", "ai_crawler", false)]);
eventCase("events.operators", "parity", "content-enforce", "Operators and classes follow the table", [step(get("claudebot"), noOrigin(402)), step(get("chatgpt"), noOrigin(402)), step(get("perplexity"), noOrigin(402))],
  [ev("402", "anthropic", "ai_crawler", false), ev("402", "openai", "ai_agent_browser", false), ev("402", "perplexity", "ai_crawler", false)]);
eventCase("events.refusal_off_wire", "must", "content-enforce", "A 403 is not sent to an ingest that would refuse the batch", step(pay("x"), noOrigin(403)), [], { receipts: { x: R({}, { mutate: "tamper_payload" }) } });
eventCase("events.stray_path", "must", "content-enforce", "A crawler on an unregistered path does not cost the report", [step(get("gptbot", "/free/stray-token-abc"), {}), step(get("gptbot"), noOrigin(402))], [ev("402", "openai", "ai_crawler", false)]);
eventCase("mode.shadow_receipt_event", "parity", "content-shadow", "Shadow reports a good receipt as verified", [step(pay(), served())], [{ kind: "serve", resource: PATTERN, operator: "aifinpay", ua_class: "aifp_agent", verified: true }], { receipts: { r: R() } });
eventCase("events.open_route", "must", "mixed-enforce", "A free route is not a paid admission, and a reader is not reported on it", [step(get("chrome", "/open/x"), served()), step(get("gptbot", "/open/x"), served())], [{ kind: "serve", resource: "/open/*", operator: "openai", ua_class: "ai_crawler", verified: false, exempt: true }]);
eventCase("events.table", "parity", "content-enforce", "Every marker reports its operator and class", G.AI_AGENT_UA_TABLE.map((row) => step(get(`Mozilla/5.0 (compatible; ${row.marker}/1.0)`), noOrigin(402))), G.AI_AGENT_UA_TABLE.map((row) => ev("402", row.operator, row.ua_class, false)));
add("events.ingest_down", "must", "content-enforce", "An ingest outage changes no response", [step(get("gptbot"), noOrigin(402)), step(get("chrome"), served())], { fault: { ingest: 503 }, needs: ["events"] });

// ── operator rules ────────────────────────────────────────────────────────
add("policy.allow", "must", "policy-enforce", "An allowed operator is served free", step(get("gptbot"), served({ "aifp-paywall": "exempt" })));
add("policy.block", "must", "policy-enforce", "A blocked operator gets a 403", step(get("claudebot"), refused403("blocked by merchant policy (operator rule)")));
add("policy.charge", "must", "policy-enforce", "An operator with no rule is charged", step(get("perplexity"), noOrigin(402)));
eventCase("policy.allow_event", "must", "policy-enforce", "An allowed operator is reported as an exempt serve", step(get("gptbot"), served()), [ev("serve", "openai", "ai_crawler", false, { exempt: true })]);
add("policy.default_block_reader", "must", "policy-block-all", "A default block never reaches a reader", [step(get("chrome"), served()), step(get("none"), noOrigin(403))]);
add("policy.shadow_block", "must", "policy-shadow", "Shadow serves what a rule would block and says so", step(get("claudebot"), served({ "aifp-shadow-status": "403" })));
add("policy.verified_only", "parity", "policy-verified", "A verified_only rule answers only after the receipt verifies", [step(pay(), served({ "aifp-paywall": "exempt" })), step(get("chrome", PAID, { agent: "payer" }), noOrigin(403))], { receipts: { r: R() } });

// ── spellings of a protected path ─────────────────────────────────────────
const alias = (id, title, path) => add(`path.${id}`, "must", "content-enforce", title, step(get("gptbot", path), noOrigin(NOT_SERVED)));
alias("case", "A case change does not walk around the gate", "/PAID/a");
alias("trailing_slash", "A trailing slash does not walk around the gate", "/paid/a/");
alias("double_slash", "A doubled slash does not walk around the gate", "//paid//a");
alias("encoded", "An encoded letter does not walk around the gate", "/%70aid/a");
alias("dot", "A dot segment does not walk around the gate", "/paid/./a");
alias("dotdot", "A dot-dot segment does not walk around the gate", "/x/../paid/a");
alias("matrix_end", "A matrix parameter does not walk around the gate", "/paid/a;x=1");
alias("matrix_mid", "A matrix parameter mid-path does not walk around the gate", "/paid;x=1/a");
alias("matrix_start", "A leading matrix segment does not walk around the gate", "/;x/paid/a");
alias("dot_matrix", "A dot with a parameter does not walk around the gate", "/.;/paid/a");
alias("dotdot_matrix", "A dot-dot with a parameter does not walk around the gate", "/x/..;/paid/a");
alias("encoded_slash", "An encoded slash does not walk around the gate", "/paid%2fa");
alias("exact_trailing_slash", "A trailing slash does not walk around an exact pattern", "/report/");
alias("exact_case", "A case change does not walk around an exact pattern", "/Report");
alias("exact_query", "A query string does not walk around an exact pattern", "/report?utm_source=x");
alias("encoded_query_mark", "An encoded question mark does not end the path", "/x%3F/../paid/a");
alias("encoded_hash", "An encoded hash does not end the path", "/x%23/../paid/a");
alias("mark_ends_exact", "An escaped mark does not walk around an exact pattern behind a proxy that decodes", "/report%3Fx");
alias("mark_ends_section", "An escaped mark does not walk around a section behind a proxy that decodes", "/paid%3Fx");
alias("hash_ends_exact", "An escaped hash does not walk around an exact pattern behind a proxy that decodes", "/report%23x");
alias("still_encoded", "A dot segment still encoded after the last round does not walk around the gate", "/paid/%2525252e%2525252e/x");
alias("still_encoded_deeper", "One layer deeper, for a server that decodes before the gate", "/paid/%252525252e%252525252e/x");
alias("dotdot_param_pop", "A dot-dot with a parameter does not move the price", "/paid/..;/x");
alias("matrix_dotdot_pop", "A dot-dot behind a parameter does not pop past the pattern", "/paid/..;/../a");
alias("empty_dotdot", "A dot-dot behind an empty segment does not pop past the pattern", "/paid//../a");
alias("double_encoded_dotdot", "A double-encoded dot-dot does not pop past the pattern", "/paid/%252e%252e/../a");
alias("backslash", "A backslash does not walk around the gate", "/paid\\a");
alias("backslash_dotdot", "Backslashes and dot-dots do not pop past the pattern", "/paid/x\\..\\../../a");
alias("double_encoded", "A double-encoded letter does not walk around the gate", "/%2570aid/a");
add("path.case_no_discount", "must", "mixed-enforce", "A case change does not buy the cheap price", step(get("gptbot", "/PAID/PREMIUM/x"), { ...noOrigin(NOT_SERVED), weight_at_least: 10 }));
add("path.boundary", "should", "content-enforce", "A similar path outside the pattern is not charged as it", step(get("gptbot", "/paidx/a"), served()));

// ── discovery ─────────────────────────────────────────────────────────────
add("discovery.x402", "should", "content-enforce", "The discovery document names the merchant and the quote endpoint", step(get("gptbot", "/.well-known/x402.json"), {
  status: 200, origin: false, headers: { "content-type": { contains: "application/json" } },
  body: { subset: { protocol: "AIFP-1", merchant_id: MERCHANT, quote_endpoint: `${API}/v1/quote`, pay_endpoint: `${API}/v1/pay` } },
}));
add("discovery.x402_query", "should", "content-enforce", "A query string does not lose the discovery document", step(get("gptbot", "/.well-known/x402.json?x=1"), { status: 200, origin: false, body: { subset: { protocol: "AIFP-1" } } }));
add("discovery.x402_tier", "parity", "premium-enforce", "The document prices each resource at its tier", step(get("gptbot", "/.well-known/x402.json"), { status: 200, origin: false, body: { resource_tier: { "/paid/*": "premium" } } }));
add("discovery.link", "should", "content-enforce", "An HTML page points at the agent documents", step(get("chrome", "/free/a"), served({ link: { contains: "/llms.txt" } })));
add("discovery.llms", "should", "content-enforce", "/llms.txt is served as markdown", step(get("chrome", "/llms.txt"), { status: 200, headers: { "content-type": { contains: "text/markdown" } } }), { needs: ["llms_txt"] });

// ── proxies only ──────────────────────────────────────────────────────────
add("pass.origin_error", "must", "content-shadow", "An origin error passes through unchanged", step(get("gptbot", "/paid/err503"), { status: 503, body: { text: "ORIGIN-503" } }), { needs: ["proxy"] });
add("pass.shadow_odd_path", "must", "content-shadow", "Shadow does not refuse a path it finds odd", [step(get("gptbot", "/free/a%0Ab"), { status: 200, origin: true }), step(get("gptbot", "/free/50%2500"), { status: 200, origin: true })], { needs: ["proxy"] });
add("pass.encoded_page", "must", "content-enforce", "A page with an escape outside every pattern is not refused", step(get("chrome", "/free/caf%C3%A9"), { status: [200, 402, 404] }));
add("pass.dot_directory", "must", "content-enforce", "A directory that starts with a dot is not a dot segment", step(get("chrome", "/.well-known/acme-challenge/x"), { status: [200, 402, 403, 404] }));
add("pass.reader_odd_path", "should", "content-enforce", "A reader is not refused over a dot segment", step(get("chrome", "/paid/./a"), { status: [200, 301, 302, 307, 308, 403, 404] }));
add("pass.long_url", "must", "content-shadow", "Shadow does not refuse a long URL the origin accepts", step(get("gptbot", `/free/${"x".repeat(20000)}`), { status: 200, origin: true }), { needs: ["proxy"] });
add("pass.post_body", "must", "content-enforce", "A POST body reaches the origin intact", step({ method: "POST", path: "/free/echo", ua: "chrome", body_bytes: 262144 }, { status: 200, origin: true, body_sha256: true }), { needs: ["proxy"] });
add("pass.receipt_stripped", "should", "content-enforce", "A receipt is not forwarded to the origin", step(pay(), { status: 200, origin: true, origin_did_not_see: ["aifp-receipt"] }), { receipts: { r: R() }, needs: ["proxy"] });
add("pass.spoofed_uri", "must", "content-enforce", "A client cannot name another path to the decision", step(get("gptbot", PAID, { headers: { "X-Original-URI": "/free/a", "X-Original-Method": "OPTIONS" } }), noOrigin(402)), { needs: ["proxy"] });

// ── what happens when something is down ───────────────────────────────────
add("fail.jwks_no_receipt", "must", "content-enforce", "A key outage does not touch a 402", step(get("gptbot"), noOrigin(402)), { fault: { jwks: true }, needs: ["fault:jwks"] });
add("fail.jwks_receipt", "must", "content-enforce", "A key outage fails closed", step(pay(), { ...noOrigin(503), headers: { "retry-after": { present: true } }, body: { subset: { error: "AIFP-503-METER" } } }), { receipts: { r: R() }, fault: { jwks: true }, needs: ["fault:jwks"] });
add("fail.jwks_reader", "must", "content-enforce", "A key outage does not touch a reader", step(get("chrome"), served()), { fault: { jwks: true }, needs: ["fault:jwks"] });
add("fail.jwks_shadow", "must", "content-shadow", "A key outage does not touch a shadow site", step(pay(), served()), { receipts: { r: R() }, fault: { jwks: true }, needs: ["fault:jwks"] });
add("fail.store_receipt", "must", "content-enforce", "A meter outage fails closed", step(pay(), { ...noOrigin(503), headers: { "retry-after": { present: true } } }), { receipts: { r: R() }, fault: { store: true }, needs: ["fault:store"] });
add("fail.store_shadow", "must", "content-shadow", "A meter outage does not touch a shadow site", step(pay(), served()), { receipts: { r: R() }, fault: { store: true }, needs: ["fault:store"] });
add("fail.record_reader", "must", "content-enforce", "A control plane outage at boot does not touch a reader", step(get("chrome"), served()), { fault: { record: true }, needs: ["fault:record"] });
add("fail.record_shadow", "must", "content-shadow", "A control plane outage at boot does not touch a shadow site", [step(get("chrome"), served()), step(get("gptbot"), served())], { fault: { record: true }, needs: ["fault:record"] });
add("fail.origin_keeps_units", "should", "content-enforce", "An origin that cannot be reached costs no units", [step(pay(), noOrigin([502, 503, 504])), { action: "origin_up" }, step(pay(), quota(2))], { receipts: { r: R() }, fault: { origin: true }, needs: ["fault:origin"] });
add("fail.decision_down_shadow", "must", "content-shadow", "A decision service outage does not touch a shadow site", step(get("gptbot"), served()), { fault: { decision: true }, needs: ["fault:decision"] });
add("fail.decision_down_enforce", "must", "content-enforce", "A decision service outage fails closed for an agent", step(get("gptbot"), noOrigin([500, 502, 503, 504])), { fault: { decision: true }, needs: ["fault:decision"] });

// ── verbs ─────────────────────────────────────────────────────────────────
add("method.post", "must", "content-enforce", "A POST is charged like a GET", step({ method: "POST", path: PAID, ua: "gptbot" }, noOrigin(402)));
add("method.head", "must", "content-enforce", "A HEAD is charged like a GET", step({ method: "HEAD", path: PAID, ua: "gptbot" }, noOrigin(402)));
add("method.options", "parity", "content-enforce", "An OPTIONS is charged like a GET", step({ method: "OPTIONS", path: PAID, ua: "gptbot" }, noOrigin(402)));

const vectors = {
  schema: 1,
  reference: `@aifinpay/gate ${JSON.parse(readFileSync(resolve(gateDir, "package.json"), "utf8")).version}`,
  fixtures,
  profiles,
  golden,
  operators: G.GATE_OPERATORS,
  ua_classes: G.UA_CLASSES,
  cases,
};

const text = JSON.stringify(vectors, null, 1) + "\n";
if (process.argv.includes("--check")) {
  if (readFileSync(out, "utf8") !== text) {
    console.error("vectors/gate-v1.json is stale: run scripts/gen-vectors.mjs");
    process.exit(1);
  }
  console.log(`vectors up to date: ${cases.length} cases`);
} else {
  writeFileSync(out, text);
  console.log(`wrote ${out}: ${cases.length} cases, ${Object.keys(profiles).length} profiles`);
}
