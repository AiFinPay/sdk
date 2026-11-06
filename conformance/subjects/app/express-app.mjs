// The Express integration a merchant writes from gate/README.md: a root-mounted gate over a registry, Redis counters, the v1 reporter.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { originAnswer } from "../../lib/origin.mjs";
import { respClient } from "../../lib/redis.mjs";

const env = process.env;
const gateDir = env.GATE_DIR;
const require = createRequire(`${gateDir}/package.json`);
const express = require("express");
const G = await import(pathToFileURL(`${gateDir}/dist/index.js`));
const profile = JSON.parse(env.AIFP_PROFILE);

const merchant = new G.AifpMerchant({ merchantId: env.AIFP_MERCHANT_ID, secret: env.AIFP_MERCHANT_SECRET, baseUrl: env.AIFP_API, retries: 0, timeoutMs: 2000 });
const registry = new G.ResourceRegistry({ merchant, refreshMs: 3600000 });
const reporter = G.createGateReporter({ merchantId: env.AIFP_MERCHANT_ID, merchantSecret: env.AIFP_MERCHANT_SECRET, apiBase: env.AIFP_API });
await registry.start();

const redis = respClient(Number(env.REDIS_PORT));
const app = express();
app.get("/__conformance/flush", async (_req, res) => { await reporter.flush(); res.json({ ok: true }); });
app.use(G.aifpDiscovery({
  merchantId: env.AIFP_MERCHANT_ID, apiBase: env.AIFP_API,
  resources: profile.resources.filter((r) => r.paywall !== false).map((r) => ({ resource: r.pattern, tier: r.tier, scope: "prefix" })),
}));
app.use(G.aifpGate({
  merchantId: env.AIFP_MERCHANT_ID, registry, apiBase: env.AIFP_API, jwksUri: env.AIFP_JWKS_URI, mode: profile.mode,
  store: G.redisStore(redis, { keyPrefix: "conformance:" }),
  ...(profile.charge === "agents" ? { shouldCharge: G.knownAiAgent } : {}),
  onEvent: reporter.onEvent,
}));
app.use(express.raw({ type: () => true, limit: "2mb" }));
app.use((req, res) => {
  const answer = originAnswer({ marker: env.AIFP_MARKER, method: req.method, url: req.originalUrl, headers: req.headers, body: Buffer.isBuffer(req.body) ? req.body : undefined });
  res.status(answer.status);
  // A handler sets what it likes, its own Cache-Control included: that is the case the gate has to survive.
  for (const [k, v] of Object.entries(answer.headers)) res.set(k, v);
  res.end(answer.body);
});
app.listen(Number(env.PORT), "127.0.0.1");
