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
// Registry lock refreshed onto the published cohort (agent 2.6.4, skill 2.9.0,
// ee4b3b4), since moved to agent 2.9.0 and skill 2.10.2. Moved again to bda78b7
// (2026-10-22) for MCP SDK 1.32.1, which fixes GHSA-22jm-h49p-29qw (high) and
// GHSA-6prh-2h8m-c8cw; 1.31.0 had kept proxy-addr 2.0.8 for GHSA-6qxp-vccf-f47h /
// GHSA-jqcg-44mw-7w3h. Moved to baff204 (2026-10-24) for zod 4.6.7
// (GHSA-mrhx-c7xc-m3w5, high) and body-parser 2.4.0 (GHSA-27r3-jxmh-p828, high).
// Keep the bootstrap immutable between such refreshes.
export const BASE = "baff2043ca0170bc35e1603f3fa75f81ab54c2ea";
export const COHORT = {
  mcp: "2.15.3",
  agent: "2.11.0",
  python: "2.9.0",
  skill: "2.12.0",
};
// Real CLI subprocess tests retain their default five-second limit. Serialize
// the complete suite to avoid competing compiler/import workers starving them.
export const MCP_TEST_ARGS = ["test", "--", "--maxWorkers=1"];
// Parent-reviewed canonical reporting producer; no moving branch or registry
// artifact stands in for its committed tree and actual source pack.
export const SKILL_COMMIT = "b5406716aeb96a76775d50160709d65d3affc859";
export const SKILL_TREE = "ef8e694c8239f63d524d1cb95e44dc63badec531";
export const SKILL_SHA =
  "426ebd8d48b8df521c22722eb48bc854fb601fded5c6056e77ad4c3d6d57e963";
export const SKILL_PACK = {
  sha256: "fe94408fa449ac3c16fb5a6ed791c87e9de62e6303960ef904369f6c7d64896a",
  integrity:
    "sha512-YN0snOUYA2Dmk3gb87xVTsh7ZXB+ArimQTXq6QOYg2PdKnT2Uoy+PjLSo33DIPuZIUREWgQxtKyUQVH3aYZgOg==",
};
export const BASE_HASHES = {
  "package.json":
    "cabf85d32e095147a300c3c3730e3f2edfd9b548a24f6e6034545f852fd2e926",
  "package-lock.json":
    "a5956cbab4359f24d262a516981763bc3288c809713dca3c208e384d235275e7",
};
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const json = (path) => JSON.parse(readFileSync(path, "utf8"));
export function verifyCohortVersions(versions) {
  assert.deepEqual(versions, COHORT, "wrong reporting source cohort versions");
}
export function verifySkill(bytes) {
  assert.equal(
    hash(bytes),
    SKILL_SHA,
    "canonical skill bytes differ from reviewed pinned producer",
  );
  assert.equal(
    bytes.toString().match(/^version:\s*(\S+)$/m)?.[1],
    COHORT.skill,
    "canonical skill must match the reporting source target",
  );
}
export function verifySkillPack(expected) {
  assert.equal(expected.version, COHORT.skill, "wrong canonical pack version");
  assert.deepEqual(
    { sha256: expected.sha256, integrity: expected.integrity },
    SKILL_PACK,
    "canonical source pack differs from the reviewed producer",
  );
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
export function verifyRuntimeLockSeed(bytes, manifest) {
  const lock = JSON.parse(bytes);
  assert.equal(lock.lockfileVersion, 3, "unsupported source lock format");
  assert.equal(
    lock.name,
    manifest.name,
    "source lock belongs to another producer",
  );
  assert.equal(lock.version, manifest.version, "source lock version drift");
  assert.equal(
    lock.packages?.[""]?.version,
    manifest.version,
    "source lock root version drift",
  );
  assert.deepEqual(
    lock.packages?.[""]?.dependencies,
    manifest.dependencies,
    "source lock dependencies differ from the producer",
  );
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

// The cohort is installed from reviewed source packs. A registry-aligned
// repository lock can nevertheless make the release-input metadata guard pass;
// that result is not evidence that this disposable installation came from npm.
export function registryLockMatchesSourcePacks(manifest, lock, packs) {
  if (
    lock.version !== manifest.version ||
    lock.packages?.[""]?.version !== manifest.version
  )
    return false;
  for (const [name, pack] of Object.entries(packs)) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (
      manifest.dependencies?.[name] !== `^${pack.version}` ||
      lock.packages?.[""]?.dependencies?.[name] !== `^${pack.version}` ||
      entry?.version !== pack.version ||
      entry?.resolved !==
        `https://registry.npmjs.org/${name}/-/${name.split("/")[1]}-${pack.version}.tgz` ||
      entry?.integrity !== pack.integrity
    )
      return false;
  }
  return true;
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
export function pack(
  cwd,
  target,
  version = json(join(cwd, "package.json")).version,
) {
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
    git(["rev-parse", "HEAD^{tree}"], skillRoot),
    SKILL_TREE,
    "skill producer tree differs from the reviewed handoff",
  );
  assert.equal(
    git(["status", "--porcelain", "--untracked-files=no"], skillRoot),
    "",
    "skill producer has tracked changes",
  );
  verifyCohortVersions({
    mcp: json(join(root, "mcp/package.json")).version,
    agent: json(join(root, "node/package.json")).version,
    python: readFileSync(join(root, "python/pyproject.toml"), "utf8").match(
      /^version = "([^"]+)"/m,
    )?.[1],
    skill: json(join(skillRoot, "package.json")).version,
  });
  verifySkill(readFileSync(join(skillRoot, "agent/skills/aifinpay/SKILL.md")));
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
  const agentPack = pack(join(root, "node"), packs, COHORT.agent);
  // npm excludes package-lock.json from tarballs even if files lists it.
  // Retain the source lock as separate resolution evidence, never pack evidence.
  const runtimeLockSeed = readFileSync(join(root, "node/package-lock.json"));
  verifyRuntimeLockSeed(runtimeLockSeed, json(join(root, "node/package.json")));
  const skillPack = pack(skillRoot, packs, COHORT.skill);
  verifySkillPack(skillPack);
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
  // Reuse the source agent's authoritative lock as npm's resolution seed.
  // npm rewrites it for the genuine local pair, retaining reviewed transitive
  // pins instead of floating to a different dependency graph on every run.
  writeFileSync(join(runtime, "package-lock.json"), runtimeLockSeed);
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
  run("npm", MCP_TEST_ARGS, mcp);
  run("npm", ["pack", "--dry-run", "--ignore-scripts"], mcp);
  const publication = spawnSync(
    process.execPath,
    ["scripts/verify-release-inputs.mjs"],
    { cwd: mcp, encoding: "utf8" },
  );
  const registryAligned = registryLockMatchesSourcePacks(
    json(join(mcp, "package.json")),
    json(join(mcp, "package-lock.json")),
    { "@aifinpay/agent": agentPack, "@aifinpay/skill": skillPack },
  );
  if (registryAligned) {
    assert.equal(
      publication.status,
      0,
      `registry-aligned release-input metadata guard failed: ${publication.stderr}`,
    );
  } else {
    assert.notEqual(
      publication.status,
      0,
      "source cohort without matching registry lock passed release-input metadata guard",
    );
    assert.match(
      publication.stderr,
      /must be published and installed with its real registry resolution|external source-cohort link is not a publishable registry installation/,
    );
  }
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
    skill_tree: SKILL_TREE,
    bootstrap_commit: BASE,
    npm: execFileSync("npm", ["--version"], { encoding: "utf8" }).trim(),
    mcp_test_command: ["npm", ...MCP_TEST_ARGS],
    work,
    agent: agentPack,
    skill: skillPack,
    runtime_lock_seed_sha256: hash(runtimeLockSeed),
    actual_runtime_lock_sha256: hash(
      readFileSync(join(runtime, "package-lock.json")),
    ),
    publication_guard: registryAligned
      ? "metadata accepted with registry-aligned lock; source cohort remains source-only"
      : "expected refusal without registry-aligned lock",
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
