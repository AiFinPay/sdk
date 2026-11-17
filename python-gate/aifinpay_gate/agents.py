"""Who is an AI agent — the default ``should_charge`` for content sites.

A curated list of self-identifying crawlers plus one stronger signal: a
request already speaking AIFP (AIFP-Receipt or AIFP-Agent-Id) is an agent by
its own declaration. It is not stealth detection; a scraper with a browser
User-Agent walks past it, as it walks past Cloudflare's classifier. Extend it:

    should_charge=lambda req: known_ai_agent(req) or my_signal(req)

The same table says who runs each client (``classify_agent``), so the gate can
report operator / ua_class / verified on every event. A port of
gate/src/agents.ts — tests/test_parity.py holds the two tables equal.
"""

# Closed sets from data/agents-v1.json; the gate-events ingest refuses any other value.
# <generated:agents-v1> by gate/scripts/gen-agents.mjs from data/agents-v1.json; do not edit by hand.
GATE_OPERATORS = (
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
)
UA_CLASSES = ("ai_crawler", "ai_agent_browser", "aifp_agent", "human", "unknown")

# (marker, operator, ua_class): lowercase User-Agent substrings in match order, first match wins.
AI_AGENT_UA_TABLE = (
    ("gptbot", "openai", "ai_crawler"),
    ("oai-searchbot", "openai", "ai_crawler"),
    ("chatgpt-user", "openai", "ai_agent_browser"),
    ("claudebot", "anthropic", "ai_crawler"),
    ("claude-searchbot", "anthropic", "ai_crawler"),
    ("claude-user", "anthropic", "ai_agent_browser"),
    ("claude-agent", "anthropic", "ai_agent_browser"),
    ("claude-web", "anthropic", "ai_agent_browser"),
    ("anthropic-ai", "anthropic", "ai_crawler"),
    ("perplexitybot", "perplexity", "ai_crawler"),
    ("perplexity-user", "perplexity", "ai_agent_browser"),
    ("google-cloudvertexbot", "google", "ai_crawler"),
    ("google-gemininotebook", "google", "ai_agent_browser"),
    ("google-notebooklm", "google", "ai_agent_browser"),
    ("google-agent", "google", "ai_agent_browser"),
    ("meta-externalagent", "meta", "ai_crawler"),
    ("meta-webindexer", "meta", "ai_crawler"),
    ("meta-externalfetcher", "meta", "ai_agent_browser"),
    ("amazonbot", "amazon", "ai_crawler"),
    ("amzn-searchbot", "amazon", "ai_crawler"),
    ("amzn-user", "amazon", "ai_agent_browser"),
    ("bedrockbot", "amazon", "ai_crawler"),
    ("mistralai-training", "mistral", "ai_crawler"),
    ("mistralai-index", "mistral", "ai_crawler"),
    ("mistralai-user", "mistral", "ai_agent_browser"),
    ("duckassistbot", "duckduckgo", "ai_agent_browser"),
    ("ccbot", "commoncrawl", "ai_crawler"),
    ("bytespider", "bytedance", "ai_crawler"),
    ("youbot", "you", "ai_crawler"),
    ("diffbot-user", "diffbot", "ai_agent_browser"),
    ("diffbot", "diffbot", "ai_crawler"),
    ("timpibot", "unknown", "ai_crawler"),
    ("omgilibot", "unknown", "ai_crawler"),
    ("cohere-ai", "cohere", "ai_agent_browser"),
    ("ai2bot", "ai2", "ai_crawler"),
    ("kimibot", "moonshot", "ai_crawler"),
    ("kimi-searchbot", "moonshot", "ai_crawler"),
    ("kimi-user", "moonshot", "ai_agent_browser"),
    ("linerbot", "unknown", "ai_crawler"),
    ("liner-user", "unknown", "ai_agent_browser"),
    ("exasearchbot", "unknown", "ai_crawler"),
    ("exauser", "unknown", "ai_agent_browser"),
    ("elevenlabsbot", "unknown", "ai_crawler"),
    ("sbintuitionsbot", "unknown", "ai_crawler"),
    ("velenpublicwebcrawler", "unknown", "ai_crawler"),
    ("aifinpay-agent", "aifinpay", "aifp_agent"),
    ("headlesschrome", "unknown", "unknown"),
    ("phantomjs", "unknown", "unknown"),
)

# (token, operator, ua_class): robots.txt product tokens as each operator publishes them.
ROBOTS_TOKENS = (
    ("GPTBot", "openai", "ai_crawler"),
    ("OAI-SearchBot", "openai", "ai_crawler"),
    ("ChatGPT-User", "openai", "ai_agent_browser"),
    ("ClaudeBot", "anthropic", "ai_crawler"),
    ("Claude-SearchBot", "anthropic", "ai_crawler"),
    ("Claude-User", "anthropic", "ai_agent_browser"),
    ("anthropic-ai", "anthropic", "ai_crawler"),
    ("PerplexityBot", "perplexity", "ai_crawler"),
    ("Perplexity-User", "perplexity", "ai_agent_browser"),
    ("Google-CloudVertexBot", "google", "ai_crawler"),
    ("Google-Extended", "google", "ai_crawler"),
    ("meta-externalagent", "meta", "ai_crawler"),
    ("meta-webindexer", "meta", "ai_crawler"),
    ("meta-externalfetcher", "meta", "ai_agent_browser"),
    ("Amazonbot", "amazon", "ai_crawler"),
    ("Amzn-SearchBot", "amazon", "ai_crawler"),
    ("Amzn-User", "amazon", "ai_agent_browser"),
    ("bedrockbot", "amazon", "ai_crawler"),
    ("amazon-kendra", "amazon", "ai_crawler"),
    ("amazon-QBusiness", "amazon", "ai_crawler"),
    ("Applebot-Extended", "apple", "ai_crawler"),
    ("MistralAI-Training", "mistral", "ai_crawler"),
    ("MistralAI-Index", "mistral", "ai_crawler"),
    ("MistralAI-User", "mistral", "ai_agent_browser"),
    ("DuckAssistBot", "duckduckgo", "ai_agent_browser"),
    ("CCBot", "commoncrawl", "ai_crawler"),
    ("Bytespider", "bytedance", "ai_crawler"),
    ("Diffbot-User", "diffbot", "ai_agent_browser"),
    ("Diffbot", "diffbot", "ai_crawler"),
    ("webzio-extended", "unknown", "ai_crawler"),
    ("KimiBot", "moonshot", "ai_crawler"),
    ("Kimi-SearchBot", "moonshot", "ai_crawler"),
    ("Kimi-User", "moonshot", "ai_agent_browser"),
    ("LinerBot", "unknown", "ai_crawler"),
    ("Liner-User", "unknown", "ai_agent_browser"),
    ("ExaSearchBot", "unknown", "ai_crawler"),
    ("ElevenlabsBot", "unknown", "ai_crawler"),
    ("SBIntuitionsBot", "unknown", "ai_crawler"),
    ("VelenPublicWebCrawler", "unknown", "ai_crawler"),
)
# </generated:agents-v1>

AI_AGENT_UA_MARKERS = tuple(marker for marker, _, _ in AI_AGENT_UA_TABLE)


def classify_agent(req) -> dict:
    """Who a request says it is. Never ``verified: True`` — every input here is
    a header the client wrote; the gate upgrades an event only after the
    request's receipt verifies. Never returns the raw User-Agent."""
    if req.header("AIFP-Receipt") or req.header("AIFP-Agent-Id"):
        return {"operator": "aifinpay", "ua_class": "aifp_agent", "verified": False}
    ua = (req.header("user-agent") or "").lower()
    if not ua:
        return {"operator": "unknown", "ua_class": "unknown", "verified": False}  # no browser sends none
    for marker, operator, ua_class in AI_AGENT_UA_TABLE:
        if marker in ua:
            return {"operator": operator, "ua_class": ua_class, "verified": False}
    return {"operator": "unknown", "ua_class": "human", "verified": False}


def known_ai_agent(req) -> bool:
    # A paying agent must never be exempted by a human-looking User-Agent:
    # classify_agent puts AIFP-Receipt / AIFP-Agent-Id first for that reason.
    return classify_agent(req)["ua_class"] != "human"
