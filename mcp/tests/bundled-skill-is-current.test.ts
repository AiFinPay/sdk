// The skill this server hands agents as aifinpay://skill must be the one it
// depends on, and must describe this release.
//
// MCP 2.3.0 shipped a skill three releases old: it told agents the current MCP
// was 2.2.4, that Python cannot pay, and nothing about USDC. `prebuild` copies
// node_modules/@aifinpay/skill into skills/SKILL.md, and the lockfile still
// resolved the ^2.1.0 dependency to 2.1.0, so every build faithfully copied the
// stale text. Nothing failed, because nothing compared the copy with anything.
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const read = (rel: string) => readFileSync(new URL(rel, import.meta.url), "utf8");

const bundled = read("../skills/SKILL.md");
const mcpVersion: string = JSON.parse(read("../package.json")).version;

describe("the bundled skill", () => {
  it("is the installed @aifinpay/skill, byte for byte", () => {
    const installedDir = require.resolve("@aifinpay/skill/package.json").replace(/package\.json$/, "");
    const installed = readFileSync(installedDir + "agent/skills/aifinpay/SKILL.md", "utf8");
    expect(bundled, "run `npm run sync:skills` after changing the skill dependency").toBe(installed);
  });

  it("names this MCP release line as current", () => {
    const [major, minor] = mcpVersion.split(".");
    const current = bundled.match(/Released and current: MCP \*\*(\d+)\.(\d+)\.\d+\*\*/);
    expect(current, "the skill no longer states the current MCP version").not.toBeNull();
    expect(`${current![1]}.${current![2]}`, "bump @aifinpay/skill to a release that describes this MCP").toBe(
      `${major}.${minor}`
    );
  });
});
