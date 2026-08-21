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
 * Self-identifying AI crawler / agent User-Agent substrings, lowercase.
 *
 * Curated, not exhaustive — new crawlers appear monthly, and each entry is a
 * revenue opportunity, not a threat signature. Sources: the population
 * Cloudflare's verified-bot list classifies as AI, plus the operators that
 * publish their UA strings.
 */
export const AI_AGENT_UA_MARKERS: readonly string[] = [
  // OpenAI
  "gptbot",
  "oai-searchbot",
  "chatgpt-user",
  // Anthropic
  "claudebot",
  "claude-web",
  "anthropic-ai",
  // Perplexity
  "perplexitybot",
  "perplexity-user",
  // Common Crawl (feeds many trainers)
  "ccbot",
  // ByteDance
  "bytespider",
  // Google's opt-out-able training fetcher (distinct from Googlebot search)
  "google-extended",
  // Apple
  "applebot-extended",
  // Meta
  "meta-externalagent",
  "facebookbot",
  // Amazon
  "amazonbot",
  // Others with published AI/LLM fetchers
  "youbot",
  "diffbot",
  "timpibot",
  "omgilibot",
  "cohere-ai",
  "ai2bot",
  "mistralai",
  // Automation frameworks in their DEFAULT configuration. Headless
  // Chromium/Chrome announces itself as "HeadlessChrome/126…" unless the
  // driver overrides the UA — so an un-disguised Playwright/Puppeteer visit
  // is a self-identifying machine, same as the crawlers above. One that
  // spoofs a human UA has left "by declaration" territory; that class is an
  // anti-bot product's job, not this list's.
  // NOT "electron": Electron UAs are real humans inside app webviews
  // (Slack, Notion), and exempting humans is this predicate's entire promise.
  "headlesschrome",
  "phantomjs",
];

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
  // Speaking the protocol IS the declaration — a paying agent must never be
  // exempted by a human-looking User-Agent, or its receipt spend would stop
  // metering.
  if (req.header("AIFP-Receipt") || req.header("AIFP-Agent-Id")) return true;

  const ua = (req.header("user-agent") ?? "").toLowerCase();
  if (!ua) return true; // no User-Agent at all: no browser does that; scripts do

  for (const marker of AI_AGENT_UA_MARKERS) {
    if (ua.includes(marker)) return true;
  }
  return false;
}
