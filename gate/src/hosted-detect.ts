// ──────────────────────────────────────────────────────────────────────────
// hostedDetect — a `shouldCharge` that asks AiFinPay who pays.
//
// The gate sends the facts of the visitor request (address, User-Agent and a
// fixed list of request headers) to POST /v1/merchants/:id/detect with the
// merchant secret and gets back whether it pays. The rules live on AiFinPay's
// side and change there, without a release of this package.
//
// It fails free. A detect call that errors, answers anything but a valid 200
// or takes longer than `timeoutMs` serves the request free: an outage on our
// side must never put a 402 in front of a merchant's readers. An answer is
// reused for the same address and User-Agent for as long as the service says
// (`cache_ttl_s`), so most requests never wait for the network.
//
// What leaves the gate: the client address, the User-Agent, the path without
// its query, and the headers in DETECT_HEADERS. Never a cookie, an
// Authorization header or a receipt.
// ──────────────────────────────────────────────────────────────────────────
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
  "signature-agent",
  "signature-input",
  "via",
  "from",
] as const;

export const DETECT_TIMEOUT_MS = 150;
export const DETECT_CACHE_MAX = 10_000;
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
  /** After this long the request is served free. */
  timeoutMs?: number;
  /** Answers kept in memory, by address and User-Agent. */
  cacheMax?: number;
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
// `trust proxy: true` for them.
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
    path: path.startsWith("/") && path.length <= PATH_MAX ? path : null,
    headers,
    aifp: { receipt: false, agent_id: false },
  });
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
  const userAgent = identityHeaders({ info: null, traffic: null })["User-Agent"];
  const cache = new Map<string, Cached>();

  function remember(key: string, charge: boolean, ttlS: unknown): void {
    if (!Number.isInteger(ttlS) || (ttlS as number) <= 0) return;
    if (cache.size >= cacheMax) cache.delete(cache.keys().next().value as string);
    cache.set(key, { charge, until: now() + Math.min(ttlS as number, TTL_MAX_S) * 1000 });
  }

  async function ask(req: GateRequest, ip: string, ua: string | undefined, key: string): Promise<boolean> {
    try {
      const response = await doFetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json", "User-Agent": userAgent, "AIFP-Merchant-Secret": secret },
        body: bodyOf(req, ip, ua),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (response.status !== 200) return false;
      const answer = (await response.json()) as { charge?: unknown; cache_ttl_s?: unknown };
      if (typeof answer?.charge !== "boolean") return false;
      remember(key, answer.charge, answer.cache_ttl_s);
      return answer.charge;
    } catch {
      return false;
    }
  }

  const rule = async (req: GateRequest): Promise<boolean> => {
    // A paying agent is charged without asking, so its receipt is always metered.
    if (req.header("AIFP-Receipt") || req.header("AIFP-Agent-Id")) return true;
    const ip = req.ip;
    if (!ip) return false;
    const ua = req.header("user-agent");
    const key = `${ip}\n${ua ?? ""}`;
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
