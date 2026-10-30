import type { AifpResource } from "./types.js";
import { inspectPath, spelledAsPath } from "./path.js";

/**
 * Path → registry record. Port of the matcher in backend/routes/gateway.js.
 *
 * `/api/lookup/*` matches `/api/lookup` and everything under it; anything else
 * is an exact compare. An exact pattern wins, then the longest wildcard, so a
 * specific `/api/search` beats a catch-all `/api/*` regardless of registration
 * order. On a tie the paid one wins.
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
  let bestRank = -1;
  for (const r of resources) {
    if (!r.route_pattern) continue;
    const pat = spelledAsPath(r.route_pattern, { caseSensitive });
    const wild = pat.endsWith("/*");
    const hit = wild ? asked === pat.slice(0, -2) || asked.startsWith(pat.slice(0, -1)) : asked === pat;
    if (!hit) continue;
    const rank = wild ? pat.length : Number.MAX_SAFE_INTEGER;
    if (rank > bestRank || (rank === bestRank && best?.paywall_enabled === false && r.paywall_enabled !== false)) {
      best = r;
      bestRank = rank;
    }
  }
  return best;
}
