// ──────────────────────────────────────────────────────────────────────────
// AiFinPay shadow worker — the first step that does not touch the money path.
//
// Every request is passed to your origin unchanged and answered unchanged;
// the only visible difference is an `AIFP-Mode: shadow` response header (so
// the AiFinPay site check can tell "observing" from "no gate"). On the way,
// the request is classified from the same marker table `@aifinpay/gate`
// charges from, and a self-identifying AI crawler or agent becomes one gate
// event — kind "402", the challenge a gate in enforce would have sent — on
// `POST /v1/merchants/:id/gate-events`. Human readers are never reported.
//
// What leaves this worker: an event id, a timestamp, the registered pattern
// the path matched, and the normalised operator / ua_class / verified. Never
// the path itself, the User-Agent, the IP, headers, cookies or the response.
// What never happens here: a 402, a 403, a receipt check, a metered unit.
// ──────────────────────────────────────────────────────────────────────────
import { classifyAgent, matchResource } from "@aifinpay/gate/edge";

const MAX_BATCH = 50;
const FLUSH_AFTER_MS = 1000;
const TIMEOUT_MS = 3000;
const DEFAULT_API_BASE = "https://api.aifinpay.io";
const MERCHANT = /^mrch_[a-f0-9]{16}$/;

/** Registered patterns from the AIFP_RESOURCES var, in the registry's shape. */
function resourcesOf(env) {
  return String(env.AIFP_RESOURCES ?? "/*")
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((route_pattern) => ({ route_pattern }));
}

/**
 * Build the worker. Everything with a side effect is injectable so the
 * behaviour can be tested without a network: `fetch` serves both the origin
 * and the reporting call, `now` stamps events, `flushAfterMs` is how long a
 * batch waits for company before it is sent.
 */
export function createShadowWorker({ fetch: fetchImpl, now = Date.now, flushAfterMs = FLUSH_AFTER_MS } = {}) {
  const doFetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);
  let queue = [];
  let pendingFlush = null;
  let warned = false;

  const warnOnce = (message) => {
    if (warned) return;
    warned = true;
    console.warn(`aifinpay-shadow: ${message}`);
  };

  const send = async (env) => {
    const batch = queue.splice(0, MAX_BATCH);
    if (!batch.length) return;
    const base = String(env.AIFP_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
    const endpoint = `${base}/v1/merchants/${encodeURIComponent(env.AIFP_MERCHANT_ID)}/gate-events`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "AIFP-Merchant-Secret": env.AIFP_MERCHANT_SECRET },
        body: JSON.stringify({ events: batch }),
        signal: controller.signal,
        redirect: "manual",
      });
      // A worker has no durable queue: a refused or failed batch is dropped,
      // and only its status is logged — never the response body, never the
      // secret. A 4xx means the config is wrong (unregistered pattern, bad
      // secret); fix it and redeploy.
      if (!response.ok) warnOnce(`gate-events answered ${response.status}; events dropped`);
      await response.body?.cancel().catch(() => {});
    } catch {
      warnOnce("gate-events unreachable; events dropped");
    } finally {
      clearTimeout(timer);
    }
    if (queue.length) await send(env);
  };

  const schedule = (env, ctx) => {
    if (queue.length >= MAX_BATCH) {
      ctx.waitUntil(send(env));
      return;
    }
    if (pendingFlush) return;
    pendingFlush = new Promise((resolve) => setTimeout(resolve, flushAfterMs)).then(() => {
      pendingFlush = null;
      return send(env);
    });
    // waitUntil keeps the isolate alive until the batch is on the wire; the
    // response itself is already on its way to the client.
    ctx.waitUntil(pendingFlush);
  };

  return {
    async fetch(request, env, ctx) {
      const upstream = await doFetch(request);
      const response = new Response(upstream.body, upstream);
      response.headers.set("AIFP-Mode", "shadow");

      const url = new URL(request.url);
      const who = classifyAgent({ path: url.pathname, header: (name) => request.headers.get(name) ?? undefined });
      // A human reader's page view stays here, as it does in the gate's own
      // reporter. Everything that is not a plain browser is agent traffic the
      // dashboard should show — including "unknown" (no User-Agent, headless).
      if (who.ua_class === "human") return response;

      const matched = matchResource(resourcesOf(env), url.pathname);
      if (!matched) return response;
      if (!MERCHANT.test(String(env.AIFP_MERCHANT_ID ?? "")) || !env.AIFP_MERCHANT_SECRET) {
        warnOnce("AIFP_MERCHANT_ID / AIFP_MERCHANT_SECRET secrets are not set; nothing is reported");
        return response;
      }

      queue.push({
        id: crypto.randomUUID(),
        kind: "402",
        resource: matched.route_pattern,
        at: new Date(now()).toISOString(),
        operator: who.operator,
        ua_class: who.ua_class,
        verified: false,
      });
      schedule(env, ctx);
      return response;
    },
  };
}

export default createShadowWorker();
