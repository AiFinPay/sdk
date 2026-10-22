// Runs with `node --test`. No network: fetch is injected and records batches.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createShipper } from "../ship.mjs";

const GPTBOT = "Mozilla/5.0 AppleWebKit/537.36 (KHTML, like Gecko; compatible; GPTBot/1.2; +https://openai.com/gptbot)";
const CHROME = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";
const ENV = { AIFP_MERCHANT_ID: "mrch_0123456789abcdef", AIFP_MERCHANT_SECRET: "synthetic-secret", AIFP_RESOURCES: "/articles/*,/api/*" };
const line = (path, ua, extra = {}) => JSON.stringify({ at: "2026-10-22T12:00:00+00:00", path, ua, aifp: 0, ...extra });

function harness(ingest = () => new Response("{}", { status: 200 }), env = ENV) {
  const posts = [];
  const shipper = createShipper({
    env,
    fetch: async (url, init) => {
      posts.push({ url, init, body: JSON.parse(init.body) });
      return ingest();
    },
    flushAfterMs: 60_000,
  });
  return { shipper, posts };
}

test("refuses to start without a merchant id and secret, naming the variable", () => {
  assert.throws(() => createShipper({ env: { ...ENV, AIFP_MERCHANT_ID: "nope" } }), /AIFP_MERCHANT_ID/);
  assert.throws(() => createShipper({ env: { ...ENV, AIFP_MERCHANT_SECRET: "" } }), /AIFP_MERCHANT_SECRET/);
});

test("a crawler line on a registered section becomes one gate event with its identity", async () => {
  const { shipper, posts } = harness();
  assert.equal(shipper.ingest(line("/articles/42", GPTBOT)), true);
  const s = await shipper.flush();
  assert.equal(posts.length, 1);
  assert.equal(posts[0].url, "https://api.aifinpay.io/v1/merchants/mrch_0123456789abcdef/gate-events");
  assert.equal(posts[0].init.headers["AIFP-Merchant-Secret"], "synthetic-secret");
  const [event] = posts[0].body.events;
  assert.match(event.id, /^[0-9a-f-]{36}$/);
  delete event.id;
  assert.deepEqual(event, {
    kind: "402",
    resource: "/articles/*",
    at: "2026-10-22T12:00:00.000Z",
    operator: "openai",
    ua_class: "ai_crawler",
    verified: false,
  });
  assert.deepEqual([s.read, s.queued, s.delivered, s.dropped, s.pending], [1, 1, 1, 0, 0]);
});

test("humans, unmatched paths and garbage lines are skipped, never sent", async () => {
  const { shipper, posts } = harness();
  assert.equal(shipper.ingest(line("/articles/42", CHROME)), false);
  assert.equal(shipper.ingest(line("/about", GPTBOT)), false);
  assert.equal(shipper.ingest("not json"), false);
  assert.equal(shipper.ingest('{"ua":"x"}'), false);
  const s = await shipper.flush();
  assert.equal(posts.length, 0);
  assert.deepEqual([s.read, s.skipped, s.queued], [4, 4, 0]);
});

test("the aifp flag makes a browser-looking line an AIFP agent, still unverified", async () => {
  const { shipper, posts } = harness();
  shipper.ingest(line("/api/search", CHROME, { aifp: 1 }));
  await shipper.flush();
  const [event] = posts[0].body.events;
  assert.deepEqual([event.resource, event.operator, event.ua_class, event.verified], ["/api/*", "aifinpay", "aifp_agent", false]);
});

test("the wire carries no path, User-Agent, timestamp source or secret", async () => {
  const { shipper, posts } = harness();
  shipper.ingest(line("/articles/42", GPTBOT));
  await shipper.flush();
  const wire = JSON.stringify(posts[0].body);
  for (const leak of ["/articles/42", "GPTBot", "gptbot", "synthetic-secret", "+00:00"]) {
    assert.ok(!wire.includes(leak), `wire contains ${leak}`);
  }
});

test("a full batch goes out at once; the rest on flush, in batches of at most 50", async () => {
  const { shipper, posts } = harness();
  for (let i = 0; i < 120; i++) shipper.ingest(line(`/articles/${i}`, GPTBOT));
  await shipper.flush();
  assert.deepEqual(posts.map((p) => p.body.events.length), [50, 50, 20]);
  assert.equal(new Set(posts.flatMap((p) => p.body.events.map((e) => e.id))).size, 120);
});

test("a refused batch is dropped and counted, with the status and never the body", async () => {
  const errors = [];
  const original = console.error;
  console.error = (m) => errors.push(m);
  try {
    const { shipper, posts } = harness(() => new Response('{"detail":"resource must match"}', { status: 400 }));
    shipper.ingest(line("/articles/1", GPTBOT));
    const s = await shipper.flush();
    assert.equal(posts.length, 1);
    assert.deepEqual([s.delivered, s.dropped, s.lastStatus], [0, 1, 400]);
    assert.deepEqual(errors, ["aifinpay-shadow: gate-events answered 400; 1 events dropped"]);
    const down = harness(() => { throw new TypeError("fetch failed"); });
    down.shipper.ingest(line("/articles/1", GPTBOT));
    assert.equal((await down.shipper.flush()).dropped, 1);
  } finally {
    console.error = original;
  }
});

test("a line without a usable timestamp is stamped now; a custom API base is honoured", async () => {
  const posts = [];
  const shipper = createShipper({
    env: { ...ENV, AIFP_API_BASE: "https://api-staging.example/", AIFP_RESOURCES: "/*" },
    fetch: async (url, init) => (posts.push({ url, body: JSON.parse(init.body) }), new Response("{}")),
    now: () => 1_760_000_000_000,
    flushAfterMs: 60_000,
  });
  shipper.ingest(JSON.stringify({ path: "/x", ua: GPTBOT }));
  await shipper.flush();
  assert.equal(posts[0].url, "https://api-staging.example/v1/merchants/mrch_0123456789abcdef/gate-events");
  assert.equal(posts[0].body.events[0].at, "2025-10-09T08:53:20.000Z");
  assert.equal(posts[0].body.events[0].resource, "/*");
});
