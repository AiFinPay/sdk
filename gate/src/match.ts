import type { AifpResource } from "./types.js";
import { inspectPath, spelledAsPath } from "./path.js";

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
  const { path: asked } = inspectPath(path, { caseSensitive });
  let best: AifpResource | null = null;
  let bestLength = -1;
  for (const r of resources) {
    if (!r.route_pattern) continue;
    const pat = spelledAsPath(r.route_pattern, { caseSensitive });
    const hit = pat.endsWith("/*") ? asked === pat.slice(0, -2) || asked.startsWith(pat.slice(0, -1)) : asked === pat;
    if (!hit) continue;
    if (pat.length > bestLength) {
      best = r;
      bestLength = pat.length;
    }
  }
  return best;
}
