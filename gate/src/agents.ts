/*
 * Who is an AI agent? — the content-site question, answered honestly.
 *
 * On an API, nobody asks: everything unpaid gets a 402, and that is correct.
 * On a page with human readers it is the WHOLE question, because a browser
 * cannot present a receipt and must never see a 402. So the gate takes a
 * `shouldCharge` predicate, and this file ships the default implementation.
 *
 * WHAT IT IS: a curated list of the crawlers that identify themselves — the
 * same population Cloudflare classifies and blocks today, which is exactly
 * the population with content budgets (OpenAI, Anthropic, Perplexity…). Plus
 * one signal stronger than any list: a request already speaking the AIFP
 * protocol (an AIFP-Receipt or AIFP-Agent-Id header) is an agent by its own
 * declaration, whatever its User-Agent says.
 *
 * WHAT IT IS NOT: stealth detection. A scraper on a residential proxy with a
 * browser User-Agent walks past this — past Cloudflare's classifier too.
 * That is the industry's boundary, not this package's; selling anything
 * beyond it would be selling fiction. The list below monetizes the polite
 * crawlers, and it is the merchant's to extend:
 *
 *   shouldCharge: (req) => knownAiAgent(req) || myOwnSignal(req)
 *
 * A merchant behind Cloudflare can do better than any static list: a
 * Transform Rule that stamps `x-ai-crawler: 1` when `cf.verified_bot_category
 * eq "AI Crawler"` moves the decision to an edge that verifies bots
 * cryptographically, and the predicate becomes one header check.
 */
import type { GateRequest } from "./types.js";

/**
 * Who runs the client, as a closed set. Shared verbatim with the AiFinPay
 * gate-events ingest (which refuses any other value) and the site-check probe,
 * so adding an id is a contract change in all three — not a local edit.
 * Operators without an id here are "unknown", never a free-text name: the
 * value becomes a counter key, and a free-text field is an unbounded one.
 */
export const GATE_OPERATORS = [
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
] as const;
export type GateOperator = (typeof GATE_OPERATORS)[number];

/**
 * What kind of client, by its own signals:
 * - `ai_crawler` — bulk fetcher for training or a search index (GPTBot, ClaudeBot).
 * - `ai_agent_browser` — fetches because a person asked an assistant (ChatGPT-User).
 * - `aifp_agent` — speaks AIFP: sent AIFP-Receipt / AIFP-Agent-Id, or is one of our clients.
 * - `human` — a User-Agent with no automation marker. A stealth bot lands here too;
 *   the name says what the request claims, not what was proven.
 * - `unknown` — automation of unknown purpose: no User-Agent at all, headless browsers.
 */
export const UA_CLASSES = ["ai_crawler", "ai_agent_browser", "aifp_agent", "human", "unknown"] as const;
export type UaClass = (typeof UA_CLASSES)[number];

/** What a gate event says about who asked. Normalised values only — the raw
 *  User-Agent, IP and headers never leave the request. */
export interface AgentIdentity {
  operator: GateOperator;
  ua_class: UaClass;
  /** True only once an AIFP receipt on this request verified (signature,
   *  issuer, audience). A User-Agent or an AIFP-Agent-Id header is a claim:
   *  scanners send "ChatGPT-User" and "Claude-SearchBot" to look trusted. */
  verified: boolean;
}

export interface AiAgentUaEntry {
  /** Lowercase User-Agent substring. */
  marker: string;
  operator: GateOperator;
  ua_class: UaClass;
}

/**
 * Self-identifying AI crawler / agent User-Agent substrings, lowercase, with
 * who runs each and what it is. The one source of truth for both questions —
 * "charge it?" (knownAiAgent) and "whose is it?" (classifyAgent) — so the two
 * cannot disagree about a marker.
 *
 * Curated, not exhaustive — new crawlers appear monthly, and each entry is a
 * revenue opportunity, not a threat signature. Sources: the population
 * Cloudflare's verified-bot list classifies as AI, plus the operators that
 * publish their UA strings. First match wins.
 */
export const AI_AGENT_UA_TABLE: readonly AiAgentUaEntry[] = [
  // OpenAI
  { marker: "gptbot", operator: "openai", ua_class: "ai_crawler" },
  { marker: "oai-searchbot", operator: "openai", ua_class: "ai_crawler" },
  { marker: "chatgpt-user", operator: "openai", ua_class: "ai_agent_browser" },
  // Anthropic. Claude-SearchBot and Claude-User are the current published
  // names; claude-web and anthropic-ai are the retired ones, kept for the
  // fetchers that still send them.
  { marker: "claudebot", operator: "anthropic", ua_class: "ai_crawler" },
  { marker: "claude-searchbot", operator: "anthropic", ua_class: "ai_crawler" },
  { marker: "claude-user", operator: "anthropic", ua_class: "ai_agent_browser" },
  { marker: "claude-web", operator: "anthropic", ua_class: "ai_agent_browser" },
  { marker: "anthropic-ai", operator: "anthropic", ua_class: "ai_crawler" },
  // Perplexity
  { marker: "perplexitybot", operator: "perplexity", ua_class: "ai_crawler" },
  { marker: "perplexity-user", operator: "perplexity", ua_class: "ai_agent_browser" },
  // Common Crawl (feeds many trainers)
  { marker: "ccbot", operator: "commoncrawl", ua_class: "ai_crawler" },
  // ByteDance
  { marker: "bytespider", operator: "bytedance", ua_class: "ai_crawler" },
  // Google's opt-out-able training fetcher (distinct from Googlebot search)
  { marker: "google-extended", operator: "google", ua_class: "ai_crawler" },
  // Apple
  { marker: "applebot-extended", operator: "apple", ua_class: "ai_crawler" },
  // Meta
  { marker: "meta-externalagent", operator: "meta", ua_class: "ai_crawler" },
  { marker: "facebookbot", operator: "meta", ua_class: "ai_crawler" },
  // Amazon
  { marker: "amazonbot", operator: "amazon", ua_class: "ai_crawler" },
  // Others with published AI/LLM fetchers. Their operators have no id in
  // GATE_OPERATORS, so they report as "unknown" rather than a free-text name.
  { marker: "youbot", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "diffbot", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "timpibot", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "omgilibot", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "cohere-ai", operator: "unknown", ua_class: "ai_agent_browser" },
  { marker: "ai2bot", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "mistralai", operator: "unknown", ua_class: "ai_agent_browser" },

  // Our own clients. An agent built on @aifinpay/agent or aifinpay-agent (py)
  // is an AI agent by construction, and until 2026-09-02 this list did not say
  // so: aifinpay-agent-node/0.3.0 and aifinpay-agent-py/1.0.0 were served 200
  // by a page gate using knownAiAgent, so they never saw the 402 and never
  // paid. Verified live against a partner's gate before and after.
  //
  // The AIFP-Agent-Id check below already covers the AIFP-1 client, which sets
  // that header on every request including the first. It does NOT cover
  // node/src/agent.ts, and the Python client sets it nowhere — so the outcome
  // depended on which of our own clients an integrator picked. Naming the UA
  // makes it depend on nothing.
  { marker: "aifinpay-agent", operator: "aifinpay", ua_class: "aifp_agent" },
  // Automation frameworks in their DEFAULT configuration. Headless
  // Chromium/Chrome announces itself as "HeadlessChrome/126…" unless the
  // driver overrides the UA — so an un-disguised Playwright/Puppeteer visit
  // is a self-identifying machine, same as the crawlers above. One that
  // spoofs a human UA has left "by declaration" territory; that class is an
  // anti-bot product's job, not this list's. A machine, but not necessarily
  // an AI one: ua_class "unknown".
  // NOT "electron": Electron UAs are real humans inside app webviews
  // (Slack, Notion), and exempting humans is this predicate's entire promise.
  { marker: "headlesschrome", operator: "unknown", ua_class: "unknown" },
  { marker: "phantomjs", operator: "unknown", ua_class: "unknown" },
];

/** The markers alone, in table order. Derived, so it cannot drift from the table. */
export const AI_AGENT_UA_MARKERS: readonly string[] = AI_AGENT_UA_TABLE.map((entry) => entry.marker);

/**
 * Who a request says it is, normalised to the enums above. Never returns
 * `verified: true` — every input here is a header the client wrote. The gate
 * upgrades an event to verified only after the request's receipt verifies.
 */
export function classifyAgent(req: GateRequest): AgentIdentity {
  // Speaking the protocol IS the declaration, whatever the User-Agent says.
  if (req.header("AIFP-Receipt") || req.header("AIFP-Agent-Id")) {
    return { operator: "aifinpay", ua_class: "aifp_agent", verified: false };
  }
  const ua = (req.header("user-agent") ?? "").toLowerCase();
  // No User-Agent at all: no browser does that; scripts do.
  if (!ua) return { operator: "unknown", ua_class: "unknown", verified: false };
  for (const entry of AI_AGENT_UA_TABLE) {
    if (ua.includes(entry.marker)) return { operator: entry.operator, ua_class: entry.ua_class, verified: false };
  }
  return { operator: "unknown", ua_class: "human", verified: false };
}

/**
 * The default `shouldCharge` for content sites: true for requests that are an
 * AI agent by their own signals.
 *
 * Deliberately SYNC and non-throwing — the predicate runs on every request of
 * a human-facing site, and a predicate that can reject would force the gate
 * to choose between 402-ing a reader (site broken for humans) and serving a
 * crawler free (silent revenue leak). A pure string check has neither failure
 * mode.
 */
export function knownAiAgent(req: GateRequest): boolean {
  // A paying agent must never be exempted by a human-looking User-Agent, or
  // its receipt spend would stop metering — classifyAgent puts AIFP-Receipt /
  // AIFP-Agent-Id first for exactly that reason. Everything that is not a
  // plain "human" is charged, including no User-Agent at all.
  return classifyAgent(req).ua_class !== "human";
}
