"""Script clients (curl, HTTP libraries) on a content site: script_clients decides."""
import base64
import json

import nacl.signing
import pytest

import aifinpay_gate as g
from aifinpay_gate.agents import identify_request

KEY = nacl.signing.SigningKey(b"\x07" * 32)
MID = "mrch_test"
NOW = 1_800_000_000

# One default User-Agent per marker, keyed by the marker it must hit.
DEFAULT_UAS = {
    "curl/": "curl/8.5.0",
    "wget/": "Wget/1.21.4",
    "python-requests": "python-requests/2.32.3",
    "python-urllib": "Python-urllib/3.12",
    "python-httpx": "python-httpx/0.27.0",
    "httpx/": "httpx/1.0",
    "aiohttp": "Python/3.12 aiohttp/3.9.5",
    "go-http-client": "Go-http-client/1.1",
    "node-fetch": "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
    "undici": "undici",
    "axios/": "axios/1.7.2",
    "got (": "got (https://github.com/sindresorhus/got)",
    "okhttp": "okhttp/4.12.0",
    "java/": "Java/17.0.10",
    "apache-httpclient": "Apache-HttpClient/4.5.14 (Java/17.0.10)",
    "libwww-perl": "libwww-perl/6.77",
    "scrapy": "Scrapy/2.11.2 (+https://scrapy.org)",
    "guzzlehttp": "GuzzleHttp/7",
    "ruby": "Ruby",
    "faraday": "Faraday v2.10.0",
    "restsharp": "RestSharp/111.4.0.0",
    "postmanruntime": "PostmanRuntime/7.39.0",
    "insomnia": "insomnia/9.3.2",
    "httpie": "HTTPie/3.2.3",
    "colly": "colly - https://github.com/gocolly/colly",
    "puppeteer": "Mozilla/5.0 (X11; Linux x86_64) Puppeteer/22.12.0",
    "playwright": "Mozilla/5.0 (X11; Linux x86_64) Playwright/1.45.0",
    "selenium": "Mozilla/5.0 (X11; Linux x86_64) Selenium/4.22.0",
}

BROWSER_UAS = {
    "Chrome Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Chrome macOS": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
    "Safari macOS": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
    "Firefox Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Firefox Linux": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
    "Edge": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
    "Opera": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
    "Chrome Android": "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
    "Samsung Internet": "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
    "Safari iPhone": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Chrome iPhone": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
    "Safari iPad": "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
    "Facebook in-app": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.97;FBBV/634541429;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/80]",
    "Instagram in-app": "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 Instagram 312.0.0.32.112 Android (33/13; 420dpi; 1080x2400; Google/google; Pixel 7; panther; panther; en_US; 548323757)",
    "Android WebView": "Mozilla/5.0 (Linux; Android 14; SM-A546B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.39 Mobile Safari/537.36",
    "Slack desktop": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.41.97 Chrome/130.0.6723.59 Electron/33.0.1 Safari/537.36 Sonic Slack_SSB/4.41.97",
    "Googlebot": "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Googlebot smartphone": "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.69 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
    "Bingbot": "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
}

NAMED_CRAWLERS = [
    ("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)", "openai", "ai_crawler"),
    ("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)", "anthropic", "ai_crawler"),
    ("Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)", "perplexity", "ai_crawler"),
    ("CCBot/2.0 (https://commoncrawl.org/faq/) python-requests/2.32.3", "commoncrawl", "ai_crawler"),
    ("aifinpay-agent-py/2.6.1 python-requests/2.32.3", "aifinpay", "aifp_agent"),
]

MODES = ("observe", "charge", "allow")


def b64(b: bytes) -> str:
    return base64.urlsafe_b64encode(b).rstrip(b"=").decode()


def token(**claims):
    c = {"iss": "https://api.aifinpay.io", "aud": MID, "sub": "0xabc", "iat": NOW, "exp": NOW + 3600,
         "resource": "/paid", "scope": "exact", "unit_quota": 10, "receipt_id": "rcpt_1", "nonce": "n1", **claims}
    h = b64(json.dumps({"alg": "EdDSA", "typ": "JWT", "kid": "k1"}).encode())
    p = b64(json.dumps(c).encode())
    return f"{h}.{p}.{b64(KEY.sign(f'{h}.{p}'.encode()).signature)}"


def content_gate(events, **kw):
    kw.setdefault("should_charge", g.known_ai_agent)
    jwks = {"keys": [{"kty": "OKP", "crv": "Ed25519", "x": b64(bytes(KEY.verify_key)), "kid": "k1", "alg": "EdDSA"}]}
    return g.Gate(MID, resource="/paid", jwks=jwks, now=lambda: NOW, on_event=events.append, **kw)


def ask(ua, **headers):
    return g.SimpleRequest("/paid", {"User-Agent": ua, **headers})


def test_every_marker_has_a_sample_that_hits_it():
    assert sorted(DEFAULT_UAS) == sorted(marker for marker, _ in g.SCRIPT_CLIENT_MARKERS)
    for marker, match in g.SCRIPT_CLIENT_MARKERS:
        ua = DEFAULT_UAS[marker].lower()
        assert (ua.startswith(marker) if match == "prefix" else marker in ua), marker


@pytest.mark.parametrize("ua", DEFAULT_UAS.values())
def test_charge_refuses_a_script_client(ua):
    events = []
    r = content_gate(events, script_clients="charge").decide(ask(ua))
    assert (r.ok, r.status) == (False, 402)
    assert [(e["kind"], e["operator"], e["ua_class"]) for e in events] == [("402", "unknown", "unknown")]


@pytest.mark.parametrize("ua", DEFAULT_UAS.values())
def test_observe_serves_free_and_says_charge_would_refuse(ua):
    events = []
    r = content_gate(events).decide(ask(ua))
    assert r.ok and r.aifp["mode"] == "exempt"
    assert len(events) == 1
    assert events[0]["kind"] == "serve" and events[0]["exempt"] is True
    assert events[0]["detail"] == g.DETAIL_SCRIPT_CLIENT_OBSERVED
    assert (events[0]["operator"], events[0]["ua_class"]) == ("unknown", "unknown")


@pytest.mark.parametrize("ua", DEFAULT_UAS.values())
def test_allow_serves_free_with_no_detail(ua):
    events = []
    r = content_gate(events, script_clients="allow").decide(ask(ua))
    assert r.ok and r.aifp["mode"] == "exempt"
    assert len(events) == 1 and events[0]["ua_class"] == "unknown" and "detail" not in events[0]


@pytest.mark.parametrize("mode", MODES)
def test_an_allow_list_hit_is_a_reader_before_the_table(mode):
    events = []
    gate = content_gate(events, script_clients=mode, script_client_allow=["StatusCake"])
    assert gate.decide(ask("curl/8.5.0 statuscake")).ok
    assert events[0]["ua_class"] == "human" and "detail" not in events[0]
    assert gate.decide(ask("curl/8.5.0")).ok is (mode != "charge")


@pytest.mark.parametrize("ua", BROWSER_UAS.values(), ids=list(BROWSER_UAS))
def test_a_browser_is_never_a_script_client(ua):
    assert identify_request(ask(ua))[1] is False
    events = []
    assert content_gate(events, script_clients="charge").decide(ask(ua)).ok
    assert events[0]["ua_class"] == "human"


@pytest.mark.parametrize("mode", MODES)
@pytest.mark.parametrize("ua,operator,ua_class", NAMED_CRAWLERS)
def test_named_crawlers_keep_their_identity_and_are_charged(mode, ua, operator, ua_class):
    events = []
    r = content_gate(events, script_clients=mode).decide(ask(ua))
    assert (r.ok, r.status) == (False, 402)
    assert (events[0]["operator"], events[0]["ua_class"]) == (operator, ua_class)


@pytest.mark.parametrize("mode", MODES)
def test_an_aifp_header_or_a_receipt_is_unaffected(mode):
    events = []
    gate = content_gate(events, script_clients=mode)
    declared = gate.decide(ask("curl/8.5.0", **{"AIFP-Agent-Id": "0x" + "ab" * 20}))
    assert (declared.ok, declared.status) == (False, 402)
    assert events[0]["ua_class"] == "aifp_agent"
    paid = gate.decide(ask("curl/8.5.0", **{"AIFP-Receipt": token()}))
    assert paid.ok and paid.aifp["mode"] == "paid"


def test_a_merchants_own_predicate_decides_alone():
    events = []
    assert content_gate(events, script_clients="charge", should_charge=lambda req: False).decide(ask("curl/8.5.0")).ok
    assert "detail" not in events[0]
    assert not content_gate([], script_clients="allow", should_charge=None).decide(ask("curl/8.5.0")).ok


@pytest.mark.parametrize("bad", [{"script_clients": "Charge"}, {"script_clients": "off"},
                                 {"script_client_allow": "curl"}, {"script_client_allow": [""]}])
def test_an_unknown_value_throws_at_construction(bad):
    with pytest.raises(ValueError, match="script_client"):
        content_gate([], **bad)
