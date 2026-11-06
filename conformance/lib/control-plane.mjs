import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer as createHttp } from "node:http";
import { createServer as createHttps } from "node:https";
import { join } from "node:path";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const RESOURCE = /^\/(?!\/)[A-Za-z0-9_./:*{}-]{0,511}$/;
const KEY_SETS = ["at,id,kind,resource", "at,id,kind,operator,resource,ua_class,verified", "at,exempt,id,kind,operator,resource,ua_class,verified"];

/** The ingest's own rules (backend/infrastructure/gate-events.js). Null when the event would be accepted. */
export function eventViolation(event, { patterns, operators, uaClasses, now }) {
  const keys = event && !Array.isArray(event) ? Object.keys(event).sort().join(",") : "";
  if (!KEY_SETS.includes(keys)) return `key set: ${keys}`;
  if (typeof event.id !== "string" || !UUID.test(event.id)) return `id: ${event.id}`;
  if (!["402", "serve"].includes(event.kind)) return `kind: ${event.kind}`;
  if (typeof event.resource !== "string" || !RESOURCE.test(event.resource)) return `resource: ${event.resource}`;
  if (!patterns.has(event.resource)) return `unregistered resource: ${event.resource}`;
  if (typeof event.at !== "string" || !UTC.test(event.at)) return `at: ${event.at}`;
  const at = Date.parse(event.at);
  if (at < now - 86400000 || at > now + 300000) return `at out of window: ${event.at}`;
  if (keys !== KEY_SETS[0] && (!operators.includes(event.operator) || !uaClasses.includes(event.ua_class) || typeof event.verified !== "boolean")) return "identity";
  if (keys === KEY_SETS[2] && (event.exempt !== true || event.kind !== "serve")) return "exempt";
  return null;
}

function selfSignedCert(dir) {
  const key = join(dir, "cp-key.pem");
  const cert = join(dir, "cp-cert.pem");
  execFileSync("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-days", "2", "-subj", "/CN=127.0.0.1", "-addext", "subjectAltName=IP:127.0.0.1,DNS:localhost"], { stdio: "ignore" });
  return { key: readFileSync(key), cert: readFileSync(cert), certFile: cert };
}

/** Stands in for api.aifinpay.io: JWKS, the public merchant record, the resource registry and the gate-events ingest. */
export async function startControlPlane({ fixtures, operators, uaClasses, jwk, dir }) {
  const state = {
    faults: { jwks: false, record: false, ingest: 0 },
    profile: null,
    siteUrl: "http://127.0.0.1/",
    events: [],
    violations: [],
    requests: 0,
  };
  const merchant = fixtures.merchant_id;
  const record = () => ({
    merchant_id: merchant,
    name: "Conformance site",
    // As the real API: the field is stored only for a test site.
    ...(state.profile?.network_mode === "test" ? { network_mode: "test" } : {}),
    site_url: state.siteUrl,
    site_verified: state.profile?.site_verified ?? true,
    ...(state.profile?.operator_rules ? { operator_rules: state.profile.operator_rules, operator_default: state.profile.operator_default } : {}),
  });
  const registered = () => (state.profile?.resources ?? []).map((r, i) => ({
    id: `res_${String(i).padStart(12, "0")}`, route_pattern: r.pattern, type: "page", paywall_enabled: r.paywall !== false, tier: r.tier, unit_weight: null, name: null, created_at: "2026-11-06T00:00:00.000Z",
  }));
  const handler = async (req, res) => {
    state.requests++;
    const json = (status, body) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(body)); };
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const url = req.url.split("?")[0];
    const authed = req.headers["aifp-merchant-secret"] === fixtures.merchant_secret;
    if (url === "/.well-known/jwks.json") return state.faults.jwks ? json(503, {}) : json(200, { keys: [jwk] });
    if (url === `/v1/merchants/${merchant}` && req.method === "GET") return state.faults.record ? json(503, {}) : json(200, record());
    if (url === `/v1/merchants/${merchant}/resources` && req.method === "GET") {
      if (state.faults.record) return json(503, {});
      return authed ? json(200, { resources: registered() }) : json(403, {});
    }
    if (url === `/v1/merchants/${merchant}/resources` && req.method === "POST") {
      if (!authed) return json(403, {});
      const body = JSON.parse(raw || "{}");
      return json(201, { resource: body, durable: true });
    }
    if (url === `/v1/merchants/${merchant}/gate-events` && req.method === "POST") {
      if (state.faults.ingest) return json(state.faults.ingest, {});
      if (!authed) return json(403, {});
      let body;
      try { body = JSON.parse(raw); } catch { state.violations.push("not JSON"); return json(400, {}); }
      if (!body || Object.keys(body).length !== 1 || !Array.isArray(body.events) || body.events.length < 1 || body.events.length > 50) {
        state.violations.push("batch shape");
        return json(400, {});
      }
      const patterns = new Set(registered().map((r) => r.route_pattern));
      for (const event of body.events) {
        const violation = eventViolation(event, { patterns, operators, uaClasses, now: Date.now() });
        if (violation) {
          state.violations.push(violation);
          return json(400, { error: "AIFP-400", detail: violation });
        }
      }
      const fresh = body.events.filter((e) => !state.events.some((seen) => seen.id === e.id));
      state.events.push(...fresh);
      return json(200, { accepted: fresh.length, duplicates: body.events.length - fresh.length });
    }
    return json(404, { error: "not_found" });
  };
  const tls = selfSignedCert(dir);
  const http = createHttp(handler);
  const https = createHttps({ key: tls.key, cert: tls.cert }, handler);
  await new Promise((r) => http.listen(0, "127.0.0.1", r));
  await new Promise((r) => https.listen(0, "127.0.0.1", r));
  return {
    state,
    url: `http://127.0.0.1:${http.address().port}`,
    httpsUrl: `https://127.0.0.1:${https.address().port}`,
    caFile: tls.certFile,
    registered,
    record,
    close: async () => {
      http.closeAllConnections();
      https.closeAllConnections();
      await new Promise((r) => http.close(r));
      await new Promise((r) => https.close(r));
    },
  };
}
