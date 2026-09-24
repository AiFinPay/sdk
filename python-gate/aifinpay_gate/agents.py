"""Who is an AI agent — the default ``should_charge`` for content sites.

A curated list of self-identifying crawlers plus one stronger signal: a
request already speaking AIFP (AIFP-Receipt or AIFP-Agent-Id) is an agent by
its own declaration. It is not stealth detection; a scraper with a browser
User-Agent walks past it, as it walks past Cloudflare's classifier. Extend it:

    should_charge=lambda req: known_ai_agent(req) or my_signal(req)
"""

AI_AGENT_UA_MARKERS = (
    "gptbot", "oai-searchbot", "chatgpt-user",
    "claudebot", "claude-web", "anthropic-ai",
    "perplexitybot", "perplexity-user",
    "ccbot", "bytespider", "google-extended", "applebot-extended",
    "meta-externalagent", "facebookbot", "amazonbot",
    "youbot", "diffbot", "timpibot", "omgilibot", "cohere-ai", "ai2bot", "mistralai",
    "aifinpay-agent",
    "headlesschrome", "phantomjs",
)


def known_ai_agent(req) -> bool:
    # A paying agent must never be exempted by a human-looking User-Agent.
    if req.header("AIFP-Receipt") or req.header("AIFP-Agent-Id"):
        return True
    ua = (req.header("user-agent") or "").lower()
    if not ua:
        return True  # no browser sends none; scripts do
    return any(marker in ua for marker in AI_AGENT_UA_MARKERS)
