import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  verifyInstalled,
  verifySkill,
  verifyPinnedProducer,
  registryLockMatchesSourcePacks,
} from "./check-mcp-source-cohort.mjs";
test("source cohort distinguishes a real registry lock from stale or fabricated release metadata", () => {
  const agent = { version: "2.5.0", integrity: "sha512-agent" };
  const skill = { version: "2.8.0", integrity: "sha512-skill" };
  const packs = { "@aifinpay/agent": agent, "@aifinpay/skill": skill };
  const dependencies = {
    "@aifinpay/agent": "^2.5.1",
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
  assert.equal(registryLockMatchesSourcePacks(manifest, staleRange, packs), false);
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
