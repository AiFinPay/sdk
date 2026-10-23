// ──────────────────────────────────────────────────────────────────────────
// Per-operator access policy — allow / charge / block, decided by the merchant.
//
// Three things must hold. A gate without a policy, or with a policy that has
// no rules, answers exactly what it answered before the option existed —
// response and event stream alike. In enforce, allow serves free, charge is
// the existing 402 path and block is a 403 with the AIFP-403 body, each with
// its event; in shadow the events are identical and every request is served.
// And a verified_only rule applies only once this request's receipt verified:
// a User-Agent, an AIFP-Agent-Id, a forged receipt are claims and fall
// through to the next rule.
// ──────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import {
  AifpMerchant,
  HEADER_MODE,
  HEADER_QUOTA_REMAINING,
  HEADER_SHADOW_STATUS,
  MemoryStore,
  OPERATOR_ACTIONS,
  ResourceRegistry,
  createGate,
  decideOperator,
  knownAiAgent,
  normalizeOperatorPolicy,
} from "../src/index.js";
import type { GateEvent, GateOptions, GateResult, OperatorPolicy } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req } from "./helpers.js";

const GPTBOT_UA = "Mozilla/5.0 AppleWebKit/537.36 (compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const CLAUDEBOT_UA = "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)";
const CHATGPT_USER_UA =
  "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko); compatible; ChatGPT-User/1.0; +https://openai.com/bot";
const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Safari/605.1.15";

const policy = (
  operator_rules: OperatorPolicy["operator_rules"],
  operator_default: OperatorPolicy["operator_default"] = "charge"
) => ({
  operator_rules,
  operator_default,
});

async function gateWith(overrides: Partial<GateOptions> = {}) {
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

/** The response and events a request gets, in a shape that compares whole. */
async function run(
  gate: (r: ReturnType<typeof req>) => Promise<GateResult>,
  events: GateEvent[],
  headers: Record<string, string>
) {
  events.length = 0;
  const result = await gate(req("/api/search", headers));
  return { result, events: [...events] };
}

describe("a gate without rules is the gate it always was", () => {
  const cases: Array<[string, Partial<GateOptions>]> = [
    ["no option", {}],
    ["explicit null", { operatorPolicy: null }],
    ["a policy with no rules", { operatorPolicy: policy([]) }],
    ["a function returning no rules", { operatorPolicy: () => policy([]) }],
    ["a registry that never loaded a policy", { operatorPolicy: () => undefined }],
  ];
  for (const shouldCharge of [undefined, knownAiAgent]) {
    for (const mode of ["enforce", "shadow"] as const) {
      it(`${mode}${shouldCharge ? " with knownAiAgent" : ""}: identical responses and events`, async () => {
        const baseline = await gateWith({ mode, shouldCharge });
        const token = await baseline.iss.sign({ unit_quota: 5 });
        const forged = await baseline.iss.sign({ aud: "mrch_other" });
        const requests = [
          { "User-Agent": GPTBOT_UA },
          { "User-Agent": BROWSER_UA },
          { "User-Agent": CHATGPT_USER_UA, "AIFP-Agent-Id": "agt_claimed" },
          {},
          { "AIFP-Receipt": token },
          { "AIFP-Receipt": forged },
        ];
        const expected = [];
        for (const headers of requests) expected.push(await run(baseline.gate, baseline.events, headers));
        for (const [label, overrides] of cases) {
          const candidate = await gateWith({ mode, shouldCharge, ...overrides });
          for (const [i, headers] of requests.entries()) {
            const got = await run(candidate.gate, candidate.events, headers);
            expect(got, `${label}, request ${i}`).toEqual(expected[i]);
          }
        }
      });
    }
  }
});

describe("enforce: allow, charge, block", () => {
  const rules = policy(
    [
      { operator: "openai", action: "allow" },
      { operator: "anthropic", action: "block" },
      { ua_class: "unknown", action: "block" },
    ],
    "charge"
  );

  it("allow serves free, unmetered, with an exempt serve event naming the rule", async () => {
    const { gate, events } = await gateWith({ operatorPolicy: rules, shouldCharge: knownAiAgent });
    const { result } = await run(gate, events, { "User-Agent": GPTBOT_UA });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.status).toBe(200);
    expect(result.headers).toEqual({ "AIFP-Paywall": "exempt" });
    expect(result.aifp).toMatchObject({ mode: "exempt", weight: 0, receipt_id: "", agent: null });
    expect(events).toEqual([
      {
        kind: "serve",
        resource: "/api/search",
        weight: 1,
        agent: null,
        exempt: true,
        detail: "operator policy: allow (operator=openai)",
        operator: "openai",
        ua_class: "ai_crawler",
        verified: false,
      },
    ]);
  });

  it("charge is the existing 402 path, event unchanged", async () => {
    const { gate, events } = await gateWith({ operatorPolicy: rules, shouldCharge: knownAiAgent });
    const { result } = await run(gate, events, { "User-Agent": "Mozilla/5.0 (compatible; PerplexityBot/1.0)" });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(402);
    expect(result.body.error).toBe("AIFP-402");
    expect(events).toEqual([
      {
        kind: "402",
        resource: "/api/search",
        weight: 1,
        detail: undefined,
        operator: "perplexity",
        ua_class: "ai_crawler",
        verified: false,
      },
    ]);
  });

  it("block answers 403 with the AIFP-403 body and a 403 event naming the rule", async () => {
    const { gate, events } = await gateWith({ operatorPolicy: rules, shouldCharge: knownAiAgent });
    const { result } = await run(gate, events, { "User-Agent": CLAUDEBOT_UA });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.status).toBe(403);
    expect(result.headers).toEqual({ "Content-Type": "application/json" });
    expect(result.body).toEqual({ error: "AIFP-403", detail: "blocked by merchant policy (operator rule)" });
    expect(events).toEqual([
      {
        kind: "403",
        resource: "/api/search",
        weight: 1,
        detail: "operator policy: block (operator=anthropic)",
        operator: "anthropic",
        ua_class: "ai_crawler",
        verified: false,
      },
    ]);
    // A class rule, for a headless browser.
    const headless = await run(gate, events, { "User-Agent": "Mozilla/5.0 HeadlessChrome/126.0" });
    expect(headless.result.status).toBe(403);
    expect(headless.events[0].detail).toBe("operator policy: block (ua_class=unknown)");
  });

  it("the operator layer sits before shouldCharge: a rule decides, the predicate decides the rest", async () => {
    // Without a predicate everyone pays; an allow rule still serves its operator free.
    const { gate, events } = await gateWith({ operatorPolicy: rules });
    expect((await run(gate, events, { "User-Agent": GPTBOT_UA })).result.status).toBe(200);
    expect((await run(gate, events, { "User-Agent": BROWSER_UA })).result.status).toBe(402);
    // A default of block never reaches a reader: shouldCharge still exempts them.
    const blockAll = await gateWith({ operatorPolicy: policy([], "block"), shouldCharge: knownAiAgent });
    expect((await run(blockAll.gate, blockAll.events, { "User-Agent": BROWSER_UA })).result.status).toBe(200);
    expect((await run(blockAll.gate, blockAll.events, { "User-Agent": GPTBOT_UA })).result.status).toBe(403);
    expect((await run(blockAll.gate, blockAll.events, {})).result.status).toBe(403);
  });

  it("an allow rule still yields to the merchant's own allow veto", async () => {
    const { gate, events } = await gateWith({ operatorPolicy: rules, allow: () => false });
    const { result } = await run(gate, events, { "User-Agent": GPTBOT_UA });
    expect(result.status).toBe(403);
    if (!result.ok) expect(result.body.detail).toBe("blocked by merchant policy");
  });

  it("the policy is read per request, so a saved change applies without a restart", async () => {
    let current: OperatorPolicy | null = null;
    const { gate, events } = await gateWith({ operatorPolicy: () => current, shouldCharge: knownAiAgent });
    expect((await run(gate, events, { "User-Agent": CLAUDEBOT_UA })).result.status).toBe(402);
    current = policy([{ operator: "anthropic", action: "block" }]);
    expect((await run(gate, events, { "User-Agent": CLAUDEBOT_UA })).result.status).toBe(403);
    current = policy([{ operator: "anthropic", action: "allow" }]);
    expect((await run(gate, events, { "User-Agent": CLAUDEBOT_UA })).result.status).toBe(200);
  });
});

describe("shadow: the same events, every request served", () => {
  it("records allow, charge and block as enforce would and serves all three", async () => {
    const rules = policy([
      { operator: "openai", action: "allow" },
      { operator: "anthropic", action: "block" },
    ]);
    const enforce = await gateWith({ operatorPolicy: rules, shouldCharge: knownAiAgent });
    const shadow = await gateWith({ operatorPolicy: rules, shouldCharge: knownAiAgent, mode: "shadow" });
    for (const headers of [
      { "User-Agent": GPTBOT_UA },
      { "User-Agent": CLAUDEBOT_UA },
      { "User-Agent": "Mozilla/5.0 (compatible; PerplexityBot/1.0)" },
      { "User-Agent": BROWSER_UA },
    ]) {
      const e = await run(enforce.gate, enforce.events, headers);
      const s = await run(shadow.gate, shadow.events, headers);
      expect(s.events, headers["User-Agent"]).toEqual(e.events);
      expect(s.result.ok).toBe(true);
      expect(s.result.status).toBe(200);
      expect(s.result.headers[HEADER_MODE]).toBe("shadow");
    }
    const blocked = await run(shadow.gate, shadow.events, { "User-Agent": CLAUDEBOT_UA });
    expect(blocked.result.headers[HEADER_SHADOW_STATUS]).toBe("403");
    if (blocked.result.ok) {
      expect(blocked.result.aifp.mode).toBe("shadow");
      expect(blocked.result.aifp.shadow).toEqual({
        status: 403,
        error: "AIFP-403",
        detail: "blocked by merchant policy (operator rule)",
        weight: 1,
      });
    }
    expect(blocked.events[0].detail).toBe("operator policy: block (operator=anthropic)");
    const allowed = await run(shadow.gate, shadow.events, { "User-Agent": GPTBOT_UA });
    expect(allowed.result.headers).toEqual({ "AIFP-Paywall": "exempt", [HEADER_MODE]: "shadow" });
    if (allowed.result.ok) expect(allowed.result.aifp.mode).toBe("exempt");
  });
});

describe("verified_only: a claim falls through, a verified receipt does not", () => {
  const rules = policy([
    { operator: "aifinpay", action: "allow", verified_only: true },
    { ua_class: "aifp_agent", action: "block" },
  ]);

  it("a verified receipt is allowed — served free, the receipt not spent; a claim is blocked", async () => {
    const { gate, iss, events } = await gateWith({ operatorPolicy: rules });
    const token = await iss.sign({ unit_quota: 1, receipt_id: "rcpt_000000000000000a", sub: "agt_payer" });
    for (let i = 0; i < 3; i++) {
      const { result, events: seen } = await run(gate, events, { "AIFP-Receipt": token });
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.status).toBe(200);
      expect(result.headers).toEqual({ "AIFP-Paywall": "exempt" });
      expect(result.aifp).toMatchObject({ mode: "exempt", agent: "agt_payer", weight: 0 });
      expect(seen).toEqual([
        {
          kind: "serve",
          resource: "/api/search",
          weight: 1,
          agent: "agt_payer",
          exempt: true,
          detail: "operator policy: allow (operator=aifinpay)",
          operator: "aifinpay",
          ua_class: "aifp_agent",
          verified: true,
        },
      ]);
    }
    // AIFP-Agent-Id alone is a claim: the verified_only allow is skipped and
    // the class rule blocks.
    const claimed = await run(gate, events, { "AIFP-Agent-Id": "agt_payer" });
    expect(claimed.result.status).toBe(403);
    expect(claimed.events).toEqual([
      {
        kind: "403",
        resource: "/api/search",
        weight: 1,
        detail: "operator policy: block (ua_class=aifp_agent)",
        operator: "aifinpay",
        ua_class: "aifp_agent",
        verified: false,
      },
    ]);
    // A receipt for another merchant does not verify here: still a claim.
    const forged = await run(gate, events, { "AIFP-Receipt": await iss.sign({ aud: "mrch_other" }) });
    expect(forged.result.status).toBe(403);
    if (!forged.result.ok) expect(forged.result.body.detail).toBe("blocked by merchant policy (operator rule)");
    expect(forged.events[0]).toMatchObject({
      kind: "403",
      verified: false,
      detail: "operator policy: block (ua_class=aifp_agent)",
    });
  });

  it("with nothing underneath, a claim lands on the default and a verified receipt pays as usual", async () => {
    const { gate, iss, events } = await gateWith({
      operatorPolicy: policy([{ operator: "aifinpay", action: "block", verified_only: true }], "charge"),
    });
    // Claimed: the verified_only block is skipped → charge → 402.
    expect((await run(gate, events, { "AIFP-Agent-Id": "agt_x" })).result.status).toBe(402);
    // Verified: the block applies after verification, nothing metered.
    const token = await iss.sign({ unit_quota: 5 });
    const blocked = await run(gate, events, { "AIFP-Receipt": token });
    expect(blocked.result.status).toBe(403);
    expect(blocked.events[0]).toMatchObject({
      kind: "403",
      verified: true,
      detail: "operator policy: block (operator=aifinpay)",
    });
    // The batch is untouched: a gate without the rule meters from 5.
    const plain = await gateWith({ jwks: (await issuer()).jwks });
    const paid = await plain.gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(paid.headers[HEADER_QUOTA_REMAINING]).toBe("4");
  });

  it("a rule with verified_only false applies to the claim and the receipt alike", async () => {
    const { gate, iss, events } = await gateWith({
      operatorPolicy: policy([{ operator: "aifinpay", action: "block" }]),
    });
    expect((await run(gate, events, { "AIFP-Agent-Id": "agt_x" })).result.status).toBe(403);
    expect((await run(gate, events, { "AIFP-Receipt": await iss.sign({}) })).result.status).toBe(403);
    expect(events[0].verified).toBe(false);
  });
});

describe("precedence and the pure decision", () => {
  it("operator rule → ua_class rule → default; readers never match", () => {
    const pol = policy(
      [
        { ua_class: "ai_crawler", action: "block" },
        { operator: "openai", action: "charge" },
      ],
      "allow"
    );
    const d = (who: Parameters<typeof decideOperator>[1]) => {
      const r = decideOperator(pol, who);
      return `${r.action}/${r.matched}`;
    };
    expect(d({ operator: "openai", ua_class: "ai_crawler", verified: false })).toBe("charge/operator");
    expect(d({ operator: "bytedance", ua_class: "ai_crawler", verified: false })).toBe("block/ua_class");
    expect(d({ operator: "anthropic", ua_class: "ai_agent_browser", verified: false })).toBe("allow/default");
    expect(d({ operator: "unknown", ua_class: "human", verified: false })).toBe("charge/none");
    expect(decideOperator(null, { operator: "openai", ua_class: "ai_crawler", verified: false })).toMatchObject({
      action: "charge",
      matched: "none",
    });
    expect(decideOperator(pol, { operator: "anthropic", ua_class: "ai_agent_browser", verified: false }).detail).toBe(
      "operator policy: allow (default)"
    );
  });

  it("normalises what the control plane sent: unknown values are dropped, never guessed", () => {
    expect(normalizeOperatorPolicy(null)).toBeNull();
    expect(normalizeOperatorPolicy({ merchant_id: "mrch_old" })).toBeNull();
    expect(normalizeOperatorPolicy({ operator_rules: [] })).toEqual({ operator_rules: [], operator_default: "charge" });
    expect(
      normalizeOperatorPolicy({
        operator_rules: [
          { operator: "openai", action: "block", note: "must not travel" },
          { operator: "openai", action: "allow" },
          { operator: "newcomer", action: "allow" },
          { ua_class: "human", action: "block" },
          { ua_class: "ai_crawler", action: "charge", verified_only: "yes" },
          { operator: "anthropic", ua_class: "ai_crawler", action: "allow" },
          { operator: "aifinpay", action: "ration" },
          { operator: "aifinpay", action: "allow", verified_only: true },
          "openai",
        ],
        operator_default: "maybe",
      })
    ).toEqual({
      operator_rules: [
        { operator: "openai", action: "block", verified_only: false },
        { ua_class: "ai_crawler", action: "charge", verified_only: false },
        { operator: "aifinpay", action: "allow", verified_only: true },
      ],
      operator_default: "charge",
    });
    expect([...OPERATOR_ACTIONS]).toEqual(["allow", "charge", "block"]);
  });
});

describe("the registry carries the policy from the public merchant view", () => {
  function merchantWith(view: () => { status: number; body: unknown }) {
    const fetchImpl = (async (url: string | URL) => {
      const u = String(url);
      const answer = u.endsWith("/resources") ? { status: 200, body: { resources: [] } } : view();
      return new Response(JSON.stringify(answer.body), {
        status: answer.status,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof globalThis.fetch;
    return new AifpMerchant({ merchantId: MERCHANT, secret: "sk_test_secret", fetch: fetchImpl, retries: 0 });
  }

  it("reads the rules on refresh and the gate applies them; a failed refresh keeps the last good copy", async () => {
    let view: { status: number; body: unknown } = {
      status: 200,
      body: {
        merchant_id: MERCHANT,
        operator_rules: [{ operator: "anthropic", action: "block" }],
        operator_default: "charge",
      },
    };
    const errors: unknown[] = [];
    const registry = new ResourceRegistry({ merchant: merchantWith(() => view), onError: (e) => errors.push(e) });
    const { gate, events } = await gateWith({ registry, resource: undefined, registryUnavailable: "mount-default" });
    // Never loaded: today's behaviour.
    expect(registry.operatorPolicy()).toBeNull();
    expect((await run(gate, events, { "User-Agent": CLAUDEBOT_UA })).result.status).toBe(402);
    await registry.refresh();
    expect(registry.operatorPolicy()).toEqual({
      operator_rules: [{ operator: "anthropic", action: "block", verified_only: false }],
      operator_default: "charge",
    });
    expect(registry.snapshot().operator_policy).toEqual(registry.operatorPolicy());
    expect((await run(gate, events, { "User-Agent": CLAUDEBOT_UA })).result.status).toBe(403);
    // The control plane is unreachable: the last good policy stays in force.
    view = { status: 503, body: { error: "AIFP-503" } };
    await registry.refresh();
    expect(errors).toHaveLength(1);
    expect((await run(gate, events, { "User-Agent": CLAUDEBOT_UA })).result.status).toBe(403);
    // The owner removed the rule.
    view = { status: 200, body: { merchant_id: MERCHANT, operator_rules: [], operator_default: "charge" } };
    await registry.refresh();
    expect((await run(gate, events, { "User-Agent": CLAUDEBOT_UA })).result.status).toBe(402);
    // An explicit option wins over the registry.
    const pinned = await gateWith({
      registry,
      resource: undefined,
      registryUnavailable: "mount-default",
      operatorPolicy: policy([{ operator: "anthropic", action: "allow" }]),
    });
    expect((await run(pinned.gate, pinned.events, { "User-Agent": CLAUDEBOT_UA })).result.status).toBe(200);
  });

  it("an older control plane without the section leaves the gate as it was", async () => {
    const registry = new ResourceRegistry({
      merchant: merchantWith(() => ({ status: 200, body: { merchant_id: MERCHANT } })),
    });
    await registry.refresh();
    expect(registry.operatorPolicy()).toBeNull();
    const { gate, events } = await gateWith({ registry, resource: undefined, registryUnavailable: "mount-default" });
    expect((await run(gate, events, { "User-Agent": CLAUDEBOT_UA })).result.status).toBe(402);
  });
});
