// Runs with `node --test`. No network: the origin is an injected fetch that
// records the request it receives; `request.cf` is set the way Cloudflare does.
import assert from "node:assert/strict";
import { test } from "node:test";
import { createEdgeSignalWorker, EDGE_SIGNAL_HEADER, signEdgeSignal } from "../src/worker.mjs";

const SECRET = "edgesec_" + "v".repeat(43);
const NOW = 1_760_000_000;

// Recorded from AiFinPay's verifier (aifinpay-web backend/app/bot-detect/edge-signal.js)
// for the same inputs: the Worker must produce these bytes exactly, or every
// signal it sends is rejected as forged.
const VECTORS = [
  [
    { verifiedBot: true, category: "AI Crawler", score: 3 },
    "v=1;ts=1760000000;vb=1;cat=AI%20Crawler;score=3;sig=tETlRO1zW_7cpX800-rd43_DjllSM9_ZRZD34cJsvfk",
  ],
  [
    { verifiedBot: false, category: null, score: null },
    "v=1;ts=1760000000;vb=0;cat=;score=;sig=lRSfuU5k51UtZKTdFK5P7TXzgnwvY9jDjdSvI4gkcks",
  ],
];

function harness(env) {
  const seen = [];
  const worker = createEdgeSignalWorker({ fetch: async (r) => (seen.push(r), new Response("page")), now: () => NOW });
  const call = (cf, headers = {}) => {
    const request = new Request("https://www.example.com/articles/1", { headers });
    Object.defineProperty(request, "cf", { value: cf });
    return worker.fetch(request, env);
  };
  return { call, seen };
}

test("signs exactly what AiFinPay verifies", async () => {
  for (const [facts, expected] of VECTORS) assert.equal(await signEdgeSignal({ secret: SECRET, ...facts, nowS: NOW }), expected);
});

test("reads Cloudflare's facts, the score only with AIFP_BOT_SCORE=on", async () => {
  const cf = { botManagement: { verifiedBot: true, score: 3 }, verifiedBotCategory: "AI Crawler" };
  const on = harness({ AIFP_EDGE_SECRET: SECRET, AIFP_BOT_SCORE: "on" });
  await on.call(cf);
  assert.equal(on.seen[0].headers.get(EDGE_SIGNAL_HEADER), VECTORS[0][1]);
  const off = harness({ AIFP_EDGE_SECRET: SECRET });
  await off.call(cf);
  assert.match(off.seen[0].headers.get(EDGE_SIGNAL_HEADER), /;score=;sig=/);
});

test("a client's own AIFP-Edge-Signal never reaches the origin", async () => {
  const { call, seen } = harness({ AIFP_EDGE_SECRET: SECRET });
  const forged = "v=1;ts=1;vb=1;cat=Search%20Engine%20Crawler;score=;sig=" + "A".repeat(43);
  await call({}, { [EDGE_SIGNAL_HEADER]: forged });
  assert.equal(seen[0].headers.get(EDGE_SIGNAL_HEADER), VECTORS[1][1]);
});

test("no secret: the header is removed, not forwarded", async () => {
  const { call, seen } = harness({});
  await call({}, { [EDGE_SIGNAL_HEADER]: "anything" });
  assert.equal(seen[0].headers.get(EDGE_SIGNAL_HEADER), null);
});
