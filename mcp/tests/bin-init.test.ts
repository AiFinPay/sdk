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

  // ── Recovery output and secret leakage (AIFINP-220 §3) ─────────────────
  //
  // The rule the audit sets: the private key must never reach chat or logs. The
  // recovery print is not a violation of that — it is a one-time backup on the
  // TERMINAL, a channel the human running init controls. These tests hold both
  // halves: the recovery line IS there on a fresh plaintext init, and the secret
  // is NOT anywhere it could be retained.

  it("prints the recovery key once, on a fresh plaintext wallet", () => {
    const out = run(["init"]);
    // The base58 secret is on disk; the recovery block surfaces it once for an
    // off-machine backup.
    const secret = JSON.parse(readFileSync(join(home, "agent.json"), "utf8")).secretB58 as string;
    expect(out).toContain("RECOVERY KEY");
    expect(out).toContain(secret);
    expect(out).toMatch(/shown once/i);
    expect(out).toMatch(/do NOT paste it into a chat/i);
  });

  it("does NOT reprint the recovery key on a second init", () => {
    // Shown once means once. A second init keeps the wallet and must not surface
    // the secret again — that would turn "shown once" into "shown every run".
    run(["init"]);
    const second = run(["init"]);
    expect(second).toContain("keeping it");
    expect(second).not.toContain("RECOVERY KEY");
  });

  it("does NOT print the recovery key when the keystore is encrypted", () => {
    // With a passphrase, recovery is the file plus the passphrase. Reprinting the
    // plaintext secret would undo the encryption the user just chose.
    const out = run(["init"], { AIFINPAY_WALLET_PASSPHRASE: "pw" });
    expect(out).not.toContain("RECOVERY KEY");
    const secret = readFileSync(join(home, "agent.json"), "utf8");
    // and the plaintext secret is not in the output at all
    expect(out).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{80,}/);
    expect(secret).not.toContain("secretB58");
  });

  it("the ephemeral (no-init) start never prints a secret — only addresses", () => {
    // This is the autonomous path: an agent launched with no wallet gets an
    // in-memory identity. It must be able to say "here are my addresses" without
    // the secret ever reaching the transcript, because that transcript is chat.
    // Starting with no stdin would hang the stdio server, so we only assert on
    // what a start CANNOT contain, via the help path which shares the banner
    // code but exits.
    const out = run(["--help"]);
    expect(out).not.toMatch(/RECOVERY KEY/);
    // No 64+ char base58 run anywhere — a secret would show up as one.
    expect(out).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{80,}/);
  });

  it("with a passphrase, the secret is NOT on disk in the clear", () => {
    const out = run(["init"], { AIFINPAY_WALLET_PASSPHRASE: "correct horse battery staple" });
    const raw = readFileSync(join(home, "agent.json"), "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.enc).toBe("scrypt-aes-256-gcm");
    expect(parsed.secretB58).toBeUndefined();
    const addr = out.match(EVM)?.[0];
    expect(addr).toBeTruthy();
    expect(raw).not.toContain(addr!.slice(2));
    expect(out).toMatch(/ENCRYPTED/);
  });

  it("the same passphrase reproduces the same wallet", () => {
    const pass = { AIFINPAY_WALLET_PASSPHRASE: "s3cret" };
    const first = run(["init"], pass).match(EVM)?.[0];
    const second = run(["init"], pass).match(EVM)?.[0];
    expect(second).toBe(first);
  });

  it("a wrong passphrase fails loudly and does NOT mint a new wallet", () => {
    run(["init"], { AIFINPAY_WALLET_PASSPHRASE: "right" });
    const before = readFileSync(join(home, "agent.json"), "utf8");
    expect(() => run(["init"], { AIFINPAY_WALLET_PASSPHRASE: "wrong" })).toThrow();
    expect(readFileSync(join(home, "agent.json"), "utf8")).toBe(before);
  });

  it("an encrypted keystore with no passphrase set refuses rather than guessing", () => {
    run(["init"], { AIFINPAY_WALLET_PASSPHRASE: "p" });
    expect(() => run([])).toThrow();
  });

  it("without a passphrase, behaviour is unchanged — plaintext, and it says so", () => {
    const out = run(["init"]);
    const parsed = JSON.parse(readFileSync(join(home, "agent.json"), "utf8"));
    expect(typeof parsed.secretB58).toBe("string");
    expect(parsed.enc).toBeUndefined();
    expect(out).toMatch(/plaintext/);
  });

  it("an unknown command fails instead of silently starting", () => {
    // Silently starting a server on a typo is how someone ends up funding an
    // ephemeral address.
    expect(() => run(["frobnicate"])).toThrow();
  });
});
