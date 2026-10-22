#!/usr/bin/env node
// ──────────────────────────────────────────────────────────────────────────
// AiFinPay shadow shipper for nginx — gate events from an access log.
//
//   tail -n0 -F /var/log/nginx/aifp-shadow.log | AIFP_MERCHANT_ID=mrch_… \
//     AIFP_MERCHANT_SECRET=… AIFP_RESOURCES="/articles/*,/api/*" node ship.mjs
//
// Each line of the `aifp_shadow` log (see aifp-shadow.conf) is classified
// with the same marker table `@aifinpay/gate` charges from. A self-
// identifying AI crawler or agent on a registered pattern becomes one gate
// event — kind "402", the challenge a gate in enforce would have sent — on
// `POST /v1/merchants/:id/gate-events`. Human readers are never reported.
// Nothing here changes a response: nginx already answered.
//
// What leaves this process: an event id, a timestamp, the registered pattern
// the path matched, operator / ua_class / verified. Never the path itself,
// the User-Agent, the IP or anything else from the log line.
// ──────────────────────────────────────────────────────────────────────────
import { createInterface } from "node:readline";
import { classifyAgent, matchResource } from "@aifinpay/gate/edge";

const MAX_BATCH = 50;
const MAX_QUEUE = 1000;
const FLUSH_AFTER_MS = 1000;
const TIMEOUT_MS = 3000;
const DEFAULT_API_BASE = "https://api.aifinpay.io";
const MERCHANT = /^mrch_[a-f0-9]{16}$/;

/**
 * Build a shipper. `fetch`, `now` and `flushAfterMs` are injectable so the
 * behaviour is testable without a network or a clock.
 */
export function createShipper({ env = process.env, fetch: fetchImpl, now = Date.now, flushAfterMs = FLUSH_AFTER_MS } = {}) {
  if (!MERCHANT.test(String(env.AIFP_MERCHANT_ID ?? ""))) throw new Error("AIFP_MERCHANT_ID must be a merchant id (mrch_…)");
  if (!env.AIFP_MERCHANT_SECRET) throw new Error("AIFP_MERCHANT_SECRET is required");
  const doFetch = (...args) => (fetchImpl ?? globalThis.fetch)(...args);
  const base = String(env.AIFP_API_BASE ?? DEFAULT_API_BASE).replace(/\/+$/, "");
  const endpoint = `${base}/v1/merchants/${encodeURIComponent(env.AIFP_MERCHANT_ID)}/gate-events`;
  const secret = env.AIFP_MERCHANT_SECRET;
  const resources = String(env.AIFP_RESOURCES ?? "/*")
    .split(",")
    .map((pattern) => pattern.trim())
    .filter(Boolean)
    .map((route_pattern) => ({ route_pattern }));

  let queue = [];
  let timer = null;
  let sending = null;
  const stats = { read: 0, skipped: 0, queued: 0, delivered: 0, dropped: 0, lastStatus: null };

  const send = async () => {
    if (sending) return sending;
    sending = (async () => {
      while (queue.length) {
        const batch = queue.splice(0, MAX_BATCH);
        const controller = new AbortController();
        const deadline = setTimeout(() => controller.abort(), TIMEOUT_MS);
        try {
          const response = await doFetch(endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json", "AIFP-Merchant-Secret": secret },
            body: JSON.stringify({ events: batch }),
            signal: controller.signal,
            redirect: "manual",
          });
          stats.lastStatus = response.status;
          await response.body?.cancel().catch(() => {});
          if (response.ok) {
            stats.delivered += batch.length;
          } else {
            // A 4xx is a configuration problem (unregistered pattern, wrong
            // secret) and will repeat; a 5xx may not. Neither is retried: this
            // is a report, and the log line is still on disk for a re-run.
            stats.dropped += batch.length;
            console.error(`aifinpay-shadow: gate-events answered ${response.status}; ${batch.length} events dropped`);
          }
        } catch {
          stats.lastStatus = null;
          stats.dropped += batch.length;
          console.error(`aifinpay-shadow: gate-events unreachable; ${batch.length} events dropped`);
        } finally {
          clearTimeout(deadline);
        }
      }
    })().finally(() => {
      sending = null;
    });
    return sending;
  };

  const schedule = () => {
    if (queue.length >= MAX_BATCH) {
      void send();
      return;
    }
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      void send();
    }, flushAfterMs);
    timer.unref?.();
  };

  return {
    /** One log line in; a queued event or nothing out. Never throws on bad input. */
    ingest(line) {
      stats.read++;
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        stats.skipped++;
        return false;
      }
      if (!entry || typeof entry.path !== "string") {
        stats.skipped++;
        return false;
      }
      const headers = {
        "user-agent": typeof entry.ua === "string" ? entry.ua : "",
        // The log keeps a 0/1 flag, not the receipt; presence is all the
        // classifier needs to call it an AIFP agent.
        "aifp-agent-id": entry.aifp === 1 || entry.aifp === "1" ? "1" : undefined,
      };
      const who = classifyAgent({ path: entry.path, header: (name) => headers[name.toLowerCase()] });
      if (who.ua_class === "human") {
        stats.skipped++;
        return false;
      }
      const matched = matchResource(resources, entry.path);
      if (!matched) {
        stats.skipped++;
        return false;
      }
      if (queue.length >= MAX_QUEUE) {
        stats.dropped++;
        return false;
      }
      const at = Date.parse(entry.at);
      queue.push({
        id: crypto.randomUUID(),
        kind: "402",
        resource: matched.route_pattern,
        at: new Date(Number.isFinite(at) ? at : now()).toISOString(),
        operator: who.operator,
        ua_class: who.ua_class,
        verified: false,
      });
      stats.queued++;
      schedule();
      return true;
    },
    /** Send everything queued now. */
    async flush() {
      if (timer) clearTimeout(timer);
      timer = null;
      await send();
      return { ...stats, pending: queue.length };
    },
    get stats() {
      return { ...stats, pending: queue.length };
    },
  };
}

// CLI: lines on stdin, events out, a flush on SIGTERM / end of input.
if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const shipper = createShipper();
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
  lines.on("line", (line) => shipper.ingest(line));
  const finish = async () => {
    const s = await shipper.flush();
    console.error(`aifinpay-shadow: read ${s.read}, queued ${s.queued}, delivered ${s.delivered}, dropped ${s.dropped}`);
    process.exit(0);
  };
  lines.on("close", finish);
  process.on("SIGTERM", finish);
  process.on("SIGINT", finish);
}
