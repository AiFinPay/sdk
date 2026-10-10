import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  BASE,
  BASE_HASHES,
  COHORT,
  MCP_TEST_ARGS,
  SKILL_COMMIT,
  SKILL_TREE,
  SKILL_PACK,
  pack,
  verifyCohortVersions,
  verifyRuntimeLockSeed,
  verifyInstalled,
  verifySkill,
  verifySkillPack,
  verifyPinnedProducer,
  registryLockMatchesSourcePacks,
} from "./check-mcp-source-cohort.mjs";
test("canonical mirror and both CI refs bind the reviewed reporting producer; wrong source pack hashes refuse", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  verifySkill(readFileSync(join(root, "mcp/skills/SKILL.md")));
  assert.match(SKILL_COMMIT, /^[0-9a-f]{40}$/);
  assert.match(SKILL_TREE, /^[0-9a-f]{40}$/);
  const workflow = readFileSync(join(root, ".github/workflows/ci.yml"), "utf8");
  const refs = [
    ...workflow.matchAll(/repository: AiFinPay\/skill\s+ref: ([0-9a-f]+)/g),
  ].map((match) => match[1]);
  assert.deepEqual(refs, [SKILL_COMMIT, SKILL_COMMIT]);
  assert.deepEqual(
    MCP_TEST_ARGS,
    ["test", "--", "--maxWorkers=1"],
    "all tests and existing deadlines remain unchanged",
  );
  const expected = { version: COHORT.skill, ...SKILL_PACK };
  verifySkillPack(expected);
  for (const mutation of [
    { version: "2.8.0" },
    { sha256: "0".repeat(64) },
    { integrity: "sha512-changed" },
  ]) {
    assert.throws(
      () => verifySkillPack({ ...expected, ...mutation }),
      /canonical.*(version|pack differs)/,
    );
  }
});
test("reporting source target refuses every stale package version without claiming registry availability", () => {
  verifyCohortVersions({
    mcp: "2.8.0",
    agent: "2.6.0",
    python: "2.5.1",
    skill: "2.9.0",
  });
  for (const [name, oldVersion] of Object.entries({
    mcp: "2.7.0",
    agent: "2.5.0",
    python: "2.5.0",
    skill: "2.8.0",
  })) {
    assert.throws(
      () => verifyCohortVersions({ ...COHORT, [name]: oldVersion }),
      /wrong reporting source cohort/,
    );
  }
});
test("MCP candidate metadata preserves the real registry lock and refuses publication until the new inputs exist", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const manifest = JSON.parse(readFileSync(join(root, "mcp/package.json")));
  const lock = JSON.parse(readFileSync(join(root, "mcp/package-lock.json")));
  const baseline = JSON.parse(
    execFileSync("git", ["show", `${BASE}:mcp/package-lock.json`], {
      cwd: root,
    }),
  );
  assert.equal(manifest.version, COHORT.mcp);
  assert.equal(lock.version, COHORT.mcp);
  assert.equal(lock.packages[""].version, COHORT.mcp);
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  for (const name of ["@aifinpay/agent", "@aifinpay/skill"]) {
    assert.equal(
      manifest.dependencies[name],
      baseline.packages[""].dependencies[name],
    );
    assert.deepEqual(
      lock.packages[`node_modules/${name}`],
      baseline.packages[`node_modules/${name}`],
    );
  }
  assert.throws(
    () =>
      execFileSync(process.execPath, ["scripts/verify-release-inputs.mjs"], {
        cwd: join(root, "mcp"),
        stdio: ["ignore", "pipe", "pipe"],
      }),
    /@aifinpay\/agent 2\.6\.0 must be published and installed with its real registry resolution/,
  );
});
test("immutable bootstrap uses the existing patched registry lock without source tarball resolutions", () => {
  const root = fileURLToPath(new URL("../", import.meta.url));
  const inputs = Object.fromEntries(
    Object.entries(BASE_HASHES).map(([path, sha]) => {
      const bytes = execFileSync("git", ["show", `${BASE}:mcp/${path}`], {
        cwd: root,
      });
      assert.equal(createHash("sha256").update(bytes).digest("hex"), sha);
      return [path, JSON.parse(bytes)];
    }),
  );
  const manifest = inputs["package.json"];
  const lock = inputs["package-lock.json"];
  assert.deepEqual(lock.packages[""].dependencies, manifest.dependencies);
  assert.deepEqual(lock.packages[""].devDependencies, manifest.devDependencies);
  for (const [name, version] of [
    ["@modelcontextprotocol/sdk", "1.31.0"],
    ["proxy-addr", "2.0.8"],
  ]) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(
      entry.version,
      version,
      `${name} must include its advisory fix`,
    );
  }
  for (const [path, entry] of Object.entries(lock.packages)) {
    if (!path) continue;
    assert.match(entry.resolved, /^https:\/\/registry\.npmjs\.org\//);
    assert.match(entry.integrity, /^sha512-[A-Za-z0-9+/]+={0,2}$/);
  }
});
test("source pack follows the producer manifest after a version bump and still rejects a wrong expected version", () => {
  const path = mkdtempSync(join(tmpdir(), "aifp-source-pack-"));
  const previousCache = process.env.npm_config_cache;
  process.env.npm_config_cache = join(path, "cache");
  try {
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({
        name: "aifp-source-pack-fixture",
        version: "2.6.0",
        files: ["entry.js", "package-lock.json"],
      }),
    );
    writeFileSync(join(path, "entry.js"), "export const value = 1;");
    writeFileSync(
      join(path, "package-lock.json"),
      JSON.stringify({
        name: "aifp-source-pack-fixture",
        version: "2.6.0",
        lockfileVersion: 3,
        packages: {},
      }),
    );
    const result = pack(path, path);
    assert.equal(result.version, "2.6.0");
    assert.equal(
      result.sha256,
      createHash("sha256").update(readFileSync(result.tarball)).digest("hex"),
    );
    verifyInstalled(path, result);
    assert.equal(result.files["package-lock.json"], undefined);
    writeFileSync(join(path, "package-lock.json"), "{}");
    verifyInstalled(path, result); // An excluded lock is not packed-byte evidence.
    assert.throws(() => pack(path, path, "2.5.0"), /2\.6\.0.*2\.5\.0/s);
  } finally {
    if (previousCache === undefined) delete process.env.npm_config_cache;
    else process.env.npm_config_cache = previousCache;
    rmSync(path, { recursive: true, force: true });
  }
});
test("runtime resolution seed refuses a different producer, stale version or changed dependency declarations", () => {
  const manifest = {
    name: "@aifinpay/agent",
    version: "2.6.0",
    dependencies: { example: "^1.0.0" },
  };
  const lock = { ...manifest, lockfileVersion: 3, packages: { "": manifest } };
  const bytes = Buffer.from(JSON.stringify(lock));
  verifyRuntimeLockSeed(bytes, manifest);
  assert.throws(
    () => verifyRuntimeLockSeed(bytes, { ...manifest, name: "another" }),
    /producer/,
  );
  assert.throws(
    () => verifyRuntimeLockSeed(bytes, { ...manifest, version: "2.5.0" }),
    /version/,
  );
  assert.throws(
    () =>
      verifyRuntimeLockSeed(bytes, {
        ...manifest,
        dependencies: { example: "^2.0.0" },
      }),
    /dependencies/,
  );
  assert.throws(
    () =>
      verifyRuntimeLockSeed(
        Buffer.from(
          JSON.stringify({
            ...lock,
            packages: { "": { ...manifest, version: "2.5.0" } },
          }),
        ),
        manifest,
      ),
    /root version/,
  );
});
test("source cohort distinguishes a real registry lock from stale or fabricated release metadata", () => {
  const agent = { version: "2.5.0", integrity: "sha512-agent" };
  const skill = { version: "2.8.0", integrity: "sha512-skill" };
  const packs = { "@aifinpay/agent": agent, "@aifinpay/skill": skill };
  const dependencies = {
    "@aifinpay/agent": "^2.5.0",
    "@aifinpay/skill": "^2.8.0",
  };
  const manifest = { version: "2.7.0", dependencies };
  const lock = {
    version: "2.7.0",
    packages: {
      "": { version: "2.7.0", dependencies },
      "node_modules/@aifinpay/agent": {
        version: agent.version,
        resolved:
          "https://registry.npmjs.org/@aifinpay/agent/-/agent-2.5.0.tgz",
        integrity: agent.integrity,
      },
      "node_modules/@aifinpay/skill": {
        version: skill.version,
        resolved:
          "https://registry.npmjs.org/@aifinpay/skill/-/skill-2.8.0.tgz",
        integrity: skill.integrity,
      },
    },
  };
  assert.equal(registryLockMatchesSourcePacks(manifest, lock, packs), true);
  assert.equal(
    registryLockMatchesSourcePacks(manifest, lock, {
      ...packs,
      "@aifinpay/agent": { ...agent, version: "2.6.0" },
    }),
    false,
    "a newer source pack is not proof of the locked registry cohort",
  );
  const wrongIntegrity = structuredClone(lock);
  wrongIntegrity.packages["node_modules/@aifinpay/skill"].integrity =
    "sha512-fabricated";
  assert.equal(
    registryLockMatchesSourcePacks(manifest, wrongIntegrity, packs),
    false,
  );
  const sourceResolution = structuredClone(lock);
  sourceResolution.packages["node_modules/@aifinpay/agent"].resolved =
    "file:../node/aifinpay-agent-2.5.0.tgz";
  assert.equal(
    registryLockMatchesSourcePacks(manifest, sourceResolution, packs),
    false,
  );
  const staleRange = structuredClone(lock);
  staleRange.packages[""].dependencies["@aifinpay/skill"] = "^2.6.0";
  assert.equal(
    registryLockMatchesSourcePacks(manifest, staleRange, packs),
    false,
  );
});
test("source-cohort parity rejects wrong version and mutated installed package bytes", () => {
  const path = mkdtempSync(join(tmpdir(), "aifp-cohort-guard-"));
  try {
    writeFileSync(
      join(path, "package.json"),
      JSON.stringify({ version: "2.5.0" }),
    );
    writeFileSync(join(path, "entry.js"), "export const value = 1;");
    const sha = createHash("sha256")
      .update("export const value = 1;")
      .digest("hex");
    const expected = { version: "2.5.0", files: { "entry.js": sha } };
    verifyInstalled(path, expected);
    assert.throws(
      () => verifyInstalled(path, { ...expected, version: "2.4.0" }),
      /version/,
    );
    writeFileSync(join(path, "entry.js"), "export const value = 2;");
    assert.throws(() => verifyInstalled(path, expected), /differs/);
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
test("version text alone cannot substitute a stale or mutated canonical skill", () => {
  assert.throws(
    () => verifySkill(Buffer.from("version: 2.8.0\nchanged instructions")),
    /pinned producer/,
  );
  assert.throws(
    () => verifySkill(Buffer.from("version: 2.6.0\nstale instructions")),
    /pinned producer/,
  );
});

test("canonical packed producer refuses untracked, ignored and mutated bytes without blocking an unpacked work log", () => {
  const path = mkdtempSync(join(tmpdir(), "aifp-pinned-producer-"));
  const digest = (text) => createHash("sha256").update(text).digest("hex");
  const git = (...args) =>
    execFileSync("git", args, { cwd: path, stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();
  try {
    git("init");
    writeFileSync(join(path, "SKILL.md"), "reviewed bytes");
    git("add", "SKILL.md");
    git(
      "-c",
      "user.name=Source fixture",
      "-c",
      "user.email=fixture@example.invalid",
      "commit",
      "-m",
      "pinned fixture",
    );
    const commit = git("rev-parse", "HEAD");
    writeFileSync(join(path, "work-log.md"), "unpacked log is irrelevant");
    verifyPinnedProducer(
      path,
      { files: { "SKILL.md": digest("reviewed bytes") } },
      commit,
    );
    assert.throws(
      () =>
        verifyPinnedProducer(
          path,
          { files: { "UNREVIEWED.md": digest("extra") } },
          commit,
        ),
      /unreviewed packed/,
    );
    assert.throws(
      () =>
        verifyPinnedProducer(
          path,
          { files: { "SKILL.md": digest("mutated") } },
          commit,
        ),
      /differ/,
    );
    assert.throws(
      () =>
        verifyPinnedProducer(
          path,
          { files: { "ignored.txt": digest("ignored") } },
          commit,
        ),
      /unreviewed packed/,
    );
  } finally {
    rmSync(path, { recursive: true, force: true });
  }
});
