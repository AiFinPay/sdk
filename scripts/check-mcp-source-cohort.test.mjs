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
} from "./check-mcp-source-cohort.mjs";
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
