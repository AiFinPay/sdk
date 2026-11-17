// Script clients (curl, HTTP libraries) on a content site: scriptClients decides.
import { describe, expect, it } from "vitest";
import {
  createGate,
  DETAIL_SCRIPT_CLIENT_OBSERVED,
  knownAiAgent,
  MemoryStore,
  SCRIPT_CLIENT_MARKERS,
  type GateEvent,
} from "../src/index.js";
import { identifyRequest } from "../src/agents.js";
import { ISSUER, MERCHANT, issuer, req, signReceipt } from "./helpers.js";

// One default User-Agent per marker, keyed by the marker it must hit.
const DEFAULT_UAS: Record<string, string> = {
  "curl/": "curl/8.5.0",
  "wget/": "Wget/1.21.4",
  "python-requests": "python-requests/2.32.3",
  "python-urllib": "Python-urllib/3.12",
  "python-httpx": "python-httpx/0.27.0",
  "httpx/": "httpx/1.0",
  aiohttp: "Python/3.12 aiohttp/3.9.5",
  "go-http-client": "Go-http-client/1.1",
  "node-fetch": "node-fetch/1.0 (+https://github.com/bitinn/node-fetch)",
  undici: "undici",
  "axios/": "axios/1.7.2",
  "got (": "got (https://github.com/sindresorhus/got)",
  okhttp: "okhttp/4.12.0",
  "java/": "Java/17.0.10",
  "apache-httpclient": "Apache-HttpClient/4.5.14 (Java/17.0.10)",
  "libwww-perl": "libwww-perl/6.77",
  scrapy: "Scrapy/2.11.2 (+https://scrapy.org)",
  guzzlehttp: "GuzzleHttp/7",
  ruby: "Ruby",
  faraday: "Faraday v2.10.0",
  restsharp: "RestSharp/111.4.0.0",
  postmanruntime: "PostmanRuntime/7.39.0",
  insomnia: "insomnia/9.3.2",
  httpie: "HTTPie/3.2.3",
  colly: "colly - https://github.com/gocolly/colly",
  puppeteer: "Mozilla/5.0 (X11; Linux x86_64) Puppeteer/22.12.0",
  playwright: "Mozilla/5.0 (X11; Linux x86_64) Playwright/1.45.0",
  selenium: "Mozilla/5.0 (X11; Linux x86_64) Selenium/4.22.0",
};

const BROWSER_UAS: Record<string, string> = {
  "Chrome Windows":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Chrome macOS":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36",
  "Safari macOS":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
  "Firefox Windows": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:132.0) Gecko/20100101 Firefox/132.0",
  "Firefox Linux": "Mozilla/5.0 (X11; Ubuntu; Linux x86_64; rv:132.0) Gecko/20100101 Firefox/132.0",
  Edge: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 Edg/131.0.0.0",
  Opera:
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 OPR/115.0.0.0",
  "Chrome Android":
    "Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36",
  "Samsung Internet":
    "Mozilla/5.0 (Linux; Android 14; SM-S918B) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/26.0 Chrome/122.0.0.0 Mobile Safari/537.36",
  "Safari iPhone":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Chrome iPhone":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/131.0.6778.73 Mobile/15E148 Safari/604.1",
  "Safari iPad":
    "Mozilla/5.0 (iPad; CPU OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1",
  "Facebook in-app":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148 [FBAN/FBIOS;FBAV/470.0.0.40.97;FBBV/634541429;FBDV/iPhone15,2;FBMD/iPhone;FBSN/iOS;FBSV/17.5;FBSS/3;FBCR/;FBID/phone;FBLC/en_US;FBOP/80]",
  "Instagram in-app":
    "Mozilla/5.0 (Linux; Android 13; Pixel 7 Build/TQ3A.230805.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/120.0.6099.230 Mobile Safari/537.36 Instagram 312.0.0.32.112 Android (33/13; 420dpi; 1080x2400; Google/google; Pixel 7; panther; panther; en_US; 548323757)",
  "Android WebView":
    "Mozilla/5.0 (Linux; Android 14; SM-A546B Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/131.0.6778.39 Mobile Safari/537.36",
  "Slack desktop":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Slack/4.41.97 Chrome/130.0.6723.59 Electron/33.0.1 Safari/537.36 Sonic Slack_SSB/4.41.97",
  Googlebot: "Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  "Googlebot smartphone":
    "Mozilla/5.0 (Linux; Android 6.0.1; Nexus 5X Build/MMB29P) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.6778.69 Mobile Safari/537.36 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)",
  Bingbot: "Mozilla/5.0 (compatible; bingbot/2.0; +http://www.bing.com/bingbot.htm)",
};

const NAMED_CRAWLERS: [string, string, string][] = [
  [
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)",
    "openai",
    "ai_crawler",
  ],
  [
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; ClaudeBot/1.0; +claudebot@anthropic.com)",
    "anthropic",
    "ai_crawler",
  ],
  [
    "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; PerplexityBot/1.0; +https://perplexity.ai/perplexitybot)",
    "perplexity",
    "ai_crawler",
  ],
  ["CCBot/2.0 (https://commoncrawl.org/faq/) python-requests/2.32.3", "commoncrawl", "ai_crawler"],
  ["aifinpay-agent-py/2.6.1 python-requests/2.32.3", "aifinpay", "aifp_agent"],
];

const MODES = ["observe", "charge", "allow"] as const;

async function contentGate(overrides: Record<string, unknown> = {}) {
  const iss = await issuer();
  const events: GateEvent[] = [];
  const gate = createGate({
    merchantId: MERCHANT,
    resource: "/articles",
    tier: "standard",
    issuer: ISSUER,
    jwks: iss.jwks,
    store: new MemoryStore(),
    shouldCharge: knownAiAgent,
    onEvent: (e) => events.push(e),
    ...overrides,
  });
  return { gate, iss, events };
}

describe("script clients", () => {
  it("every marker has a default User-Agent sample, and each sample hits its own marker", () => {
    expect(Object.keys(DEFAULT_UAS).sort()).toEqual(SCRIPT_CLIENT_MARKERS.map((m) => m.marker).sort());
    for (const entry of SCRIPT_CLIENT_MARKERS) {
      const ua = DEFAULT_UAS[entry.marker].toLowerCase();
      const hit = entry.match === "prefix" ? ua.startsWith(entry.marker) : ua.includes(entry.marker);
      expect(hit, entry.marker).toBe(true);
    }
  });

  it.each(Object.entries(DEFAULT_UAS))("charge refuses %s with a 402", async (_marker, ua) => {
    const { gate, events } = await contentGate({ scriptClients: "charge" });
    const r = await gate(req("/articles", { "User-Agent": ua }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(402);
    expect(events).toMatchObject([{ kind: "402", operator: "unknown", ua_class: "unknown", verified: false }]);
  });

  it.each(Object.entries(DEFAULT_UAS))("observe serves %s free and says charge would refuse", async (_marker, ua) => {
    const { gate, events } = await contentGate();
    const r = await gate(req("/articles", { "User-Agent": ua }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aifp.mode).toBe("exempt");
    expect(events).toEqual([
      expect.objectContaining({
        kind: "serve",
        exempt: true,
        detail: DETAIL_SCRIPT_CLIENT_OBSERVED,
        operator: "unknown",
        ua_class: "unknown",
      }),
    ]);
  });

  it.each(Object.entries(DEFAULT_UAS))("allow serves %s free with no detail", async (_marker, ua) => {
    const { gate, events } = await contentGate({ scriptClients: "allow" });
    const r = await gate(req("/articles", { "User-Agent": ua }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.aifp.mode).toBe("exempt");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ kind: "serve", exempt: true, ua_class: "unknown" });
    expect(events[0].detail).toBeUndefined();
  });

  it("an allow-list hit is a reader, before the table, in every mode", async () => {
    for (const scriptClients of MODES) {
      const { gate, events } = await contentGate({ scriptClients, scriptClientAllow: ["StatusCake"] });
      const r = await gate(req("/articles", { "User-Agent": "curl/8.5.0 statuscake" }));
      expect(r.ok, scriptClients).toBe(true);
      expect(events[0]).toMatchObject({ kind: "serve", exempt: true, ua_class: "human" });
      expect(events[0].detail).toBeUndefined();
      const other = await gate(req("/articles", { "User-Agent": "curl/8.5.0" }));
      expect(other.ok, `${scriptClients}: not on the list`).toBe(scriptClients !== "charge");
    }
  });

  it.each(Object.entries(BROWSER_UAS))("%s is never a script client", async (_name, ua) => {
    expect(identifyRequest(req("/articles", { "User-Agent": ua })).script).toBe(false);
    const { gate, events } = await contentGate({ scriptClients: "charge" });
    const r = await gate(req("/articles", { "User-Agent": ua }));
    expect(r.ok).toBe(true);
    expect(events[0]).toMatchObject({ kind: "serve", exempt: true, ua_class: "human" });
  });

  it("named crawlers keep their operator and class, charged in every mode", async () => {
    for (const scriptClients of MODES) {
      for (const [ua, operator, ua_class] of NAMED_CRAWLERS) {
        const { gate, events } = await contentGate({ scriptClients });
        const r = await gate(req("/articles", { "User-Agent": ua }));
        expect(r.ok, `${scriptClients} ${ua}`).toBe(false);
        expect(events[0]).toMatchObject({ kind: "402", operator, ua_class });
      }
    }
  });

  it("an AIFP header or a receipt is unaffected", async () => {
    for (const scriptClients of MODES) {
      const { gate, iss, events } = await contentGate({ scriptClients });
      const declared = await gate(
        req("/articles", { "User-Agent": "curl/8.5.0", "AIFP-Agent-Id": "0x" + "ab".repeat(20) })
      );
      expect(declared.ok, scriptClients).toBe(false);
      if (!declared.ok) expect(declared.status).toBe(402);
      expect(events[0]).toMatchObject({ operator: "aifinpay", ua_class: "aifp_agent" });
      const token = await signReceipt(iss.privateKey, { resource: "/articles", unit_quota: 3 });
      const paid = await gate(req("/articles", { "User-Agent": "curl/8.5.0", "AIFP-Receipt": token }));
      expect(paid.ok, scriptClients).toBe(true);
      if (paid.ok) expect(paid.aifp.mode).toBe("paid");
    }
  });

  it("a merchant's own predicate decides alone", async () => {
    const free = await contentGate({ scriptClients: "charge", shouldCharge: () => false });
    expect((await free.gate(req("/articles", { "User-Agent": "curl/8.5.0" }))).ok).toBe(true);
    expect(free.events[0].detail).toBeUndefined();
    const api = await contentGate({ scriptClients: "allow", shouldCharge: undefined });
    expect((await api.gate(req("/articles", { "User-Agent": "curl/8.5.0" }))).ok, "no predicate charges everyone").toBe(
      false
    );
  });

  it("an unknown value throws at construction", async () => {
    for (const bad of [
      { scriptClients: "Charge" },
      { scriptClients: "off" },
      { scriptClientAllow: "curl" },
      { scriptClientAllow: [""] },
    ]) {
      await expect(contentGate(bad), JSON.stringify(bad)).rejects.toThrow(/scriptClient/);
    }
  });
});
