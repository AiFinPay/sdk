import type { AifpResource } from "./types.js";

/**
 * Path → registry record. Port of the matcher in backend/routes/gateway.js.
 *
 * `/api/lookup/*` matches `/api/lookup` and everything under it; anything else
 * is an exact compare. Longest route_pattern wins, so a specific `/api/search`
 * beats a catch-all `/api/*` regardless of registration order.
 *
 * No match returns null, and NULL MEANS PAYWALLED, never free. An unregistered
 * path is an unpriced path, and the safe reading of "the merchant never said
 * what this costs" is "charge the mount's default", not "give it away". The
 * server-side test suite enforces the same rule on our side.
 */
export function matchResource(resources: AifpResource[], path: string): AifpResource | null {
  let best: AifpResource | null = null;
  for (const r of resources) {
    const pat = r.route_pattern;
    if (!pat) continue;
    const hit = pat.endsWith("/*")
      ? path === pat.slice(0, -2) || path.startsWith(pat.slice(0, -1))
      : path === pat;
    if (!hit) continue;
    if (!best || pat.length > best.route_pattern.length) best = r;
  }
  return best;
}
