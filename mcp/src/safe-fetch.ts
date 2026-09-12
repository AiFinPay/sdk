// Where this MCP server is allowed to send a request.
//
// payable_fetch takes a URL from the caller and hands it to the agent, which
// requests it and, on a 402, pays and requests it again. Nothing checked the
// URL. A caller — or a prompt injection reaching this tool — could name
// http://127.0.0.1:4001, http://169.254.169.254/latest/meta-data/ or any host
// inside the network the process sits in, and read the reply. That is the tool
// that is exposed over HTTP today, so it is the one that matters most.
//
// The guard lives here rather than in the tool because a check on the first URL
// is not a check on the request: a public host that answers 302 to
// http://169.254.169.254 defeats it. This is installed as the agent's
// `fetchImpl`, so every request the agent makes passes through it, redirects
// are followed one at a time, and each hop is validated before it is taken.
//
// Not a firewall. A process that can be told to make requests should also be
// confined at the network layer; this stops the obvious reach, not a determined
// one with an SSRF-friendly public host to bounce off.

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

/** How many redirects to follow before giving up. */
const MAX_REDIRECTS = 5;

/**
 * Address ranges a request must never reach, as [first, last] 32-bit integers.
 *
 * Loopback and the private ranges are the obvious ones. 169.254.0.0/16 carries
 * the cloud metadata endpoint, which is the single most valuable thing an SSRF
 * can reach — credentials, usually. 100.64.0.0/10 is carrier-grade NAT, which
 * on some hosts is the internal network. 0.0.0.0/8 matters because 0.0.0.0
 * resolves to localhost on Linux.
 */
const BLOCKED_V4: [number, number][] = [
  [0x00000000, 0x00ffffff], // 0.0.0.0/8
  [0x0a000000, 0x0affffff], // 10.0.0.0/8
  [0x64400000, 0x647fffff], // 100.64.0.0/10 carrier NAT
  [0x7f000000, 0x7fffffff], // 127.0.0.0/8 loopback
  [0xa9fe0000, 0xa9feffff], // 169.254.0.0/16 link-local + metadata
  [0xac100000, 0xac1fffff], // 172.16.0.0/12
  [0xc0000000, 0xc00000ff], // 192.0.0.0/24
  [0xc0a80000, 0xc0a8ffff], // 192.168.0.0/16
  [0xc6120000, 0xc613ffff], // 198.18.0.0/15 benchmarking
  [0xe0000000, 0xefffffff], // 224.0.0.0/4 multicast
  [0xf0000000, 0xffffffff], // 240.0.0.0/4 reserved + broadcast
];

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

/** True when this address must not be contacted. */
export function isBlockedAddress(addr: string): boolean {
  const family = isIP(addr);
  if (family === 4) {
    const n = v4ToInt(addr);
    if (n === null) return true; // unparseable is not something to gamble on
    return BLOCKED_V4.some(([lo, hi]) => n >= lo && n <= hi);
  }
  if (family === 6) {
    const lower = addr.toLowerCase().replace(/^\[|\]$/g, "");
    // An IPv4-mapped address is an IPv4 address wearing a hat. Unwrap it, or
    // ::ffff:127.0.0.1 walks straight through an IPv6-only check.
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isBlockedAddress(mapped[1]);
    if (lower === "::1" || lower === "::") return true;
    if (/^f[cd][0-9a-f]{2}:/.test(lower)) return true; // fc00::/7 unique-local
    if (/^fe[89ab][0-9a-f]:/.test(lower)) return true; // fe80::/10 link-local
    return false;
  }
  return true; // not an address at all
}

export class BlockedRequestError extends Error {}

/**
 * Decide whether one URL may be requested.
 *
 * Resolution happens here, not at connect time, so a hostname that points at a
 * private address is refused by name. It leaves a DNS-rebinding window between
 * this lookup and the socket — closing that needs a custom agent that pins the
 * resolved address, which is worth doing and is not done here.
 */
export async function assertRequestAllowed(
  rawUrl: string,
  opts: { allowPrivate?: boolean; trustedHosts?: string[] } = {},
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new BlockedRequestError(`not a valid URL: ${rawUrl}`);
  }

  if (opts.allowPrivate) return url; // an operator asked for this explicitly

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new BlockedRequestError(
      `refusing ${url.protocol} — only http and https are requested by this server`,
    );
  }
  if (url.protocol === "http:") {
    // Plaintext to a public host leaks the request and invites a redirect into
    // the private range from anyone on the path.
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

  // An operator naming this exact host has vouched for it, so the resolution
  // step is skipped for it and only for it.
  //
  // Why this exists: behind an HTTP proxy the client does not resolve at all —
  // the proxy does — so lookup() fails with getaddrinfo EAI_AGAIN and every
  // host is refused as "cannot resolve". That is the guard misfiring on the
  // environment rather than on a threat, and it made the MCP server unusable in
  // proxied setups (external E2E, 2026-08-27).
  //
  // Deliberately per-host and not a proxy-detection switch. "We seem to be
  // behind a proxy, disable the SSRF check" turns one environment quirk into a
  // blanket bypass, which is the shape of the vulnerability this file exists to
  // prevent. Exact hostnames only — no suffix matching, because "example.com"
  // trusting "evil-example.com" is the classic way an allowlist stops meaning
  // anything.
  if (opts.trustedHosts?.some((h) => h.toLowerCase() === host.toLowerCase())) {
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await lookup(host, { all: true });
  } catch (e) {
    throw new BlockedRequestError(
      `cannot resolve ${host}: ${(e as Error).message}. `
      + `If this host is reachable only through a proxy, name it in `
      + `AIFINPAY_TRUSTED_HOSTS to skip the DNS pre-check for it alone.`,
    );
  }
  if (!addresses.length) {
    throw new BlockedRequestError(`${host} resolved to nothing`);
  }
  // Every answer must be public. One private address among several is enough
  // for a host to be steering us somewhere internal.
  for (const { address } of addresses) {
    if (isBlockedAddress(address)) {
      throw new BlockedRequestError(
        `refusing ${host}: it resolves to ${address}, which is not a public address`,
      );
    }
  }
  return url;
}

/**
 * A `fetch` that validates the target, and every redirect target, before going.
 *
 * Installed as the agent's fetchImpl so the whole payment flow inherits it —
 * the 402 probe, the retry with proof, and anything a bridge redirects to.
 */
export function makeSafeFetch(opts: { allowPrivate?: boolean; trustedHosts?: string[] } = {}): typeof fetch {
  const safeFetch = async (
    input: Parameters<typeof fetch>[0],
    init?: Parameters<typeof fetch>[1],
  ): Promise<Response> => {
    let target =
      typeof input === "string" ? input
      : input instanceof URL ? input.toString()
      : (input as Request).url;
    let request = init;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      await assertRequestAllowed(target, opts);
      const res = await globalThis.fetch(target, { ...request, redirect: "manual" });

      const location = res.status >= 300 && res.status < 400 ? res.headers.get("location") : null;
      if (!location) return res;

      target = new URL(location, target).toString();
      // 303, and 301/302 in practice, turn the follow-up into a GET with no
      // body. Mirroring that keeps behaviour the same as a normal fetch.
      if (res.status === 303 || res.status === 301 || res.status === 302) {
        request = { ...request, method: "GET", body: undefined };
      }
    }
    throw new BlockedRequestError(`too many redirects (more than ${MAX_REDIRECTS})`);
  };
  return safeFetch as typeof fetch;
}
