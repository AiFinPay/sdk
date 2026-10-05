// The skill handed to agents must be the installed canonical package, and its
// explicit release target must describe this exact MCP/SDK source cohort.
// A dated published baseline is historical evidence, not the release target.
//
// MCP 2.3.0 shipped a skill three releases old: it told agents the current MCP
// was 2.2.4, that Python cannot pay, and nothing about USDC. `prebuild` copies
// node_modules/@aifinpay/skill into skills/SKILL.md, and the lockfile still
// resolved the ^2.1.0 dependency to 2.1.0, so every build faithfully copied the
// stale text. Nothing failed, because nothing compared the copy with anything.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const bundled = read("../skills/SKILL.md");
const mcpVersion: string = JSON.parse(read("../package.json")).version;
const installedSkillDir = require.resolve("@aifinpay/skill/package.json").replace(/package\.json$/, "");
const skillVersion: string = JSON.parse(readFileSync(installedSkillDir + "package.json", "utf8")).version;
const agentVersion: string = JSON.parse(
  readFileSync(join(dirname(require.resolve("@aifinpay/agent")), "..", "package.json"), "utf8")
).version;
const pythonVersion = read("../../python/pyproject.toml").match(/^version = "([^"]+)"/m)![1];

function checkReleaseTarget(text: string) {
  const frontmatter = text.match(/^---\n([\s\S]*?)\n---/);
  expect(frontmatter, "the canonical skill needs frontmatter").not.toBeNull();
  expect(frontmatter![1].match(/^version:\s*(\S+)$/m)?.[1], "skill frontmatter must match its package").toBe(
    skillVersion
  );
  const targets = [
    ...text.matchAll(
      /^Release target: MCP \*\*(\d+\.\d+\.\d+)\*\*, Node SDK \*\*(\d+\.\d+\.\d+)\*\*, Python \*\*(\d+\.\d+\.\d+)\*\*\.$/gm
    ),
  ];
  expect(targets, "require one explicit target; current-only or baseline text cannot substitute").toHaveLength(1);
  expect(targets[0].slice(1), "canonical skill must describe the exact MCP/Node/Python cohort").toEqual([
    mcpVersion,
    agentVersion,
    pythonVersion,
  ]);
}

describe("the bundled skill", () => {
  it("is the installed @aifinpay/skill, byte for byte", () => {
    const installed = readFileSync(installedSkillDir + "agent/skills/aifinpay/SKILL.md", "utf8");
    expect(bundled, "run `npm run sync:skills` after changing the skill dependency").toBe(installed);
  });

  it("names the exact prepared release target without claiming publication", () => {
    checkReleaseTarget(bundled);
    expect(bundled).toContain("Published baseline checked 2026-10-04:");
    expect(bundled).not.toContain("Released and current:");
  });

  it.each([
    [
      "old current-only guide",
      (text: string) =>
        text.replace(
          /^Release target:.*\n/m,
          "Released and current: MCP **2.5.0**, Node SDK **2.3.0**, Python **2.3.0**.\n"
        ),
    ],
    ["baseline-only guide", (text: string) => text.replace(/^Release target:.*\n/m, "")],
    ["wrong MCP patch", (text: string) => text.replace(`MCP **${mcpVersion}**`, "MCP **2.6.99**")],
    ["wrong Node version", (text: string) => text.replace(`Node SDK **${agentVersion}**`, "Node SDK **2.3.2**")],
    ["wrong Python version", (text: string) => text.replace(`Python **${pythonVersion}**`, "Python **2.3.0**")],
    ["stale frontmatter", (text: string) => text.replace(/^version: .*$/m, "version: 2.6.0")],
    ["ambiguous duplicate target", (text: string) => text + "\n" + text.match(/^Release target:.*$/m)![0] + "\n"],
  ])("refuses %s", (_name, mutate) => {
    expect(() => checkReleaseTarget(mutate(bundled))).toThrow();
  });
});
