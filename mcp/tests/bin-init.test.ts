// `npx @aifinpay/mcp init` — the one command that has to work.
//
// Before it existed, running the server with nothing configured produced an
// ephemeral wallet and a "DO NOT FUND" warning, and pointed the reader at
// `aifinpay init`. That command is not published: `@aifinpay/cli` and
// `aifinpay` both 404 on npm. So the documented way out of the dead end did
// not exist, and the only real path was writing a Node script against the SDK.
//
// These tests cover the three things that make it one command rather than a
// first step:
//
//   1. init produces a wallet that survives the process
//   2. running it twice does NOT regenerate — the file may already hold funds
//   3. the server picks the keystore up on its own, so the secret never has to
//      go into an MCP config file (those get pasted into chats and committed)
//
// Everything runs the real bin as a subprocess. A unit test of the helpers
// would not have caught that `--help` used to start a stdio server and hang.

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const BIN = fileURLToPath(new URL("../bin/aifinpay-mcp.js", import.meta.url));

let home: string;
beforeEach(() => { home = mkdtempSync(join(tmpdir(), "aifp-mcp-")); });
afterEach(() => { rmSync(home, { recursive: true, force: true }); });

/**
 * Run the bin with an isolated AIFINPAY_HOME, returning stdout AND stderr.
 *
 * Both streams, deliberately: the server logs its identity and every warning
 * to stderr, and the first version of this helper read stdout only. Two tests
 * failed against a binary that was behaving correctly — the assertions were
 * looking at the wrong pipe.
 */
function run(args: string[], extraEnv: Record<string, string> = {}): string {
  const r = spawnSync(process.execPath, [BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    input: "",                       // stdio server would otherwise wait forever
    env: { ...process.env, AIFINPAY_HOME: home, ...extraEnv },
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw Object.assign(new Error(`exited ${r.status}: ${r.stderr}`), { status: r.status });
  }
  return (r.stdout ?? "") + (r.stderr ?? "");
}

const EVM = /0x[a-fA-F0-9]{40}/;

describe("aifinpay-mcp init", () => {
  it("creates a keystore and prints all three addresses", () => {
    const out = run(["init"]);
    const keystore = join(home, "agent.json");

    expect(existsSync(keystore)).toBe(true);
    expect(out).toMatch(EVM);
    expect(out).toMatch(/Solana\s+[1-9A-HJ-NP-Za-km-z]{32,44}/);
    expect(out).toMatch(/Casper\s+account-hash-[a-f0-9]{64}/);
  });

  it("writes the keystore mode 600", () => {
    run(["init"]);
    // A secret readable by other users on the box is a secret that leaks
    // through a backup, a container image or a shared CI runner.
    const mode = statSync(join(home, "agent.json")).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("does not regenerate on a second init", () => {
    const first = run(["init"]);
    const secret = JSON.parse(readFileSync(join(home, "agent.json"), "utf8")).secretB58;

    const second = run(["init"]);
    const after = JSON.parse(readFileSync(join(home, "agent.json"), "utf8")).secretB58;

    expect(after).toBe(secret);
    expect(second).toMatch(/Existing wallet found/);
    // The address a user may have funded has to be the same one they see the
    // second time, or they will fund the wrong one.
    expect(second.match(EVM)?.[0]).toBe(first.match(EVM)?.[0]);
  });

  it("keeps the secret out of the printed MCP config", () => {
    const out = run(["init"]);
    const secret = JSON.parse(readFileSync(join(home, "agent.json"), "utf8")).secretB58;
    const block = out.slice(out.indexOf("{"), out.lastIndexOf("}") + 1);
    expect(block).toContain("mcpServers");
    expect(block).not.toContain(secret);
  });
});

describe("aifinpay-mcp server", () => {
  it("loads the keystore without AIFINPAY_AGENT_SECRET being set", () => {
    const init = run(["init"]);
    const expected = init.match(EVM)?.[0];

    // Explicitly blank the env var: the point is that the file alone suffices.
    const server = run([], { AIFINPAY_AGENT_SECRET: "" });

    expect(server).not.toMatch(/EPHEMERAL/);
    expect(server).not.toMatch(/DO NOT FUND/);
    expect(server).toContain(expected!);
  });

  it("still says so plainly when there is no wallet at all", () => {
    const out = run([], { AIFINPAY_AGENT_SECRET: "" });
    expect(out).toMatch(/npx @aifinpay\/mcp init/);
  });
});

describe("aifinpay-mcp flags", () => {
  it("--help prints usage instead of starting a server", () => {
    // The regression this guards: every argument used to fall through to the
    // stdio server, so `--help` looked like a hang — the process was waiting
    // for MCP framing on stdin.
    const out = run(["--help"]);
    expect(out).toMatch(/npx @aifinpay\/mcp init/);
    expect(out).not.toMatch(/EPHEMERAL/);
  });

  it("--version prints only a version", () => {
    expect(run(["--version"]).trim()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it("an unknown command fails instead of silently starting", () => {
    // Silently starting a server on a typo is how someone ends up funding an
    // ephemeral address.
    expect(() => run(["frobnicate"])).toThrow();
  });
});
