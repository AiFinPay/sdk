// Source-only CI. Never replaces registry release evidence or the repository lock.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const BASE = "e4c0c67e8b8887e91f4293831df768cf61bcd851";
export const SKILL_COMMIT = "4e54749bde52923bfa54936b607025ce30fc16f9";
export const SKILL_SHA =
  "0e5f740cce213a2a9bbc968744d4ab979a49fc7af35ca10747277cd50ba19692";
const BASE_HASHES = {
  "package.json":
    "2e0dd893b538b5161c2413280e2d05972409cc4b725e0c7bdd58981ae6af9b96",
  "package-lock.json":
    "85bb56935143876bac44706c92063becdfa06aeba59d2a1111ebd567292282cd",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
export function verifySkill(bytes) {
  assert.equal(
    hash(bytes),
    SKILL_SHA,
    "canonical skill bytes differ from reviewed pinned producer",
  );
  assert.match(bytes.toString(), /version:\s*2\.8\.0/);
}
export function verifyInstalled(directory, expected) {
  assert.equal(
    json(join(directory, "package.json")).version,
    expected.version,
    "wrong installed cohort version",
  );
  for (const [path, sha] of Object.entries(expected.files)) {
    assert.equal(
      hash(readFileSync(join(directory, path))),
      sha,
      `installed package differs: ${path}`,
    );
  }
}
export function verifyPinnedProducer(directory, expected, commit) {
  assert.match(
    commit,
    /^[0-9a-f]{40}$/,
    "producer commit must be a full immutable hash",
  );
  for (const [path, sha] of Object.entries(expected.files)) {
    let bytes;
    try {
      bytes = execFileSync("git", ["show", `${commit}:${path}`], {
        cwd: directory,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      throw new Error(`unreviewed packed producer path: ${path}`);
    }
    assert.equal(
      hash(bytes),
      sha,
      `packed producer bytes differ from pinned commit: ${path}`,
    );
  }
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    env: process.env,
  });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, `${command} ${args.join(" ")} failed`);
}
function git(args, cwd = root) {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}
function pack(cwd, target, version) {
  const output = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", target],
    { cwd, encoding: "utf8" },
  );
  const [info] = JSON.parse(output);
  assert.equal(info.version, version);
  const files = Object.fromEntries(
    info.files.map(({ path }) => [path, hash(readFileSync(join(cwd, path)))]),
  );
  return {
    version,
    tarball: join(target, info.filename),
    sha256: hash(readFileSync(join(target, info.filename))),
    integrity: info.integrity,
    files,
  };
}
function overlayGraph(from, into) {
  // Same-runner, genuine npm graph. Replace complete package directories, not
  // partial source files. Merge bins so baseline dev tools remain available.
  for (const entry of readdirSync(from, { withFileTypes: true })) {
    if (entry.name === ".package-lock.json") continue; // actual cohort lock retained separately
    const source = join(from, entry.name),
      dest = join(into, entry.name);
    if (entry.name === ".bin") {
      mkdirSync(dest, { recursive: true });
      for (const name of readdirSync(source)) {
        rmSync(join(dest, name), { force: true });
        cpSync(join(source, name), join(dest, name), {
          verbatimSymlinks: true,
        });
      }
    } else if (entry.name.startsWith("@")) {
      mkdirSync(dest, { recursive: true });
      for (const name of readdirSync(source)) {
        rmSync(join(dest, name), { recursive: true, force: true });
        cpSync(join(source, name), join(dest, name), {
          recursive: true,
          verbatimSymlinks: true,
        });
      }
    } else {
      rmSync(dest, { recursive: true, force: true });
      cpSync(source, dest, { recursive: true, verbatimSymlinks: true });
    }
  }
}
export async function checkSourceCohort(skillSource) {
  const skillRoot = realpathSync(skillSource);
  assert.equal(
    git(["rev-parse", "HEAD"], skillRoot),
    SKILL_COMMIT,
    "skill producer must be fully pinned",
  );
  assert.equal(
    git(["status", "--porcelain", "--untracked-files=no"], skillRoot),
    "",
    "skill producer has tracked changes",
  );
  verifySkill(readFileSync(join(skillRoot, "agent/skills/aifinpay/SKILL.md")));
  assert.equal(json(join(root, "mcp/package.json")).version, "2.7.0");
  const repoBytes = Object.fromEntries(
    ["package.json", "package-lock.json"].map((p) => [
      p,
      readFileSync(join(root, "mcp", p)),
    ]),
  );
  const work = mkdtempSync(join(tmpdir(), "aifp-mcp-source-ci-"));
  const mcp = join(work, "mcp"),
    runtime = join(work, "runtime"),
    packs = join(work, "packs");
  mkdirSync(mcp);
  mkdirSync(runtime);
  mkdirSync(packs);
  for (const name of Object.keys(BASE_HASHES)) {
    const bytes = execFileSync("git", ["show", `${BASE}:mcp/${name}`], {
      cwd: root,
    });
    assert.equal(
      hash(bytes),
      BASE_HASHES[name],
      "fixed baseline manifest/lock drift",
    );
    writeFileSync(join(mcp, name), bytes);
  }
  run("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund"], mcp);
  run("npm", ["audit", "--omit=dev", "--audit-level=high"], mcp);
  const bootstrapNodeTypes = json(join(mcp, "package-lock.json")).packages[
    "node_modules/@types/node"
  ].version;
  run("npm", ["test"], skillRoot);
  const agentPack = pack(join(root, "node"), packs, "2.5.0");
  const skillPack = pack(skillRoot, packs, "2.8.0");
  verifyPinnedProducer(skillRoot, skillPack, SKILL_COMMIT);
  writeFileSync(
    join(runtime, "package.json"),
    JSON.stringify(
      {
        name: "aifp-private-source-ci-runtime",
        version: "0.0.0",
        private: true,
        dependencies: {
          "@aifinpay/agent": `file:${agentPack.tarball}`,
          "@aifinpay/skill": `file:${skillPack.tarball}`,
        },
        overrides: { jayson: { uuid: "^11.1.1" } },
        // Prevent runtime transitive Node12 typings replacing locked MCP Node22
        // declarations. npm places legacy typings in their genuine nested graph.
        devDependencies: { "@types/node": bootstrapNodeTypes },
      },
      null,
      2,
    ),
  );
  // npm 11 Arborist fails edgesOut when installing the pair over baseline dev
  // peers. A genuine isolated runtime install retains peer checks and its own
  // actual lock; no --legacy-peer-deps, registry-lock invention or waiver.
  run(
    "npm",
    ["install", "--ignore-scripts", "--no-audit", "--no-fund"],
    runtime,
  );
  run("npm", ["audit", "--omit=dev", "--audit-level=high"], runtime);
  overlayGraph(join(runtime, "node_modules"), join(mcp, "node_modules"));
  for (const [name, expected] of [
    ["agent", agentPack],
    ["skill", skillPack],
  ]) {
    verifyInstalled(join(mcp, "node_modules/@aifinpay", name), expected);
  }
  const sdk = await import(
    pathToFileURL(join(mcp, "node_modules/@aifinpay/agent/dist/index.js")).href
  );
  assert.equal(
    typeof sdk.Aifp1FinalizedFailureError,
    "function",
    "packed SDK graph/import is incomplete",
  );
  for (const name of readdirSync(join(root, "mcp"))) {
    if (
      ["node_modules", "dist", "package.json", "package-lock.json"].includes(
        name,
      ) ||
      (name.endsWith(".md") && name !== "README.md")
    )
      continue;
    const src = join(root, "mcp", name);
    cpSync(src, join(mcp, name), { recursive: true, verbatimSymlinks: true });
  }
  // Tests importing the Node history implementation need the same producer
  // tree; copy it without changing source or dependency bytes.
  mkdirSync(join(work, "node"));
  for (const name of [
    "src",
    "dist",
    "node_modules",
    "package.json",
    "package-lock.json",
  ])
    cpSync(join(root, "node", name), join(work, "node", name), {
      recursive: true,
      verbatimSymlinks: true,
    });
  mkdirSync(join(work, "python"));
  cpSync(
    join(root, "python/pyproject.toml"),
    join(work, "python/pyproject.toml"),
  );
  for (const [name, bytes] of Object.entries(repoBytes))
    writeFileSync(join(mcp, name), bytes);
  run("npm", ["run", "build"], mcp);
  verifySkill(readFileSync(join(mcp, "skills/SKILL.md")));
  run(process.execPath, ["--check", "bin/aifinpay-mcp.js"], mcp);
  run("npm", ["test"], mcp);
  run("npm", ["pack", "--dry-run", "--ignore-scripts"], mcp);
  const publication = spawnSync(
    process.execPath,
    ["scripts/verify-release-inputs.mjs"],
    { cwd: mcp, encoding: "utf8" },
  );
  assert.notEqual(
    publication.status,
    0,
    "source cohort must not satisfy registry publication gate",
  );
  assert.match(
    publication.stderr,
    /must be published and installed with its real registry resolution/,
  );
  for (const [name, bytes] of Object.entries(repoBytes))
    assert.deepEqual(
      readFileSync(join(root, "mcp", name)),
      bytes,
      "repository registry metadata changed",
    );
  const evidence = {
    source_only: true,
    sdk_commit: git(["rev-parse", "HEAD"]),
    skill_commit: SKILL_COMMIT,
    bootstrap_commit: BASE,
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
    work,
    agent: agentPack,
    skill: skillPack,
    actual_runtime_lock_sha256: hash(
      readFileSync(join(runtime, "package-lock.json")),
    ),
    publication_guard: "expected refusal",
    repository_metadata: Object.fromEntries(
      Object.entries(repoBytes).map(([p, b]) => [p, hash(b)]),
    ),
  };
  const destination =
    process.env.AIFP_COHORT_EVIDENCE ||
    join(work, "source-cohort-evidence.json");
  writeFileSync(destination, JSON.stringify(evidence, null, 2) + "\n");
  console.log(`Source-only cohort PASS; provenance ${destination}`);
  return evidence;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const skillSource = process.argv[2];
  if (!skillSource || !existsSync(skillSource))
    throw new Error("pinned canonical skill checkout path required");
  await checkSourceCohort(skillSource);
}
