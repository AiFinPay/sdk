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

/** Operators, classes and rows come from data/agents-v1.json; ids are a closed set the gate-events ingest validates. */
export interface AiAgentUaEntry {
  /** Lowercase User-Agent substring. */
  marker: string;
  operator: GateOperator;
  ua_class: UaClass;
}

export interface RobotsTokenEntry {
  /** robots.txt product token, as published. */
  token: string;
  operator: GateOperator;
  ua_class: UaClass;
}

// <generated:agents-v1> by scripts/gen-agents.mjs from data/agents-v1.json; do not edit by hand.
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
  "mistral",
  "duckduckgo",
  "cohere",
  "moonshot",
  "you",
  "diffbot",
  "ai2",
  "aifinpay",
  "unknown",
] as const;
export type GateOperator = (typeof GATE_OPERATORS)[number];

export const UA_CLASSES = ["ai_crawler", "ai_agent_browser", "aifp_agent", "human", "unknown"] as const;
export type UaClass = (typeof UA_CLASSES)[number];

/** User-Agent rows, lowercase markers, in match order: first match wins. */
export const AI_AGENT_UA_TABLE: readonly AiAgentUaEntry[] = [
  { marker: "gptbot", operator: "openai", ua_class: "ai_crawler" },
  { marker: "oai-searchbot", operator: "openai", ua_class: "ai_crawler" },
  { marker: "chatgpt-user", operator: "openai", ua_class: "ai_agent_browser" },
  { marker: "claudebot", operator: "anthropic", ua_class: "ai_crawler" },
  { marker: "claude-searchbot", operator: "anthropic", ua_class: "ai_crawler" },
  { marker: "claude-user", operator: "anthropic", ua_class: "ai_agent_browser" },
  { marker: "claude-agent", operator: "anthropic", ua_class: "ai_agent_browser" },
  { marker: "claude-web", operator: "anthropic", ua_class: "ai_agent_browser" },
  { marker: "anthropic-ai", operator: "anthropic", ua_class: "ai_crawler" },
  { marker: "perplexitybot", operator: "perplexity", ua_class: "ai_crawler" },
  { marker: "perplexity-user", operator: "perplexity", ua_class: "ai_agent_browser" },
  { marker: "google-cloudvertexbot", operator: "google", ua_class: "ai_crawler" },
  { marker: "google-gemininotebook", operator: "google", ua_class: "ai_agent_browser" },
  { marker: "google-notebooklm", operator: "google", ua_class: "ai_agent_browser" },
  { marker: "google-agent", operator: "google", ua_class: "ai_agent_browser" },
  { marker: "meta-externalagent", operator: "meta", ua_class: "ai_crawler" },
  { marker: "meta-webindexer", operator: "meta", ua_class: "ai_crawler" },
  { marker: "meta-externalfetcher", operator: "meta", ua_class: "ai_agent_browser" },
  { marker: "amazonbot", operator: "amazon", ua_class: "ai_crawler" },
  { marker: "amzn-searchbot", operator: "amazon", ua_class: "ai_crawler" },
  { marker: "amzn-user", operator: "amazon", ua_class: "ai_agent_browser" },
  { marker: "bedrockbot", operator: "amazon", ua_class: "ai_crawler" },
  { marker: "mistralai-training", operator: "mistral", ua_class: "ai_crawler" },
  { marker: "mistralai-index", operator: "mistral", ua_class: "ai_crawler" },
  { marker: "mistralai-user", operator: "mistral", ua_class: "ai_agent_browser" },
  { marker: "duckassistbot", operator: "duckduckgo", ua_class: "ai_agent_browser" },
  { marker: "ccbot", operator: "commoncrawl", ua_class: "ai_crawler" },
  { marker: "bytespider", operator: "bytedance", ua_class: "ai_crawler" },
  { marker: "youbot", operator: "you", ua_class: "ai_crawler" },
  { marker: "diffbot-user", operator: "diffbot", ua_class: "ai_agent_browser" },
  { marker: "diffbot", operator: "diffbot", ua_class: "ai_crawler" },
  { marker: "timpibot", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "omgilibot", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "cohere-ai", operator: "cohere", ua_class: "ai_agent_browser" },
  { marker: "ai2bot", operator: "ai2", ua_class: "ai_crawler" },
  { marker: "kimibot", operator: "moonshot", ua_class: "ai_crawler" },
  { marker: "kimi-searchbot", operator: "moonshot", ua_class: "ai_crawler" },
  { marker: "kimi-user", operator: "moonshot", ua_class: "ai_agent_browser" },
  { marker: "linerbot", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "liner-user", operator: "unknown", ua_class: "ai_agent_browser" },
  { marker: "exasearchbot", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "exauser", operator: "unknown", ua_class: "ai_agent_browser" },
  { marker: "elevenlabsbot", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "sbintuitionsbot", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "velenpublicwebcrawler", operator: "unknown", ua_class: "ai_crawler" },
  { marker: "aifinpay-agent", operator: "aifinpay", ua_class: "aifp_agent" },
  { marker: "headlesschrome", operator: "unknown", ua_class: "unknown" },
  { marker: "phantomjs", operator: "unknown", ua_class: "unknown" },
];

/** robots.txt product tokens as each operator publishes them, for site checks and edge rules. */
export const ROBOTS_TOKENS: readonly RobotsTokenEntry[] = [
  { token: "GPTBot", operator: "openai", ua_class: "ai_crawler" },
  { token: "OAI-SearchBot", operator: "openai", ua_class: "ai_crawler" },
  { token: "ChatGPT-User", operator: "openai", ua_class: "ai_agent_browser" },
  { token: "ClaudeBot", operator: "anthropic", ua_class: "ai_crawler" },
  { token: "Claude-SearchBot", operator: "anthropic", ua_class: "ai_crawler" },
  { token: "Claude-User", operator: "anthropic", ua_class: "ai_agent_browser" },
  { token: "anthropic-ai", operator: "anthropic", ua_class: "ai_crawler" },
  { token: "PerplexityBot", operator: "perplexity", ua_class: "ai_crawler" },
  { token: "Perplexity-User", operator: "perplexity", ua_class: "ai_agent_browser" },
  { token: "Google-CloudVertexBot", operator: "google", ua_class: "ai_crawler" },
  { token: "Google-Extended", operator: "google", ua_class: "ai_crawler" },
  { token: "meta-externalagent", operator: "meta", ua_class: "ai_crawler" },
  { token: "meta-webindexer", operator: "meta", ua_class: "ai_crawler" },
  { token: "meta-externalfetcher", operator: "meta", ua_class: "ai_agent_browser" },
  { token: "Amazonbot", operator: "amazon", ua_class: "ai_crawler" },
  { token: "Amzn-SearchBot", operator: "amazon", ua_class: "ai_crawler" },
  { token: "Amzn-User", operator: "amazon", ua_class: "ai_agent_browser" },
  { token: "bedrockbot", operator: "amazon", ua_class: "ai_crawler" },
  { token: "amazon-kendra", operator: "amazon", ua_class: "ai_crawler" },
  { token: "amazon-QBusiness", operator: "amazon", ua_class: "ai_crawler" },
  { token: "Applebot-Extended", operator: "apple", ua_class: "ai_crawler" },
  { token: "MistralAI-Training", operator: "mistral", ua_class: "ai_crawler" },
  { token: "MistralAI-Index", operator: "mistral", ua_class: "ai_crawler" },
  { token: "MistralAI-User", operator: "mistral", ua_class: "ai_agent_browser" },
  { token: "DuckAssistBot", operator: "duckduckgo", ua_class: "ai_agent_browser" },
  { token: "CCBot", operator: "commoncrawl", ua_class: "ai_crawler" },
  { token: "Bytespider", operator: "bytedance", ua_class: "ai_crawler" },
  { token: "Diffbot-User", operator: "diffbot", ua_class: "ai_agent_browser" },
  { token: "Diffbot", operator: "diffbot", ua_class: "ai_crawler" },
  { token: "webzio-extended", operator: "unknown", ua_class: "ai_crawler" },
  { token: "KimiBot", operator: "moonshot", ua_class: "ai_crawler" },
  { token: "Kimi-SearchBot", operator: "moonshot", ua_class: "ai_crawler" },
  { token: "Kimi-User", operator: "moonshot", ua_class: "ai_agent_browser" },
  { token: "LinerBot", operator: "unknown", ua_class: "ai_crawler" },
  { token: "Liner-User", operator: "unknown", ua_class: "ai_agent_browser" },
  { token: "ExaSearchBot", operator: "unknown", ua_class: "ai_crawler" },
  { token: "ElevenlabsBot", operator: "unknown", ua_class: "ai_crawler" },
  { token: "SBIntuitionsBot", operator: "unknown", ua_class: "ai_crawler" },
  { token: "VelenPublicWebCrawler", operator: "unknown", ua_class: "ai_crawler" },
];
// </generated:agents-v1>

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
