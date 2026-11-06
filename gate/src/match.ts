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
export function matchResource(
  resources: AifpResource[],
  path: string,
  { caseSensitive = false }: { caseSensitive?: boolean } = {}
): AifpResource | null {
  const asked = caseSensitive ? path : path.toLowerCase();
  let best: AifpResource | null = null;
  for (const r of resources) {
    if (!r.route_pattern) continue;
    const pat = caseSensitive ? r.route_pattern : r.route_pattern.toLowerCase();
    const hit = pat.endsWith("/*")
      ? asked === pat.slice(0, -2) || asked.startsWith(pat.slice(0, -1))
      : asked === pat || asked === pat.replace(/\/+$/, "");
    if (!hit) continue;
    if (!best || pat.length > best.route_pattern.length) best = r;
  }
  return best;
}
