// The skill handed to agents must match the installed canonical package.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const bundled = read("../skills/SKILL.md");
const installedSkillDir = require.resolve("@aifinpay/skill/package.json").replace(/package\.json$/, "");

describe("the bundled skill", () => {
  it("is the installed @aifinpay/skill, byte for byte", () => {
    const installed = readFileSync(installedSkillDir + "agent/skills/aifinpay/SKILL.md", "utf8");
    expect(bundled, "run `npm run sync:skills` after changing the skill dependency").toBe(installed);
  });
});
