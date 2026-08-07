// Network and redirect guard for all MCP-originated agent requests.
//
// Security invariants:
// - only public HTTPS targets are reachable unless the operator explicitly
//   enables private fetches for local development;
// - every redirect hop is re-resolved and re-validated;
// - credentials and payment proofs never cross an origin boundary.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const MAX_REDIRECTS = 5;

const BLOCKED_V4: [number, number][] = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 incl cloud metadata
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15
  [0xe0000000, 0xefffffff], // multicast
  [0xf0000000, 0xffffffff], // reserved/broadcast
];

// Headers below can authenticate the wallet/user or redeem a payment proof.
// A redirect to another origin must never receive them. Header names are
// case-insensitive; Headers normalizes them for deletion.
const CROSS_ORIGIN_SENSITIVE_HEADERS = [
  "authorization",
  "proxy-authorization",
  "cookie",
  "cookie2",
  "x-payment",
  "payment-signature",
  "x-payment-signature",
  "x-agent-pubkey",
  "x-nonce",
  "x-signature",
  "x-tx-hash",
  "x-order-id",
  "x-payment-id",
] as const;

function v4ToInt(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const b = Number(p);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = (n << 8) | b;
  }
  return n >>> 0;
}

export function isBlockedAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) {
    const n = v4ToInt(addr);
    if (n === null) return true;
    return BLOCKED_V4.some(([lo, hi]) => n >= lo && n <= hi);
  }
  if (family === 6) {
    const lower = addr.toLowerCase().replace(/^\[|\]$/g, "");
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (lower === "::1" || lower === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10
    return false;
  }
  return true;
}

export class BlockedRequestError extends Error {}

export async function assertRequestAllowed(
  rawUrl: string,
  opts: { allowPrivate?: boolean } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedRequestError(`not a valid URL: ${rawUrl}`);
  }

  if (opts.allowPrivate) return url;

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedRequestError(
      `refusing ${url.protocol} — only http and https are requested by this server`,
    );
  }
  if (url.protocol === "http:") {
    throw new BlockedRequestError(
      `refusing http://${url.host} — payable requests must be https`,
    );
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new BlockedRequestError(`refusing ${host}: not a public address`);
    }
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (e) {
    throw new BlockedRequestError(`cannot resolve ${host}: ${(e as Error).message}`);
  }
  if (!addresses.length) throw new BlockedRequestError(`${host} resolved to nothing`);
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new BlockedRequestError(
        `refusing ${host}: it resolves to ${address}, which is not a public address`,
      );
    }
  }
  return url;
}

function stripSensitiveRedirectHeaders(headersInit: HeadersInit | undefined): Headers {
  const headers = new Headers(headersInit);
  for (const name of CROSS_ORIGIN_SENSITIVE_HEADERS) headers.delete(name);
  return headers;
}

/**
 * A fetch implementation that validates every hop and follows redirects
 * manually. Manual following is required because the platform fetch API may
 * otherwise carry custom payment/auth headers to a different origin.
 */
export function makeSafeFetch(opts: { allowPrivate?: boolean } = {}): typeof fetch {
  const safeFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    let target =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : (input as Request).url;

    // Preserve Request headers when the caller supplied a Request object.
    const inputRequest = typeof input === "string" || input instanceof URL
      ? undefined
      : (input as Request);
    let request: RequestInit = {
      ...(inputRequest ? {
        method: inputRequest.method,
        headers: inputRequest.headers,
      } : {}),
      ...(init ?? {}),
    };

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const current = await assertRequestAllowed(target, opts);
      const res = await globalThis.fetch(current.toString(), {
        ...request,
        redirect: "manual",
      });

      const location =
        res.status >= 300 && res.status < 400
          ? res.headers.get("location")
          : null;
      if (!location) return res;

      const next = new URL(location, current);
      // Validate before mutating request state or issuing the next request.
      await assertRequestAllowed(next.toString(), opts);

      if (next.origin !== current.origin) {
        request = {
          ...request,
          headers: stripSensitiveRedirectHeaders(request.headers),
        };
      }

      if (res.status === 303 || res.status === 301 || res.status === 302) {
        const headers = new Headers(request.headers);
        headers.delete("content-length");
        headers.delete("content-type");
        headers.delete("content-encoding");
        request = { ...request, method: "GET", body: undefined, headers };
      }

      target = next.toString();
    }
    throw new BlockedRequestError(`too many redirects (more than ${MAX_REDIRECTS})`);
  };
  return safeFetch as typeof fetch;
}
