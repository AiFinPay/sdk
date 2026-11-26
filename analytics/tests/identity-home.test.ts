// Bun's os.homedir() keeps the home it started with when HOME changes at
// runtime; Node's follows it. The install id must follow the environment
// either way, so a process (or test) that redirects HOME never touches the
// real ~/.aifinpay.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("node:os", async (importOriginal) => {
  const os = await importOriginal<typeof import("node:os")>();
  return { ...os, homedir: () => "/stale-start-home" };
});

const { identityPath } = await import("../src/identity.js");
const HOME_VAR = process.platform === "win32" ? "USERPROFILE" : "HOME";
const saved = process.env[HOME_VAR];
const dirs: string[] = [];

afterEach(() => {
  if (saved === undefined) delete process.env[HOME_VAR];
  else process.env[HOME_VAR] = saved;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("identityPath home", () => {
  it("follows a home variable changed after start", () => {
    const home = mkdtempSync(join(tmpdir(), "aifp-home-"));
    dirs.push(home);
    process.env[HOME_VAR] = home;
    expect(identityPath()).toBe(join(home, ".aifinpay", ".telemetry-id"));
  });

  it("falls back to os.homedir() when the variable is unset or empty", () => {
    process.env[HOME_VAR] = "";
    expect(identityPath()).toBe(join("/stale-start-home", ".aifinpay", ".telemetry-id"));
    delete process.env[HOME_VAR];
    expect(identityPath()).toBe(join("/stale-start-home", ".aifinpay", ".telemetry-id"));
  });

  it("an explicit home still wins", () => {
    process.env[HOME_VAR] = "/ignored";
    expect(identityPath("/explicit")).toBe(join("/explicit", ".aifinpay", ".telemetry-id"));
  });
});
