#!/usr/bin/env node
// Writes vectors/gate-v1.json. Golden bodies come from the built ../gate, so a change there shows as a stale file.
//   (cd ../gate && npm ci && npm run build) && node scripts/gen-vectors.mjs
//   node scripts/gen-vectors.mjs --check
import { createHmac } from "node:crypto";
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
  // A live site whose gate was not told its network (a static mount); a gate that reads the record knows it is live.
  "unsaid-enforce": { ...base, network_known: false, mode: "enforce", charge: "agents", resources: STANDARD },
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
  "about-enforce": {
    ...base, mode: "enforce", charge: "agents", resources: STANDARD,
    // What the subject's `about` function returns per path; "throw" throws, anything else is returned as is.
    about: {
      "/paid/a": { title: "Fish and chips", description: "Where to eat them." },
      "/paid/markup": { title: "<h1>Menu</h1> <em>today</em>", description: "<p>Daily&nbsp;&nbsp;specials</p>\n<p>Fish &amp; chips &mdash; fresh</p>" },
      "/paid/long": { title: "t".repeat(250), description: "d".repeat(350) },
      "/paid/throws": "throw",
      "/paid/shape": "a string is not an object",
    },
  },
};

const challengeArgs = (tier, resource = PATTERN, detail) => ({ merchantId: MERCHANT, resource, tier, weight: G.weightForTier(tier), apiBase: API, ...(detail ? { detail } : {}) });
const golden = {
  "challenge.standard": G.buildChallenge(challengeArgs("standard")),
  "challenge.complex": G.buildChallenge(challengeArgs("complex")),
  "challenge.premium": G.buildChallenge(challengeArgs("premium")),
  "challenge.expired": G.buildChallenge(challengeArgs("standard", PATTERN, G.DETAIL_RECEIPT_EXPIRED)),
  "challenge.exhausted": G.buildChallenge(challengeArgs("standard", PATTERN, G.DETAIL_QUOTA_EXHAUSTED)),
  "challenge.about": G.buildChallenge({ ...challengeArgs("standard"), about: profiles["about-enforce"].about["/paid/a"] }),
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
add("receipt.test_on_unsaid", "must", "unsaid-enforce", "A testnet receipt does not open a site that has not said it is a test site", step(pay("x"), refused403()), { receipts: { x: R({ network_mode: "test" }) } });
add("receipt.live_on_unsaid", "must", "unsaid-enforce", "A live or unmarked receipt opens a site that has not said its network", [step(pay("x"), served()), step(pay("y"), served())], { receipts: { x: R(), y: R({ network_mode: "live" }) } });
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
alias("mark_in_param", "An escaped mark in a parameter does not walk around the gate", "/report;a%3Fb/c");
alias("mark_in_encoded_param", "An escaped mark in an encoded parameter does not walk around the gate", "/report%3Ba%3Fb/c");
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

// ── content licence (AIFINP-262) ──────────────────────────────────────────
const LIC = { id: "clic_" + "ab".repeat(12), rev: 2, v: "2.0", sha256: "3".repeat(64), confirmed: false };
const LIC_URL = `${API}/v1/merchants/${MERCHANT}/license/2`;
const licensed = {
  "aifp-license": `id=${LIC.id}; rev=2; sha256=${LIC.sha256}; url="${LIC_URL}"`,
  link: { contains: `<${LIC_URL}/text>; rel="license"` },
};
add("license.delivered", "must", "content-enforce", "Content a receipt unlocked carries the licence that receipt bound", step(pay("l"), served({ "aifp-license": { contains: `sha256=${LIC.sha256}` }, link: { contains: 'rel="license"' } })), { receipts: { l: R({ lic: LIC }) } });
add("license.exact", "parity", "content-enforce", "The licence headers equal the reference", step(pay("l"), served(licensed)), { receipts: { l: R({ lic: LIC }) } });
add("license.absent", "must", "content-enforce", "A receipt without a licence adds no licence header", step(pay(), served({ "aifp-license": null })), { receipts: { r: R() } });
add("license.not_on_challenge", "must", "content-enforce", "A 402 carries no licence header", step(get("gptbot"), { ...noOrigin(402), headers: { "aifp-license": null } }));
add("license.not_on_forged", "must", "content-enforce", "A forged receipt with a licence is refused without it", step(pay("x"), { ...refused403(), headers: { "aifp-license": null } }), { receipts: { x: R({ lic: LIC }, { mutate: "tamper_payload" }) } });
add("license.not_on_exhausted", "must", "content-enforce", "A drained receipt is refused without its licence", [step(pay("one"), served({ "aifp-license": { contains: LIC.id } })), step(pay("one"), { status: [402, 403], origin: false, headers: { "aifp-license": null } })], { receipts: { one: R({ unit_quota: 1, lic: LIC }) } });
add("license.malformed_ignored", "must", "content-enforce", "A malformed licence claim is ignored, not echoed", step(pay("m"), served({ "aifp-license": null })), { receipts: { m: R({ lic: { ...LIC, id: "evil", url: "https://evil.example" } }) } });

// ── about the page ────────────────────────────────────────────────────────
const plain402 = { ...noOrigin(402), body: { golden: "challenge.standard", order: true } };
add("about.unset", "must", "content-enforce", "With no about option the 402 is byte for byte what it was", step(get("gptbot"), plain402));
add("about.present", "must", "about-enforce", "The 402 says what the page is", step(get("gptbot"), { ...noOrigin(402), body: { subset: { about: { title: "Fish and chips", description: "Where to eat them." } } } }), { needs: ["about"] });
add("about.exact", "parity", "about-enforce", "The 402 with about equals the reference, key order included", step(get("gptbot"), { ...noOrigin(402), body: { golden: "challenge.about", order: true } }), { needs: ["about"] });
add("about.markup", "must", "about-enforce", "Markup is stripped, entities decoded and whitespace collapsed", step(get("gptbot", "/paid/markup"), { ...noOrigin(402), body: { subset: { about: { title: "Menu today", description: "Daily specials Fish & chips \u2014 fresh" } } } }), { needs: ["about"] });
add("about.cut", "must", "about-enforce", "A long title is cut at 200 characters and a description at 300, with nothing added", step(get("gptbot", "/paid/long"), { ...noOrigin(402), body: { subset: { about: { title: "t".repeat(200), description: "d".repeat(300) } } } }), { needs: ["about"] });
add("about.absent", "must", "about-enforce", "A page the site says nothing about gets the plain 402", step(get("gptbot", "/paid/b"), plain402));
add("about.throws", "must", "about-enforce", "A function that throws leaves the 402 as it was", step(get("gptbot", "/paid/throws"), plain402));
add("about.shape", "must", "about-enforce", "A function that returns another shape leaves the 402 as it was", step(get("gptbot", "/paid/shape"), plain402));
add("about.receipt", "must", "about-enforce", "About changes nothing for a receipt: it opens the page and meters one unit", step(pay(), quota(2)), { receipts: { r: R() } });
add("about.reader", "must", "about-enforce", "A reader is still served free", step(get("chrome"), served({ "aifp-paywall": "exempt" })));

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

// Reader proof: computed here with plain HMAC, independent of any gate, so every port is held to the same bytes.
const readerOut = resolve(here, "../vectors/reader-proof-v1.json");
const READER = { cookie: "__aifp_human", ttl_seconds: 2592000, now: 1800000000 };
const keyA = "reader-key-0123456789abcdef0123456789";
const keyB = "reader-key-fedcba9876543210fedcba9876";
const chrome = fixtures.user_agents.chrome;
const sig = (key, exp, ua) => createHmac("sha256", Buffer.from(key, "utf8")).update(`${exp}\n${ua}`, "utf8").digest("base64url");
const value = (key, exp, ua) => `${exp}.${sig(key, exp, ua)}`;
const N = READER.now, LATER = N + 3600;
const issue = [
 { name: "issue.chrome", key: keyA, now: N, user_agent: chrome, cookie: value(keyA, N + READER.ttl_seconds, chrome) },
 { name: "issue.empty_ua", key: keyA, now: N, user_agent: "", cookie: value(keyA, N + READER.ttl_seconds, "") },
 { name: "issue.non_ascii_ua", key: keyB, now: N, user_agent: "Mozilla/5.0 (X11; Linux) Café/1.0", cookie: value(keyB, N + READER.ttl_seconds, "Mozilla/5.0 (X11; Linux) Café/1.0") },
];
const good = value(keyA, LATER, chrome);
const C = (v) => `${READER.cookie}=${v}`;
const verify = [
 { name: "verify.valid", cookie_header: C(good), valid: true },
 { name: "verify.among_others", cookie_header: `theme=dark; ${C(good)}; _ga=GA1.2.3`, valid: true },
 { name: "verify.no_space", cookie_header: `theme=dark;${C(good)}`, valid: true },
 { name: "verify.tab", cookie_header: `theme=dark;\t${C(good)}`, valid: true },
 { name: "verify.empty_ua", user_agent: "", cookie_header: C(value(keyA, LATER, "")), valid: true },
 { name: "verify.non_ascii_ua", user_agent: "Mozilla/5.0 (X11; Linux) Café/1.0", cookie_header: C(value(keyA, LATER, "Mozilla/5.0 (X11; Linux) Café/1.0")), valid: true },
 { name: "verify.no_header", cookie_header: "", valid: false },
 { name: "verify.no_cookie", cookie_header: "theme=dark", valid: false },
 { name: "verify.empty_value", cookie_header: C(""), valid: false },
 { name: "verify.expired", cookie_header: C(value(keyA, N - 1, chrome)), valid: false },
 { name: "verify.expires_now", cookie_header: C(value(keyA, N, chrome)), valid: false },
 { name: "verify.wrong_ua", user_agent: chrome.replace("131", "132"), cookie_header: C(good), valid: false },
 { name: "verify.ua_for_empty", user_agent: chrome, cookie_header: C(value(keyA, LATER, "")), valid: false },
 { name: "verify.wrong_key", cookie_header: C(value(keyB, LATER, chrome)), valid: false },
 { name: "verify.forged_sig", cookie_header: C(`${LATER}.${sig(keyA, LATER, chrome).replace(/^./, (c) => (c === "A" ? "B" : "A"))}`), valid: false },
 { name: "verify.exp_moved", cookie_header: C(`${LATER + 1}.${sig(keyA, LATER, chrome)}`), valid: false },
 { name: "verify.padded_sig", cookie_header: C(`${good}=`), valid: false },
 { name: "verify.exp_leading_zero", cookie_header: C(value(keyA, `0${LATER}`, chrome)), valid: false },
 { name: "verify.exp_plus", cookie_header: C(value(keyA, `+${LATER}`, chrome)), valid: false },
 { name: "verify.exp_fraction", cookie_header: C(value(keyA, `${LATER}.5`, chrome)), valid: false },
 { name: "verify.exp_exponent", cookie_header: C(value(keyA, "1e10", chrome)), valid: false },
 { name: "verify.exp_unsafe", cookie_header: C(value(keyA, "9007199254740993", chrome)), valid: false },
 { name: "verify.first_wins", cookie_header: `${C(value(keyA, N - 1, chrome))}; ${C(good)}`, valid: false },
 { name: "verify.name_prefix", cookie_header: `x${C(good)}`, valid: false },
 { name: "verify.name_suffix", cookie_header: `${READER.cookie}_x=${good}`, valid: false },
 { name: "verify.space_before_value", cookie_header: `${READER.cookie}= ${good}`, valid: false },
].map((v) => ({ key: keyA, user_agent: chrome, now: N, ...v }));
const readerVectors = { schema: 1, ...READER, set_cookie: `${READER.cookie}=<value>; Path=/; Max-Age=${READER.ttl_seconds}; HttpOnly; Secure; SameSite=Lax`, issue, verify };

// About the page: expected text written out here, not taken from a gate, so every port is held to the same bytes.
const aboutOut = resolve(here, "../vectors/about-v1.json");
const A = (name, value, about) => ({ name, value, about });
const aboutVectors = {
  schema: 1,
  title_max: 200,
  description_max: 300,
  vectors: [
    A("plain", { title: "How to brew coffee", description: "A short guide." }, { title: "How to brew coffee", description: "A short guide." }),
    A("title_only", { title: "T" }, { title: "T" }),
    A("description_only", { description: "D" }, { description: "D" }),
    A("null_field", { title: null, description: "D" }, { description: "D" }),
    A("extra_keys", { title: "T", price: "0" }, { title: "T" }),
    A("tags", { title: "<b>Bold</b> move", description: "<p>One</p> <p>two</p>" }, { title: "Bold move", description: "One two" }),
    A("tags_adjacent", { title: "<em>Ex</em>ample<br/>s" }, { title: "Examples" }),
    A("tag_attributes", { title: "<a href=\"/x\" title='y'>Link</a> text" }, { title: "Link text" }),
    A("tag_contents_kept", { title: "<script>alert(1)</script>Hi" }, { title: "alert(1)Hi" }),
    A("comment", { title: "a<!-- note -->b" }, { title: "ab" }),
    A("not_a_tag", { title: "1 < 2 and 3 > 2", description: "a <3 b" }, { title: "1 < 2 and 3 > 2", description: "a <3 b" }),
    A("unclosed_tag", { title: "x <b" }, { title: "x <b" }),
    A("entities", { title: "Fish &amp; chips &mdash; &#8220;fresh&#x201D; &copy;" }, { title: "Fish & chips \u2014 \u201Cfresh\u201D \u00A9" }),
    A("entities_once", { title: "&amp;lt;b&amp;gt;" }, { title: "&lt;b&gt;" }),
    A("entity_text_is_not_a_tag", { title: "&lt;b&gt;bold&lt;/b&gt;" }, { title: "<b>bold</b>" }),
    A("entity_unknown", { title: "&bogus; &amp &AMP;" }, { title: "&bogus; &amp &AMP;" }),
    A("entity_invalid_number", { title: "&#0; &#xD800; &#1114112;" }, { title: "&#0; &#xD800; &#1114112;" }),
    A("entity_astral", { title: "&#128512;&#x1F600;" }, { title: "\uD83D\uDE00\uD83D\uDE00" }),
    A("nbsp", { title: "a&nbsp;&nbsp;b" }, { title: "a b" }),
    A("whitespace", { title: "  a\t\n b\u00A0\u2003c\u3000 " }, { title: "a b c" }),
    A("control", { title: "a\u0000b\u0007c\u007Fd\u0085e\u009Bf" }, { title: "abcd ef" }),
    A("control_between_spaces", { title: "a \u0001 b" }, { title: "a b" }),
    A("control_entity", { title: "a&#7;b" }, { title: "ab" }),
    A("lone_surrogate", { title: "a\uD800b\uDC00c" }, { title: "abc" }),
    A("bom_kept", { title: "\uFEFFTitle" }, { title: "\uFEFFTitle" }),
    A("zero_width_kept", { title: "a\u200Bb" }, { title: "a\u200Bb" }),
    A("cut_title", { title: "x".repeat(250) }, { title: "x".repeat(200) }),
    A("cut_description", { description: "y".repeat(350) }, { description: "y".repeat(300) }),
    A("at_cap", { title: "x".repeat(200), description: "y".repeat(300) }, { title: "x".repeat(200), description: "y".repeat(300) }),
    A("cut_code_points", { title: "\uD83D\uDE00".repeat(201) }, { title: "\uD83D\uDE00".repeat(200) }),
    A("cut_no_trailing_space", { title: "a".repeat(199) + " bcd" }, { title: "a".repeat(199) }),
    A("cut_after_markup", { title: "<b>" + "z".repeat(200) + "</b>tail" }, { title: "z".repeat(200) }),
    A("cut_after_collapse", { title: "w   ".repeat(150) }, { title: "w ".repeat(99) + "w" }),
    A("empty", { title: "", description: "  " }, null),
    A("only_markup", { title: "<br>", description: "<p> </p>" }, null),
    A("empty_object", {}, null),
    A("null", null, null),
    A("string", "Fish and chips", null),
    A("array", [{ title: "T" }], null),
    A("number", 42, null),
    A("title_not_text", { title: 5, description: "D" }, null),
    A("description_not_text", { title: "T", description: ["D"] }, null),
  ],
};

// Receipt use: expected bodies written out here, not taken from a gate, so every port is held to the same bytes.
const useOut = resolve(here, "../vectors/receipt-use-v1.json");
const USE_BATCH = 100;
const rid = (n) => `rcpt_${n.toString(16).padStart(16, "0")}`;
const S = (receipt_id, remaining) => ({ receipt_id, remaining });
const useBodies = (spends) => {
  const lowest = new Map();
  for (const { receipt_id, remaining } of spends) {
    if (!/^rcpt_[0-9a-f]{16}$/.test(receipt_id) || !Number.isSafeInteger(remaining) || remaining < 0) continue;
    if (!lowest.has(receipt_id) || remaining < lowest.get(receipt_id)) lowest.set(receipt_id, remaining);
  }
  const uses = [...lowest.keys()].sort().map((id) => ({ receipt_id: id, remaining: lowest.get(id) }));
  const bodies = [];
  for (let i = 0; i < uses.length; i += USE_BATCH) bodies.push(JSON.stringify({ uses: uses.slice(i, i + USE_BATCH) }));
  return bodies;
};
const U = (name, spends) => ({ name, spends, bodies: useBodies(spends) });
const useVectors = {
  schema: 1,
  path: "/v1/merchants/{merchant_id}/receipt-use",
  auth_header: "AIFP-Merchant-Secret",
  max_batch: USE_BATCH,
  order: "receipt_id ascending",
  vectors: [
    U("valid_batch", [S("rcpt_0123456789abcdef", 34), S("rcpt_00000000000000a1", 0)]),
    U("coalesce_lowest", [S(rid(2), 34), S(rid(2), 30), S(rid(2), 32), S(rid(1), 5), S(rid(1), 5)]),
    U("split_over_100", Array.from({ length: 205 }, (_, i) => S(rid(205 - i), i % 7))),
    U("invalid_skipped", [
      S("eyJhbGciOiJFZERTQSJ9.eyJyZWNlaXB0X2lkIjoicmNwdF8xIn0.c2ln", 3),
      S("rcpt_0123456789ABCDEF", 3),
      S("rcpt_0123", 3),
      S(rid(9), -1),
      S(rid(9), 1.5),
      S(rid(9), "4"),
      S(rid(8), 7),
    ]),
    U("nothing_held", []),
  ],
};

const outputs = [
  [out, JSON.stringify(vectors, null, 1) + "\n", `${cases.length} cases`],
  [readerOut, JSON.stringify(readerVectors, null, 1) + "\n", `${issue.length + verify.length} reader-proof vectors`],
  [aboutOut, JSON.stringify(aboutVectors, null, 1) + "\n", `${aboutVectors.vectors.length} about vectors`],
  [useOut, JSON.stringify(useVectors, null, 1) + "\n", `${useVectors.vectors.length} receipt-use vectors`],
];
if (process.argv.includes("--check")) {
  for (const [file, text, what] of outputs) {
    if (readFileSync(file, "utf8") !== text) {
      console.error(`${file} is stale: run scripts/gen-vectors.mjs`);
      process.exit(1);
    }
    console.log(`vectors up to date: ${what}`);
  }
} else {
  for (const [file, text, what] of outputs) {
    writeFileSync(file, text);
    console.log(`wrote ${file}: ${what}`);
  }
}
