// Runs with `node --test`. No network: fetch is injected and records what the
// worker sends. The origin is a stub that answers whatever the test asks.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createShadowWorker } from "../src/worker.mjs";

const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ENV = { AIFP_MERCHANT_ID: "mrch_0123456789abcdef", AIFP_MERCHANT_SECRET: "synthetic-secret", AIFP_RESOURCES: "/articles/*,/api/*" };

function harness({ origin = () => new Response("page", { status: 200 }), ingest = () => new Response("{}", { status: 200 }) } = {}) {
  const posts = [];
  const fetch = async (input, init) => {
    if (typeof input === "string") {
      posts.push({ url: input, init, body: JSON.parse(init.body) });
      return ingest(input, init);
    }
    return origin(input);
  };
  const waits = [];
  const ctx = { waitUntil: (p) => waits.push(p) };
  const worker = createShadowWorker({ fetch, now: () => 1_760_000_000_000, flushAfterMs: 0 });
  const call = async (path, headers = {}) => {
    const response = await worker.fetch(new Request(`https://www.example.com${path}`, { headers }), ENV, ctx);
    return response;
  };
  const settle = () => Promise.all(waits.splice(0));
  return { call, settle, posts };
}

test("the origin's answer goes through unchanged, plus AIFP-Mode: shadow", async () => {
  const { call, settle, posts } = harness({
    origin: () => new Response("maintenance", { status: 503, headers: { "X-Origin": "1", "Retry-After": "30" } }),
  });
  const r = await call("/articles/42", { "User-Agent": GPTBOT });
  assert.equal(r.status, 503);
  assert.equal(await r.text(), "maintenance");
  assert.equal(r.headers.get("X-Origin"), "1");
  assert.equal(r.headers.get("AIFP-Mode"), "shadow");
  await settle();
  assert.equal(posts.length, 1);
});

test("an AI crawler on a registered section is one gate event, kind 402, with its identity", async () => {
  const { call, settle, posts } = harness();
  await call("/articles/42?utm=x", { "User-Agent": GPTBOT });
  await settle();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "https://api.aifinpay.io/v1/merchants/mrch_0123456789abcdef/gate-events");
  assert.equal(posts[0].init.headers["AIFP-Merchant-Secret"], "synthetic-secret");
  assert.equal(posts[0].init.redirect, "manual");
  const [event] = posts[0].body.events;
  assert.match(event.id, /^[0-9a-f-]{36}$/);
  delete event.id;
  assert.deepEqual(event, {
    kind: "402",
    resource: "/articles/*",
    at: "2025-10-09T08:53:20.000Z",
    operator: "openai",
    ua_class: "ai_crawler",
    verified: false,
  });
});

test("the wire carries no path, no User-Agent and no secret", async () => {
  const { call, settle, posts } = harness();
  await call("/articles/42", { "User-Agent": GPTBOT, Cookie: "session=abc" });
  await settle();
  const wire = JSON.stringify(posts[0].body);
  for (const leak of ["/articles/42", "GPTBot", "gptbot", "session=abc", "synthetic-secret", "example.com"]) {
    assert.ok(!wire.includes(leak), `wire contains ${leak}`);
  }
});

test("a human reader is served and never reported", async () => {
  const { call, settle, posts } = harness();
  const r = await call("/articles/42", { "User-Agent": CHROME });
  assert.equal(r.status, 200);
  assert.equal(r.headers.get("AIFP-Mode"), "shadow");
  await settle();
  assert.equal(posts.length, 0);
});

test("a path outside every registered pattern is served and not reported", async () => {
  const { call, settle, posts } = harness();
  await call("/about", { "User-Agent": GPTBOT });
  await settle();
  assert.equal(posts.length, 0);
});

test("a request speaking AIFP is reported as aifinpay / aifp_agent, still unverified", async () => {
  const { call, settle, posts } = harness();
  await call("/api/search", { "User-Agent": CHROME, "AIFP-Agent-Id": "agt_1" });
  await settle();
  const [event] = posts[0].body.events;
  assert.deepEqual([event.resource, event.operator, event.ua_class, event.verified], ["/api/*", "aifinpay", "aifp_agent", false]);
});

test("batches hold at most 50 events", async () => {
  const { call, settle, posts } = harness();
  // Concurrent, as a burst of crawler hits is; the 50th fills a batch and it
  // goes out at once, the rest wait for the flush timer.
  await Promise.all(Array.from({ length: 60 }, (_, i) => call(`/articles/${i}`, { "User-Agent": GPTBOT })));
  await settle();
  assert.deepEqual(posts.map((p) => p.body.events.length), [50, 10]);
  const ids = new Set(posts.flatMap((p) => p.body.events.map((e) => e.id)));
  assert.equal(ids.size, 60);
});

test("without the secrets the request is still served and nothing is sent", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const { call, settle, posts } = harness();
    const env = { ...ENV, AIFP_MERCHANT_SECRET: "" };
    const worker = createShadowWorker({ fetch: async (input) => (typeof input === "string" ? (posts.push(input), new Response("{}")) : new Response("page")), flushAfterMs: 0 });
    const r = await worker.fetch(new Request("https://www.example.com/articles/1", { headers: { "User-Agent": GPTBOT } }), env, { waitUntil() {} });
    assert.equal(r.status, 200);
    await settle();
    assert.equal(posts.length, 0);
    assert.equal(warnings.length, 1);
    assert.ok(!warnings[0].includes("synthetic"));
    void call;
  } finally {
    console.warn = original;
  }
});

test("a refused or unreachable ingest is logged once by status and never throws into the request", async () => {
  const warnings = [];
  const original = console.warn;
  console.warn = (m) => warnings.push(m);
  try {
    const { call, settle, posts } = harness({ ingest: () => new Response('{"error":"secret leaked?"}', { status: 400 }) });
    await call("/articles/1", { "User-Agent": GPTBOT });
    await call("/articles/2", { "User-Agent": GPTBOT });
    await settle();
    assert.equal(posts.length, 1);
    assert.deepEqual(warnings, ["aifinpay-shadow: gate-events answered 400; events dropped"]);
    const down = harness({ ingest: () => { throw new TypeError("fetch failed"); } });
    const r = await down.call("/articles/1", { "User-Agent": GPTBOT });
    assert.equal(r.status, 200);
    await down.settle();
  } finally {
    console.warn = original;
  }
});

test("AIFP_API_BASE and a default AIFP_RESOURCES of /* are honoured", async () => {
  const posts = [];
  const worker = createShadowWorker({
    fetch: async (input, init) => (typeof input === "string" ? (posts.push({ url: input, body: JSON.parse(init.body) }), new Response("{}")) : new Response("page")),
    flushAfterMs: 0,
  });
  const waits = [];
  await worker.fetch(
    new Request("https://www.example.com/anything/at/all", { headers: { "User-Agent": GPTBOT } }),
    { AIFP_MERCHANT_ID: ENV.AIFP_MERCHANT_ID, AIFP_MERCHANT_SECRET: "s", AIFP_API_BASE: "https://api-staging.example/" },
    { waitUntil: (p) => waits.push(p) }
  );
  await Promise.all(waits);
  assert.equal(posts[0].url, "https://api-staging.example/v1/merchants/mrch_0123456789abcdef/gate-events");
  assert.equal(posts[0].body.events[0].resource, "/*");
});

const LINK =
  '</llms.txt>; rel="alternate"; type="text/markdown"; title="AI agents: access and payment", ' +
  '</.well-known/x402.json>; rel="describedby"; type="application/json"';

test("an HTML page gets the discovery Link, whoever asks; JSON and AIFP_DISCOVERY_LINK=off do not", async () => {
  const origin = (request) =>
    new URL(request.url).pathname === "/api/data"
      ? new Response("{}", { headers: { "Content-Type": "application/json" } })
      : new Response("<!doctype html>", { headers: { "Content-Type": "text/html; charset=utf-8" } });
  const fetch = async (input) => (typeof input === "string" ? new Response("{}") : origin(input));
  const worker = createShadowWorker({ fetch, flushAfterMs: 0 });
  const ctx = { waitUntil: () => {} };
  const get = (path, env = ENV, headers = {}) =>
    worker.fetch(new Request(`https://www.example.com${path}`, { headers }), env, ctx);

  for (const ua of [CHROME, GPTBOT, "python-requests/2.32"]) {
    const page = await get("/", ENV, { "User-Agent": ua });
    assert.equal(page.headers.get("Link"), LINK);
    assert.equal(await page.text(), "<!doctype html>");
  }
  assert.equal((await get("/api/data", ENV, { "User-Agent": CHROME })).headers.get("Link"), null);
  assert.equal((await get("/", { ...ENV, AIFP_DISCOVERY_LINK: "off" })).headers.get("Link"), null);
});

test("an origin's own Link is kept, and one already naming llms.txt is not repeated", async () => {
  let link = '</app.css>; rel="preload"; as="style"';
  const fetch = async (input) =>
    typeof input === "string" ? new Response("{}") : new Response("<p>", { headers: { "Content-Type": "text/html", Link: link } });
  const worker = createShadowWorker({ fetch, flushAfterMs: 0 });
  const get = () => worker.fetch(new Request("https://www.example.com/"), ENV, { waitUntil: () => {} });
  assert.equal((await get()).headers.get("Link"), `</app.css>; rel="preload"; as="style", ${LINK}`);
  link = LINK;
  assert.equal((await get()).headers.get("Link"), LINK);
});
