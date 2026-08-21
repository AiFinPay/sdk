// ──────────────────────────────────────────────────────────────────────────
// The content-site switch: humans read free, recognised agents pay.
//
// A route mounted for an API charges everyone — correct there, wrong twice
// over on a page with human readers: a browser cannot present a receipt and
// must never meet a 402. `shouldCharge` decides WHO pays; `knownAiAgent` is
// the shipped answer for "the crawlers Cloudflare already recognises — the
// population with content budgets".
//
// The case that would break silently is not the human and not the crawler:
// it is a PAYING agent with a browser-looking User-Agent. Exempt it and its
// receipt stops being metered — every call after the first is free.
// ──────────────────────────────────────────────────────────────────────────
import { describe, expect, it } from "vitest";
import { createGate, knownAiAgent, MemoryStore } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req } from "./helpers.js";

const BROWSER_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function contentGate(overrides: Record<string, unknown> = {}) {
  const iss = await issuer();
  const gate = createGate({
    merchantId: MERCHANT,
    resource: "/articles",
    tier: "standard",
    issuer: ISSUER,
    jwks: iss.jwks,
    store: new MemoryStore(),
    shouldCharge: knownAiAgent,
    ...overrides,
  });
  return { gate, iss };
}

describe("shouldCharge — who pays on a content site", () => {
  it("a human browser reads free and never sees a 402", async () => {
    const { gate } = await contentGate();
    const r = await gate(req("/articles", { "User-Agent": BROWSER_UA }));

    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.aifp.mode).toBe("exempt");
    expect(r.aifp.weight).toBe(0, "an exempt read must not consume anything");
    expect(r.headers["AIFP-Paywall"]).toBe("exempt");
  });

  it("a self-identifying crawler without a receipt gets the 402", async () => {
    const { gate } = await contentGate();
    for (const ua of [
      "Mozilla/5.0 AppleWebKit/537.36; compatible; GPTBot/1.2; +https://openai.com/gptbot",
      "Mozilla/5.0 (compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
      "Mozilla/5.0 (compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
      "CCBot/2.0 (https://commoncrawl.org/faq/)",
    ]) {
      const r = await gate(req("/articles", { "User-Agent": ua }));
      expect(r.ok, `${ua} must be charged`).toBe(false);
      if (r.ok) continue;
      expect(r.status).toBe(402);
      expect(r.body.how_to_pay?.length).toBeGreaterThan(0);
    }
  });

  it("un-disguised browser automation (Playwright/Puppeteer headless) is charged", async () => {
    // Partner question on the 2026-08-21 onboarding call: "what if an agent
    // just opens Playwright and visits?" Headless Chromium announces itself —
    // this is the real default UA shape — so it is an agent by declaration.
    // A driver that SPOOFS a human UA is out of scope by design (see the
    // marker-list comment); this test pins only the honest default.
    const { gate } = await contentGate();
    for (const ua of [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/126.0.0.0 Safari/537.36",
      "Mozilla/5.0 (Unknown; Linux x86_64) AppleWebKit/534.34 (KHTML, like Gecko) PhantomJS/2.1.1 Safari/534.34",
    ]) {
      const r = await gate(req("/articles", { "User-Agent": ua }));
      expect(r.ok, `${ua} must be charged`).toBe(false);
      if (r.ok) continue;
      expect(r.status).toBe(402);
    }
    // The headed twin of the same browser is a human and stays free — the
    // marker must match "headlesschrome", never plain Chrome.
    const headed = await gate(req("/articles", {
      "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
    }));
    expect(headed.ok).toBe(true);
  });

  it("a crawler WITH a receipt is served and metered", async () => {
    const { gate, iss } = await contentGate();
    const token = await iss.sign({ resource: "/articles", unit_quota: 3 });
    const call = () =>
      gate(req("/articles", {
        "User-Agent": "GPTBot/1.2",
        "AIFP-Receipt": token,
      }));

    const first = await call();
    expect(first.ok).toBe(true);
    if (first.ok) expect(first.aifp.remaining).toBe(2);

    await call();
    await call();
    const exhausted = await call();
    expect(exhausted.ok).toBe(false);
    if (!exhausted.ok) expect(exhausted.status).toBe(402);
  });

  it("THE silent breaker: a paying agent with a browser UA is still metered", async () => {
    // knownAiAgent treats AIFP-Receipt/AIFP-Agent-Id as the declaration, so a
    // browser-looking User-Agent cannot exempt a receipt out of metering. If
    // this test fails, every such agent's calls after the first are free.
    const { gate, iss } = await contentGate();
    const token = await iss.sign({ resource: "/articles", unit_quota: 2 });
    const call = () =>
      gate(req("/articles", { "User-Agent": BROWSER_UA, "AIFP-Receipt": token }));

    const a = await call();
    expect(a.ok).toBe(true);
    if (a.ok) {
      expect(a.aifp.mode).toBe("paid");
      expect(a.aifp.used).toBe(1);
    }
    await call();
    const c = await call();
    expect(c.ok, "quota must exhaust — exemption would make this free").toBe(false);
  });

  it("an empty User-Agent is charged — no browser sends none", async () => {
    const { gate } = await contentGate();
    const r = await gate(req("/articles", {}));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(402);
  });

  it("a throwing predicate charges rather than serving free", async () => {
    // Of the two wrong answers a broken detector can give, a 402 to one human
    // is visible and gets reported; a crawler served free is silent forever.
    const { gate } = await contentGate({
      shouldCharge: () => {
        throw new Error("detector down");
      },
    });
    const r = await gate(req("/articles", { "User-Agent": BROWSER_UA }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(402);
  });

  it("without shouldCharge nothing changes — an API still charges everyone", async () => {
    const { gate } = await contentGate({ shouldCharge: undefined });
    const r = await gate(req("/articles", { "User-Agent": BROWSER_UA }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(402);
  });

  it("exempt serves surface in events as serve+exempt, never as revenue", async () => {
    const events: Array<{ kind: string; exempt?: boolean }> = [];
    const { gate } = await contentGate({ onEvent: (e: never) => events.push(e) });

    await gate(req("/articles", { "User-Agent": BROWSER_UA }));
    const serve = events.find((e) => e.kind === "serve");
    expect(serve?.exempt).toBe(true);
  });

  it("merchant allow-veto still applies to exempt traffic", async () => {
    // Exempt is "free", not "ungoverned": a maintenance-window veto must hold
    // for readers too, or the two options fight about who has the last word.
    const { gate } = await contentGate({ allow: () => false });
    const r = await gate(req("/articles", { "User-Agent": BROWSER_UA }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});
