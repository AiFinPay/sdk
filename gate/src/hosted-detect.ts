// ──────────────────────────────────────────────────────────────────────────
// hostedDetect — a `shouldCharge` that asks AiFinPay who pays.
//
// The gate sends the facts of the visitor request (address, User-Agent and a
// fixed list of request headers) to POST /v1/merchants/:id/detect with the
// merchant secret and gets back whether it pays. The rules live on AiFinPay's
// side and change there, without a release of this package.
//
// It falls back to a local rule. A detect call that errors, answers anything
// but a valid 200 or takes longer than `timeoutMs` is decided by `fallback`
// (default `knownAiAgent`, which never charges a browser), and after
// `pauseAfterFailures` failures in a row the service is not asked for
// `pauseMs`. An answer is reused for the same address, User-Agent and
// forwarded headers for as long as the service says (`cache_ttl_s`), so most
// requests never wait for the network.
//
// What leaves the gate: the client address, the User-Agent, the method, the
// path without its query, and the headers in DETECT_HEADERS. Never a cookie,
// an Authorization header or a receipt.
// ──────────────────────────────────────────────────────────────────────────
import { knownAiAgent } from "./agents.js";
import { identityHeaders } from "./identity.js";
import type { GateRequest } from "./types.js";

/** The request headers a detect call carries; the service ignores any other. */
export const DETECT_HEADERS = [
  "accept",
  "accept-encoding",
  "accept-language",
  "sec-ch-ua",
  "sec-ch-ua-mobile",
  "sec-ch-ua-platform",
  "sec-fetch-dest",
  "sec-fetch-mode",
  "sec-fetch-site",
  "sec-fetch-user",
  "upgrade-insecure-requests",
  // Web Bot Auth (RFC 9421): an agent that signs its requests. Host is the
  // @authority the signature covers.
  "signature",
  "signature-agent",
  "signature-input",
  "host",
  "via",
  "from",
  // Signed by the merchant's Cloudflare Worker (examples/cloudflare-edge-signal);
  // only AiFinPay holds the key that verifies it.
  "aifp-edge-signal",
] as const;

export const DETECT_TIMEOUT_MS = 150;
export const DETECT_CACHE_MAX = 10_000;
const DETECT_PAUSE_AFTER_FAILURES = 5;
const DETECT_PAUSE_MS = 30_000;
const TTL_MAX_S = 86_400;
const UA_MAX = 1024;
const HEADER_MAX = 512;
const PATH_MAX = 2048;

export interface HostedDetectOptions {
  merchantId: string;
  /** Server-side merchant secret; never sent to a browser. */
  merchantSecret: string;
  /** HTTPS origin of the AiFinPay API. */
  apiBase?: string;
  /** After this long the request is decided by `fallback`. */
  timeoutMs?: number;
  /** Answers kept in memory, by address, User-Agent and forwarded headers. */
  cacheMax?: number;
  /** Decides when the service cannot; never cached. A throw serves free. Default `knownAiAgent`. */
  fallback?: (req: GateRequest) => boolean | Promise<boolean>;
  /** Failures in a row after which the service is not asked for `pauseMs`. */
  pauseAfterFailures?: number;
  pauseMs?: number;
  /** For tests; the global fetch otherwise. */
  fetch?: typeof fetch;
  /** Unix milliseconds; for tests. */
  now?: () => number;
}

interface Cached {
  charge: boolean;
  until: number;
}

// Predicates that read GateRequest.ip; the Express adapter warns about
// `trust proxy: true`, or unset behind a proxy, for them.
const ipReaders = new WeakSet<object>();

/** True for a `shouldCharge` that reads the client address. */
export function readsClientIp(rule: unknown): boolean {
  return typeof rule === "function" && ipReaders.has(rule);
}

function apiOrigin(apiBase: string | undefined): string {
  let base: URL;
  try {
    base = new URL(apiBase ?? "https://api.aifinpay.io");
  } catch {
    throw new Error("hostedDetect: apiBase must be an HTTPS origin");
  }
  if (
    /[\s\\?#]/.test(apiBase ?? "") ||
    base.protocol !== "https:" ||
    base.username ||
    base.password ||
    base.pathname !== "/"
  )
    throw new Error("hostedDetect: apiBase must be an HTTPS origin");
  return base.origin;
}

function bodyOf(req: GateRequest, ip: string, ua: string | undefined): string {
  const headers: Record<string, string> = {};
  for (const name of DETECT_HEADERS) {
    const value = req.header(name);
    if (typeof value === "string" && value.length <= HEADER_MAX) headers[name] = value;
  }
  const path = req.path.split(/[?#]/)[0];
  return JSON.stringify({
    v: 1,
    ip,
    ua: ua && ua.length <= UA_MAX ? ua : null,
    ...(typeof req.method === "string" && req.method ? { method: req.method.toUpperCase() } : {}),
    path: path.startsWith("/") && path.length <= PATH_MAX ? path : null,
    headers,
    aifp: { receipt: false, agent_id: false },
  });
}

// Their values change per request; only presence changes the answer.
const SIGNATURE_HEADERS = new Set(["signature", "signature-agent", "signature-input"]);

/** The forwarded headers as far as they can change the answer, hashed for the cache key. */
async function headersDigest(req: GateRequest): Promise<string> {
  let text = "";
  for (const name of DETECT_HEADERS) {
    let value = req.header(name);
    if (typeof value !== "string" || value.length > HEADER_MAX) continue;
    if (SIGNATURE_HEADERS.has(name)) value = "";
    else if (name === "aifp-edge-signal")
      value = value
        .split(";")
        .filter((field) => /^(vb|cat|score)=/.test(field))
        .join(";");
    text += `${name}:${JSON.stringify(value)}\n`;
  }
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

function ipv6Groups(ip: string): number[] | null {
  let text = ip.toLowerCase().replace(/%.*$/, "");
  const v4 = /^(.*:)(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (v4) {
    const octets = ipv4Octets(v4[2]);
    if (!octets) return null;
    text = `${v4[1]}${((octets[0] << 8) | octets[1]).toString(16)}:${((octets[2] << 8) | octets[3]).toString(16)}`;
  }
  const halves = text.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 2 ? missing < 1 : missing !== 0) return null;
  const groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  if (!groups.every((g) => /^[0-9a-f]{1,4}$/.test(g))) return null;
  return groups.map((g) => parseInt(g, 16));
}

function ipv4Octets(ip: string): number[] | null {
  const parts = ip.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255)) return null;
  return parts.map(Number);
}

/** False for a loopback, private, link-local, unspecified or unreadable address: never a visitor's. */
function visitorAddress(ip: string): boolean {
  let v4 = ipv4Octets(ip);
  if (!v4) {
    const g = ipv6Groups(ip);
    if (!g) return false;
    if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) v4 = [g[6] >> 8, g[6] & 255, g[7] >> 8, g[7] & 255];
    else return !(g.slice(0, 7).every((x) => x === 0) || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80);
  }
  const [a, b] = v4;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

/** A `shouldCharge` backed by the hosted detection service. Needs `req.ip`. */
export function hostedDetect(options: HostedDetectOptions): (req: GateRequest) => Promise<boolean> {
  if (!/^mrch_[a-f0-9]{16}$/.test(options.merchantId)) throw new Error("hostedDetect: valid merchantId is required");
  const secret = options.merchantSecret;
  if (typeof secret !== "string" || !secret || /[\u0000-\u001f\u007f]/.test(secret))
    throw new Error("hostedDetect: merchantSecret is required");
  const endpoint = `${apiOrigin(options.apiBase)}/v1/merchants/${options.merchantId}/detect`;
  const timeoutMs = options.timeoutMs ?? DETECT_TIMEOUT_MS;
  const cacheMax = options.cacheMax ?? DETECT_CACHE_MAX;
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const fallback = options.fallback ?? knownAiAgent;
  const pauseAfterFailures = options.pauseAfterFailures ?? DETECT_PAUSE_AFTER_FAILURES;
  const pauseMs = options.pauseMs ?? DETECT_PAUSE_MS;
  let failures = 0;
  let pausedUntil = 0;
  const userAgent = identityHeaders({ info: null, traffic: null })["User-Agent"];
  const cache = new Map<string, Cached>();

  function remember(key: string, charge: boolean, ttlS: unknown): void {
    if (!Number.isInteger(ttlS) || (ttlS as number) <= 0) return;
    if (cache.size >= cacheMax) cache.delete(cache.keys().next().value as string);
    cache.set(key, { charge, until: now() + Math.min(ttlS as number, TTL_MAX_S) * 1000 });
  }

  async function fallBack(req: GateRequest): Promise<boolean> {
    try {
      return (await fallback(req)) === true;
    } catch {
      return false;
    }
  }

  async function failed(req: GateRequest): Promise<boolean> {
    if (++failures >= pauseAfterFailures) pausedUntil = now() + pauseMs;
    return fallBack(req);
  }

  async function ask(req: GateRequest, ip: string, ua: string | undefined, key: string): Promise<boolean> {
    if (pausedUntil > now()) return fallBack(req);
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": userAgent, "AIFP-Merchant-Secret": secret },
        body: bodyOf(req, ip, ua),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return failed(req);
      const answer = (await response.json()) as { charge?: unknown; cache_ttl_s?: unknown };
      if (typeof answer?.charge !== "boolean") return failed(req);
      failures = 0;
      remember(key, answer.charge, answer.cache_ttl_s);
      return answer.charge;
    } catch {
      return failed(req);
    }
  }

  const rule = async (req: GateRequest): Promise<boolean> => {
    // A paying agent is charged without asking, so its receipt is always metered.
    if (req.header("AIFP-Receipt") || req.header("AIFP-Agent-Id")) return true;
    const ip = req.ip;
    if (!ip) return false;
    // Behind an undeclared proxy every visitor would share this address.
    if (!visitorAddress(ip)) return fallBack(req);
    const ua = req.header("user-agent");
    const key = `${ip}\n${ua ?? ""}\n${await headersDigest(req)}`;
    const hit = cache.get(key);
    if (hit) {
      if (hit.until > now()) return hit.charge;
      cache.delete(key);
    }
    return ask(req, ip, ua, key);
  };
  ipReaders.add(rule);
  return rule;
}
