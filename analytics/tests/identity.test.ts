import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { identityPath, loadInstallId, resolveInstallId } from "../src/identity.js";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aifp-telemetry-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

describe("install_id", () => {
  it("reports created only for the call that wrote the file", () => {
    const first = loadInstallId({ persist: true, home });
    expect(first.created).toBe(true);
    expect(loadInstallId({ persist: true, home })).toEqual({ id: first.id, created: false });
  });

  it("reports not created when the file cannot be written", () => {
    writeFileSync(join(home, ".aifinpay"), "not a directory");
    const result = loadInstallId({ persist: true, home });
    expect(result.created).toBe(false);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("is created on the first run with 600/700 permissions", () => {
    const id = resolveInstallId({ persist: true, home });
    const path = identityPath(home);
    expect(readFileSync(path, "utf8").trim()).toBe(id);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(join(home, ".aifinpay")).mode & 0o777).toBe(0o700);
  });

  it("persists across restarts", () => {
    const first = resolveInstallId({ persist: true, home });
    expect(resolveInstallId({ persist: true, home })).toBe(first);
  });

  it("resets when the file is wiped", () => {
    const first = resolveInstallId({ persist: true, home });
    rmSync(identityPath(home));
    expect(resolveInstallId({ persist: true, home })).not.toBe(first);
  });

  it("read-only never writes, but reuses an existing id", () => {
    const ephemeral = resolveInstallId({ persist: false, home });
    expect(existsSync(identityPath(home))).toBe(false);
    expect(ephemeral).toMatch(/^[0-9a-f-]{36}$/);
    const stored = resolveInstallId({ persist: true, home });
    expect(resolveInstallId({ persist: false, home })).toBe(stored);
  });

  it("never overwrites a malformed file it did not write", () => {
    mkdirSync(join(home, ".aifinpay"), { recursive: true });
    writeFileSync(identityPath(home), "not-a-uuid\n");
    resolveInstallId({ persist: true, home });
    expect(readFileSync(identityPath(home), "utf8")).toBe("not-a-uuid\n");
  });
});
