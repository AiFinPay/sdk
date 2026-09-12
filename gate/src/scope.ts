/**
 * Receipt scope — which paths one prepaid batch may be spent on.
 *
 * A line-for-line port of backend/aifp/scope.js `scopeCovers`. It has to be a
 * port and not an interpretation: if this gate is stricter than the hosted one,
 * an agent buys a wide receipt, is charged for it on-chain, and then gets a 403
 * from the merchant who installed our middleware — money taken, service not
 * rendered, and the merchant looks like the one who broke it.
 *
 * That is not hypothetical. This file was written 2026-08-20 and the hosted
 * implementation was fixed 2026-08-27 (aifinpay-web 1173b93) without the port
 * following, so for eleven days a receipt bought for "/movies/*" opened
 * /movies/inception on the hosted gateway and was refused by this one. A
 * partner with five wildcard page resources had three of them unbuyable, and
 * the header above described the failure the file then had.
 *
 * The lesson is in the word "port": a copy nobody re-checks is a second
 * implementation. The case table in scope.test.ts is the thing that keeps the
 * two honest — it is written from the hosted behaviour, not from this code.
 *
 *   exact     one path, the default, and what an unrecognised scope degrades to
 *   prefix    a path and everything beneath it
 *   merchant  every path on this merchant
 *
 * Widening does not make calls cheaper: the gate charges the weight it finds in
 * the merchant's own registry for the path actually hit, so a premium route
 * still takes 10 units out of a batch that a standard route takes 1 from.
 * Scope decides WHERE units may be spent, never how many a call costs.
 */
export function scopeCovers(scope: string | undefined, resource: string, path: string): boolean {
  if (scope === "merchant") return true;
  if (scope === "prefix") {
    if (resource === "/") return true; // whole site, spelled as a prefix
    if (path === resource) return true; // the prefix path itself
    // The trailing slash is the entire point: without it, /articles covers
    // /articles-internal, and a merchant's private routes get served on a
    // receipt bought for their blog.
    const boundary = resource.endsWith("/") ? resource : resource + "/";
    return path.startsWith(boundary);
  }
  return patternCovers(resource, path); // 'exact', and anything unrecognised
}

/**
 * Does a resource pattern cover a concrete path?
 *
 * A merchant registers "/movies/*" as ONE resource, and the quote's resource is
 * that pattern rather than the URL the agent hit. Comparing them literally means
 * a receipt bought for the pattern matches nothing, and every URL beneath it
 * needs its own batch — which at the $0.10 minimum turns a 670k-page catalogue
 * into $67,000. The wildcard is kept in the receipt on purpose; this is what
 * makes it mean something.
 *
 * "/movies/*" covers "/movies" itself as well as everything under "/movies/",
 * because a merchant who registers the wildcard means the section, not only its
 * children.
 */
export function patternCovers(pattern: string, path: string): boolean {
  const pat = String(pattern || "");
  if (!pat.endsWith("/*")) return path === pat;
  return path === pat.slice(0, -2) || path.startsWith(pat.slice(0, -1));
}
