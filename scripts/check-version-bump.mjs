#!/usr/bin/env node
/**
 * Fail when a package's published contents changed but its version did not.
 *
 * This exists because it happened three times in one day, to three different
 * packages, and each time the symptom was the same and nearly invisible: the
 * fix was merged, the version was left alone, and the registry kept serving the
 * old build under the number people already had. You cannot tell from a version
 * string whether you have the fix, so nobody looked.
 *
 *   @aifinpay/mcp 1.2.0  — the fix stopping it printing the agent's private key
 *                          landed 2026-07-27; npm served the pre-fix build under
 *                          the same version until 2026-08-01.
 *   aifinpay CLI 1.0.0   — init/import/whoami were on main for weeks; the
 *                          release predated them and the version never moved.
 *   @aifinpay/agent      — a published patch was broken in the default config
 *                          and only a second bump made that distinguishable.
 *
 * The check compares against the merge base, so it is about *this* change, not
 * about how far the branch has drifted.
 *
 * Usage:  node scripts/check-version-bump.mjs [baseRef]
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const baseRef = process.argv[2] || process.env.BASE_REF || "origin/main";

/**
 * Each package: where it lives, how to read its version, and which paths end up
 * in what users install. Paths deliberately exclude tests and tooling — a change
 * there is real work but it does not reach anyone through the registry, and
 * demanding a bump for it would train people to bump without meaning it.
 */
const PACKAGES = [
  {
    name: "@aifinpay/agent",
    dir: "node",
    version: () => JSON.parse(readFileSync("node/package.json", "utf8")).version,
    versionAt: (ref) => JSON.parse(gitShow(ref, "node/package.json")).version,
    published: [/^node\/src\//, /^node\/package\.json$/, /^node\/README\.md$/],
  },
  {
    name: "@aifinpay/mcp",
    dir: "mcp",
    version: () => JSON.parse(readFileSync("mcp/package.json", "utf8")).version,
    versionAt: (ref) => JSON.parse(gitShow(ref, "mcp/package.json")).version,
    published: [/^mcp\/src\//, /^mcp\/bin\//, /^mcp\/package\.json$/, /^mcp\/README\.md$/],
  },
  {
    name: "aifinpay-agent (PyPI)",
    dir: "python",
    version: () => tomlVersion(readFileSync("python/pyproject.toml", "utf8")),
    versionAt: (ref) => tomlVersion(gitShow(ref, "python/pyproject.toml")),
    published: [/^python\/aifinpay\//, /^python\/pyproject\.toml$/, /^python\/README\.md$/],
  },
];

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}
function gitShow(ref, path) {
  return execFileSync("git", ["show", `${ref}:${path}`], { encoding: "utf8" });
}
function tomlVersion(src) {
  const m = src.match(/^\s*version\s*=\s*"([^"]+)"/m);
  if (!m) throw new Error("no version in pyproject.toml");
  return m[1];
}

let base;
try {
  base = git(["merge-base", "HEAD", baseRef]);
} catch {
  console.log(`[version-gate] cannot resolve ${baseRef} — skipping`);
  process.exit(0);
}

const changed = git(["diff", "--name-only", base, "HEAD"]).split("\n").filter(Boolean);
if (changed.length === 0) {
  console.log("[version-gate] no changes against the merge base");
  process.exit(0);
}

let failed = false;
for (const pkg of PACKAGES) {
  const hits = changed.filter((f) => pkg.published.some((re) => re.test(f)));
  if (hits.length === 0) continue;

  const now = pkg.version();
  let before;
  try {
    before = pkg.versionAt(base);
  } catch {
    console.log(`[version-gate] ${pkg.name}: new package, nothing to compare`);
    continue;
  }

  if (now === before) {
    failed = true;
    console.error(
      `\n::error::${pkg.name} — published files changed but the version is still ${now}.\n` +
        `  Anyone installing ${now} after this merges gets different code than someone who\n` +
        `  installed ${now} before it, and no way to tell which they have.\n` +
        `  Changed: ${hits.slice(0, 8).join(", ")}${hits.length > 8 ? ` (+${hits.length - 8} more)` : ""}\n` +
        `  Bump the version, or move the change out of the published paths.`,
    );
  } else {
    console.log(`[version-gate] ${pkg.name}: ${before} → ${now} — ok`);
  }
}

if (failed) {
  console.error(
    "\nIf a change genuinely does not reach users, it does not belong in a published path.\n",
  );
  process.exit(1);
}
console.log("[version-gate] passed");
