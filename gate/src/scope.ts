/**
 * Receipt scope — which paths one prepaid batch may be spent on.
 *
 * A line-for-line port of backend/aifp/scope.js `scopeCovers`. It has to be a
 * port and not an interpretation: if this gate is stricter than the hosted one,
 * an agent buys a wide receipt, is charged for it on-chain, and then gets a 403
 * from the merchant who installed our middleware — money taken, service not
 * rendered, and the merchant looks like the one who broke it.
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
  return path === resource; // 'exact', and anything unrecognised
}
