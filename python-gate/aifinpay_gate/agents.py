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

# Closed sets, shared verbatim with the AiFinPay gate-events ingest (which
# refuses any other value) and the site-check probe. An operator without an id
# here is "unknown", never a free-text name: the value becomes a counter key.
GATE_OPERATORS = (
    "openai", "anthropic", "perplexity", "google", "microsoft", "meta", "bytedance",
    "apple", "amazon", "commoncrawl", "aifinpay", "unknown",
)
# ai_crawler: bulk fetch for training or a search index. ai_agent_browser: fetch
# because a person asked an assistant. aifp_agent: speaks AIFP. human: a
# User-Agent with no automation marker (a stealth bot lands here too). unknown:
# automation of unknown purpose — no User-Agent, headless browsers.
UA_CLASSES = ("ai_crawler", "ai_agent_browser", "aifp_agent", "human", "unknown")

# (marker, operator, ua_class) — lowercase User-Agent substrings; first match wins.
AI_AGENT_UA_TABLE = (
    ("gptbot", "openai", "ai_crawler"),
    ("oai-searchbot", "openai", "ai_crawler"),
    ("chatgpt-user", "openai", "ai_agent_browser"),
    ("claudebot", "anthropic", "ai_crawler"),
    ("claude-searchbot", "anthropic", "ai_crawler"),
    ("claude-user", "anthropic", "ai_agent_browser"),
    ("claude-web", "anthropic", "ai_agent_browser"),
    ("anthropic-ai", "anthropic", "ai_crawler"),
    ("perplexitybot", "perplexity", "ai_crawler"),
    ("perplexity-user", "perplexity", "ai_agent_browser"),
    ("ccbot", "commoncrawl", "ai_crawler"),
    ("bytespider", "bytedance", "ai_crawler"),
    ("google-extended", "google", "ai_crawler"),
    ("applebot-extended", "apple", "ai_crawler"),
    ("meta-externalagent", "meta", "ai_crawler"),
    ("facebookbot", "meta", "ai_crawler"),
    ("amazonbot", "amazon", "ai_crawler"),
    ("youbot", "unknown", "ai_crawler"),
    ("diffbot", "unknown", "ai_crawler"),
    ("timpibot", "unknown", "ai_crawler"),
    ("omgilibot", "unknown", "ai_crawler"),
    ("cohere-ai", "unknown", "ai_agent_browser"),
    ("ai2bot", "unknown", "ai_crawler"),
    ("mistralai", "unknown", "ai_agent_browser"),
    ("aifinpay-agent", "aifinpay", "aifp_agent"),
    ("headlesschrome", "unknown", "unknown"),
    ("phantomjs", "unknown", "unknown"),
)

AI_AGENT_UA_MARKERS = tuple(marker for marker, _, _ in AI_AGENT_UA_TABLE)


# HTTP libraries and command-line clients in their default configuration: (marker, "prefix" | "word").
SCRIPT_CLIENT_MARKERS = (
    ("curl/", "prefix"),
    ("wget/", "prefix"),
    ("python-requests", "prefix"),
    ("python-urllib", "prefix"),
    ("python-httpx", "prefix"),
    ("httpx/", "word"),
    ("aiohttp", "word"),
    ("go-http-client", "prefix"),
    ("node-fetch", "prefix"),
    ("undici", "prefix"),
    ("axios/", "prefix"),
    ("got (", "prefix"),
    ("okhttp", "prefix"),
    ("java/", "prefix"),
    ("apache-httpclient", "prefix"),
    ("libwww-perl", "prefix"),
    ("scrapy", "prefix"),
    ("guzzlehttp", "prefix"),
    ("ruby", "prefix"),
    ("faraday", "prefix"),
    ("restsharp", "prefix"),
    ("postmanruntime", "prefix"),
    ("insomnia", "prefix"),
    ("httpie", "prefix"),
    ("colly", "prefix"),
    ("puppeteer", "word"),
    ("playwright", "word"),
    ("selenium", "word"),
)


def is_script_client_ua(ua: str) -> bool:
    """True when a lowercase User-Agent matches a SCRIPT_CLIENT_MARKERS entry under its rule."""
    for marker, match in SCRIPT_CLIENT_MARKERS:
        if match == "prefix":
            if ua.startswith(marker):
                return True
            continue
        at = ua.find(marker)
        while at != -1:
            if at == 0 or not ("a" <= ua[at - 1] <= "z" or "0" <= ua[at - 1] <= "9"):
                return True
            at = ua.find(marker, at + 1)
    return False


def identify_request(req, script_client_allow=()) -> tuple:
    """(identity, script): who asked, and whether the gate's script_clients option decides for it."""
    if req.header("AIFP-Receipt") or req.header("AIFP-Agent-Id"):
        return {"operator": "aifinpay", "ua_class": "aifp_agent", "verified": False}, False
    ua = (req.header("user-agent") or "").lower()
    if not ua:
        return {"operator": "unknown", "ua_class": "unknown", "verified": False}, False  # no browser sends none
    for marker, operator, ua_class in AI_AGENT_UA_TABLE:
        if marker in ua:
            return {"operator": operator, "ua_class": ua_class, "verified": False}, False
    if not any(allowed in ua for allowed in script_client_allow) and is_script_client_ua(ua):
        return {"operator": "unknown", "ua_class": "unknown", "verified": False}, True
    return {"operator": "unknown", "ua_class": "human", "verified": False}, False


def classify_agent(req) -> dict:
    """Who a request says it is. Never ``verified: True`` — every input here is
    a header the client wrote; the gate upgrades an event only after the
    request's receipt verifies. Never returns the raw User-Agent."""
    return identify_request(req)[0]


def known_ai_agent(req) -> bool:
    # A paying agent must never be exempted by a human-looking User-Agent:
    # classify_agent puts AIFP-Receipt / AIFP-Agent-Id first for that reason.
    # Script clients are the gate's script_clients decision, not this predicate's.
    who, script = identify_request(req)
    return who["ua_class"] != "human" and not script
