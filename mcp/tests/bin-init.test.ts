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

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { DEFAULT_DAILY_USD, DEFAULT_MAX_GAS_POL, DEFAULT_MAX_USD, loadConfigFromEnv } from "../src/config.js";

const BIN = fileURLToPath(new URL("../bin/aifinpay-mcp.js", import.meta.url));
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");

let home: string;
// Vitest runs the bin with stdin piped, which is exactly an agent's subprocess.
// Tests of the human path (prompts for a passphrase, prose output) make stdin
// report a terminal; the non-interactive tests below run the bin as it is.
let ttyStdin: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aifp-mcp-"));
  ttyStdin = join(home, "tty-stdin-fixture.mjs");
  writeFileSync(ttyStdin, "Object.defineProperty(process.stdin, 'isTTY', { value: true });\n", { mode: 0o600 });
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

/**
 * Run the bin with an isolated AIFINPAY_HOME, returning stdout AND stderr.
 *
 * Both streams, deliberately: the server logs its identity and every warning
 * to stderr, and the first version of this helper read stdout only. Two tests
 * failed against a binary that was behaving correctly — the assertions were
 * looking at the wrong pipe.
 */
function isolatedEnv(extraEnv: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, AIFINPAY_HOME: home };
  for (const key of [
    "SEED_HASH",
    "AIFINPAY_AGENTS_FILE",
    "AIFINPAY_AGENT_ID",
    "AIFINPAY_AGENT_SECRET",
    "AIFINPAY_WALLET_PASSPHRASE",
  ]) {
    delete env[key];
  }
  return { ...env, ...extraEnv };
}

function runRaw(args: string[], extraEnv: Record<string, string> = {}, nodeArgs: string[] = []) {
  const r = spawnSync(process.execPath, [...nodeArgs, BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    cwd: home,
    input: "", // stdio server would otherwise wait forever
    env: isolatedEnv(extraEnv),
  });
  if (r.error) throw r.error;
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

/** The human path: stdin reports a terminal. */
function run(args: string[], extraEnv: Record<string, string> = {}, nodeArgs: string[] = []): string {
  const r = runRaw(args, extraEnv, ["--import", ttyStdin, ...nodeArgs]);
  if (r.status !== 0) {
    throw Object.assign(new Error(`exited ${r.status}: ${r.stderr}`), { status: r.status });
  }
  return r.stdout + r.stderr;
}

/** The agent path: stdin is a pipe. stdout must be one JSON document; stderr is kept apart. */
function runJson(args: string[], extraEnv: Record<string, string> = {}) {
  const r = runRaw(args, extraEnv);
  let json: any;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    throw new Error(`stdout is not one JSON document (exit ${r.status}): ${r.stdout}\n${r.stderr}`);
  }
  return { ...r, json };
}

const EVM = /0x[a-fA-F0-9]{40}/;

/** The JSON blocks init prints, in order: the client config, then the payment env. */
function printed(out: string): any[] {
  return [...out.matchAll(/^\{\n[\s\S]*?\n\}$/gm)].map((match) => JSON.parse(match[0]));
}

describe("aifinpay-mcp init", () => {
  it("refuses to create an unencrypted wallet unless asked by name", () => {
    let err: (Error & { status?: number }) | null = null;
    try {
      run(["init"]);
    } catch (e) {
      err = e as Error & { status?: number };
    }
    expect(err?.status).toBe(2);
    expect(String(err?.message)).toMatch(/AIFINPAY_WALLET_PASSPHRASE/);
    expect(String(err?.message)).toMatch(/--plaintext/);
    expect(existsSync(join(home, "agent.json"))).toBe(false);
  });

  it("creates an encrypted wallet when a passphrase is set, without the flag", () => {
    const out = run(["init"], { AIFINPAY_WALLET_PASSPHRASE: "fixture-passphrase" });
    expect(out).toMatch(/ENCRYPTED/);
    const store = JSON.parse(readFileSync(join(home, "agent.json"), "utf8"));
    expect(store.enc).toBe("scrypt-aes-256-gcm");
    expect(store.secretB58).toBeUndefined();
  });

  it("creates a keystore and prints all three addresses", () => {
    const out = run(["init", "--plaintext"]);
    const keystore = join(home, "agent.json");

    expect(existsSync(keystore)).toBe(true);
    expect(out).toMatch(EVM);
    expect(out).toMatch(/Solana\s+[1-9A-HJ-NP-Za-km-z]{32,44}/);
    expect(out).toMatch(/Casper\s+account-hash-[a-f0-9]{64}/);
  });

  it("writes the keystore mode 600", () => {
    run(["init", "--plaintext"]);
    // A secret readable by other users on the box is a secret that leaks
    // through a backup, a container image or a shared CI runner.
    const mode = statSync(join(home, "agent.json")).mode & 0o777;
    expect(mode & 0o077).toBe(0);
  });

  it("does not regenerate on a second init", () => {
    const first = run(["init", "--plaintext"]);
    const secret = JSON.parse(readFileSync(join(home, "agent.json"), "utf8")).secretB58;

    const second = run(["init", "--plaintext"]);
    const after = JSON.parse(readFileSync(join(home, "agent.json"), "utf8")).secretB58;

    expect(after === secret).toBe(true);
    expect(second).toMatch(/Existing wallet found/);
    expect(second.includes("hold nothing yet")).toBe(false);
    // The address a user may have funded has to be the same one they see the
    // second time, or they will fund the wrong one.
    expect(second.match(EVM)?.[0]).toBe(first.match(EVM)?.[0]);
  });

  it("keeps the secret out of the printed MCP config", () => {
    const out = run(["init", "--plaintext"]);
    const secret = JSON.parse(readFileSync(join(home, "agent.json"), "utf8")).secretB58;
    const blocks = printed(out);
    expect(blocks[0]).toHaveProperty("mcpServers");
    expect(JSON.stringify(blocks).includes(secret)).toBe(false);
  });

  it.each([false, true])(
    "concurrent init preserves one wallet (encrypted=%s)",
    async (encrypted) => {
      const barrier = join(home, "init-barrier.mjs");
      writeFileSync(
        barrier,
        `import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalWrite = fs.writeFileSync, originalLink = fs.linkSync;
function waitAtPublish(target) {
  if (String(target) !== process.env.AIFINPAY_HOME + '/agent.json') return;
  const marker = process.env.AIFINPAY_HOME + '/' + process.env.AIFP_TEST_WRITER;
  originalWrite(marker + '.ready', 'ready', {mode: 0o600});
  const deadline = Date.now() + 15000;
  while (!fs.existsSync(marker + '.release')) {
    if (Date.now() > deadline) throw new Error('test publish barrier timed out');
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10);
  }
}
fs.writeFileSync = function(target, ...args) { waitAtPublish(target); return originalWrite.call(this, target, ...args); };
fs.linkSync = function(source, target) { waitAtPublish(target); return originalLink.call(this, source, target); };
syncBuiltinESMExports();
`,
        { mode: 0o600 }
      );
      const children: ReturnType<typeof spawn>[] = [];
      const launch = (writer: string) => {
        const child = spawn(process.execPath, ["--import", ttyStdin, "--import", barrier, BIN, "init", "--plaintext"], {
          cwd: home,
          env: isolatedEnv({
            AIFP_TEST_WRITER: writer,
            ...(encrypted ? { AIFINPAY_WALLET_PASSPHRASE: "fixture-passphrase" } : {}),
          }),
          stdio: ["ignore", "pipe", "pipe"],
        });
        children.push(child);
        let output = "";
        child.stdout!.on("data", (chunk) => {
          output += chunk;
        });
        child.stderr!.on("data", (chunk) => {
          output += chunk;
        });
        return new Promise<{ code: number | null; output: string }>((resolve) =>
          child.on("close", (code) => resolve({ code, output }))
        );
      };
      try {
        const a = launch("a"),
          b = launch("b");
        const deadline = Date.now() + 15000;
        while (!existsSync(join(home, "a.ready")) || !existsSync(join(home, "b.ready"))) {
          if (Date.now() > deadline) throw new Error("concurrent init did not reach publish barrier");
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
        writeFileSync(join(home, "a.release"), "go");
        const first = await a;
        const before = readFileSync(join(home, "agent.json"), "utf8");
        writeFileSync(join(home, "b.release"), "go");
        const second = await b;
        const after = readFileSync(join(home, "agent.json"), "utf8");
        expect(first.code).toBe(0);
        expect(second.code).toBe(0);
        expect(after === before).toBe(true);
        expect(first.output.match(EVM)?.[0]).toBe(second.output.match(EVM)?.[0]);
        expect(first.output.includes("Created ")).toBe(true);
        expect(second.output.includes("Created ")).toBe(false);
        expect(second.output.includes("Existing wallet found")).toBe(true);
        expect((first.output + second.output).includes("RECOVERY KEY")).toBe(false);
        expect(readdirSync(home).some((name) => name.startsWith(".agent-init-"))).toBe(false);
      } finally {
        for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
      }
    },
    25000
  );
});

// ── init without a terminal ────────────────────────────────────────────
//
// An agent runs `npx @aifinpay/mcp init` as a subprocess with stdin piped. On
// 2026-10-19 such a run waited 167 s for a passphrase nobody could type, and
// the agent then invented its own key handling. Without a terminal init must
// decide everything itself and print one JSON document the agent can act on.

describe("aifinpay-mcp init without a terminal", () => {
  const PASSPHRASE = /^[A-Za-z0-9_-]{32}$/; // 24 random bytes, base64url

  it("creates an encrypted wallet with a generated passphrase and prints the env block", () => {
    const r = runJson(["init"]);
    expect(r.status).toBe(0);
    const keystore = join(home, "agent.json");
    expect(r.json).toMatchObject({ keystore, created: true, encrypted: true, source: "legacy-keystore" });
    expect(r.json.addresses.evm).toMatch(EVM);
    expect(r.json.addresses.solana).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(r.json.addresses.casper).toMatch(/^account-hash-[a-f0-9]{64}$/);
    // The keystore is under this AIFINPAY_HOME, so the server must be told it too.
    expect(Object.keys(r.json.env)).toEqual(["AIFINPAY_HOME", "AIFINPAY_WALLET_PASSPHRASE"]);
    expect(r.json.env.AIFINPAY_HOME).toBe(home);
    const passphrase = r.json.env.AIFINPAY_WALLET_PASSPHRASE;
    expect(passphrase).toMatch(PASSPHRASE);
    // The passphrase is in the env block and nowhere else: not twice, not on stderr.
    expect(r.stdout.split(passphrase)).toHaveLength(2);
    expect(r.stderr).not.toContain(passphrase);
    expect(r.json.passphrase_note).toContain("AIFINPAY_WALLET_PASSPHRASE");
    expect(r.json.next_step).toContain("payment_setup_status");
    // Payments need no env: the JSON says so and lists only optional overrides.
    expect(r.json.payments).toContain("on by default");
    expect(r.json.payments).toContain("$5 per payment and $20 per 24 hours");
    expect(Object.keys(r.json.optional_env_example)).toEqual(["AIFINPAY_GATEWAY_ORIGINS", "AIFINPAY_MAX_GAS_POL"]);
    expect(r.json.payment_env_example).toBeUndefined();
    expect(r.json.next_step).toContain("without a restart");
    const store = JSON.parse(readFileSync(keystore, "utf8"));
    expect(store.enc).toBe("scrypt-aes-256-gcm");
    expect(store.secretB58).toBeUndefined();
    expect(statSync(keystore).mode & 0o077).toBe(0);
    // No secret anywhere in the output: no long base58 run.
    expect(r.stdout + r.stderr).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{80,}/);
    // The printed env opens the wallet: the server starts on it with the same address.
    const server = run([], r.json.env);
    expect(server).not.toMatch(/EPHEMERAL/);
    expect(server).toContain(r.json.addresses.evm);
  });

  it("AIFINPAY_NONINTERACTIVE=1 selects the same path on a terminal", () => {
    const r = runRaw(["init"], { AIFINPAY_NONINTERACTIVE: "1" }, ["--import", ttyStdin]);
    expect(r.status).toBe(0);
    const json = JSON.parse(r.stdout);
    expect(json.created).toBe(true);
    expect(json.env.AIFINPAY_WALLET_PASSPHRASE).toMatch(PASSPHRASE);
  });

  it("keeps an existing wallet, never reprints its passphrase, and says in one line when the env is missing", () => {
    const first = runJson(["init"]);
    const passphrase = first.json.env.AIFINPAY_WALLET_PASSPHRASE;
    const before = readFileSync(join(home, "agent.json"), "utf8");

    const again = runJson(["init"], { AIFINPAY_WALLET_PASSPHRASE: passphrase });
    expect(again.status).toBe(0);
    expect(again.json).toMatchObject({ created: false, encrypted: true });
    expect(again.json.addresses.evm).toBe(first.json.addresses.evm);
    expect(again.stdout).not.toContain(passphrase);
    expect(again.json.env.AIFINPAY_WALLET_PASSPHRASE).toContain("already set");
    expect(again.json.passphrase_note).toBeUndefined();

    const missing = runJson(["init"]);
    expect(missing.status).toBe(2);
    expect(missing.stdout.trim().split("\n")).toHaveLength(1);
    expect(missing.json).toMatchObject({
      keystore: join(home, "agent.json"),
      missing_env: "AIFINPAY_WALLET_PASSPHRASE",
    });
    expect(missing.json.error).toContain("AIFINPAY_WALLET_PASSPHRASE");
    expect(readFileSync(join(home, "agent.json"), "utf8")).toBe(before);
  });

  // 2.11.0 stopped here: exit 2, a refusal, and no move left that did not touch
  // the keystore. The agent must get one, and the keystore must stay byte-equal.
  it("an existing encrypted keystore without its passphrase: exit 2, untouched, and a new AIFINPAY_HOME as next_step", () => {
    const first = runJson(["init"]);
    const keystore = join(home, "agent.json");
    const before = readFileSync(keystore);

    const locked = runJson(["init"]);
    expect(locked.status).toBe(2);
    expect(locked.json).toMatchObject({ keystore, missing_env: "AIFINPAY_WALLET_PASSPHRASE" });
    expect(readFileSync(keystore).equals(before)).toBe(true);
    expect(locked.json.next_step).toContain(keystore);
    expect(locked.json.next_step).toMatch(/Do not delete, move or overwrite it/);
    const today = new Date().toISOString().slice(0, 10).replace(/-/g, "");
    const command = locked.json.next_step.match(/`(AIFINPAY_HOME='([^']+)' npx @aifinpay\/mcp init)`/);
    expect(command, locked.json.next_step).not.toBeNull();
    const fresh = command[2];
    expect(fresh).toBe(join(homedir(), ".aifinpay", `agent-${today}`));
    // Suggested, not created: init that refused writes nothing anywhere.
    expect(existsSync(fresh)).toBe(false);

    // Following the advice reaches a wallet the server opens, the old one untouched.
    try {
      const created = runJson(["init"], { AIFINPAY_HOME: fresh });
      expect(created.status).toBe(0);
      expect(created.json).toMatchObject({ keystore: join(fresh, "agent.json"), created: true });
      expect(created.json.env.AIFINPAY_HOME).toBe(fresh);
      expect(created.json.addresses.evm).not.toBe(first.json.addresses.evm);
      const server = run([], created.json.env);
      expect(server).not.toMatch(/EPHEMERAL/);
      expect(server).toContain(created.json.addresses.evm);
      expect(readFileSync(keystore).equals(before)).toBe(true);
    } finally {
      rmSync(fresh, { recursive: true, force: true });
    }
  });

  it("without AIFINPAY_HOME, env does not invent one", () => {
    // HOME moves to this test's directory so the default ~/.aifinpay is private to it.
    const r = runJson(["init"], { AIFINPAY_HOME: "", HOME: home });
    expect(r.status).toBe(0);
    expect(r.json.keystore).toBe(join(home, ".aifinpay", "agent.json"));
    expect(Object.keys(r.json.env)).toEqual(["AIFINPAY_WALLET_PASSPHRASE"]);
  });

  it("with --plaintext prints the same JSON with an empty env", () => {
    const r = runJson(["init", "--plaintext"]);
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ created: true, encrypted: false });
    expect(r.json.env).toEqual({ AIFINPAY_HOME: home });
    expect(r.stdout).not.toContain(JSON.parse(readFileSync(join(home, "agent.json"), "utf8")).secretB58);
  });

  it("with a configured seed reports it as JSON and creates nothing", () => {
    const r = runJson(["init"], { SEED_HASH: "11".repeat(32) });
    expect(r.status).toBe(0);
    expect(r.json).toMatchObject({ keystore: null, created: false, source: "SEED_HASH" });
    expect(r.json.env).toEqual({ AIFINPAY_HOME: home });
    expect(r.json.addresses.evm).toMatch(EVM);
    expect(existsSync(join(home, "agent.json"))).toBe(false);
  });

  it("on a terminal, the human path is unchanged: refuses without a passphrase and prints prose", () => {
    const r = runRaw(["init"], {}, ["--import", ttyStdin]);
    expect(r.status).toBe(2);
    expect(r.stdout).toBe("");
    expect(r.stderr).toMatch(/AIFINPAY_WALLET_PASSPHRASE/);
    expect(r.stderr).toMatch(/--plaintext/);
    expect(existsSync(join(home, "agent.json"))).toBe(false);
    const missing = run(["init"], { AIFINPAY_WALLET_PASSPHRASE: "pw" });
    expect(missing).toContain("ENCRYPTED");
    const line = runRaw(["init"], {}, ["--import", ttyStdin]);
    expect(line.status).toBe(2);
    expect(line.stderr.trim().split("\n")).toHaveLength(1);
    expect(line.stderr).toContain("AIFINPAY_WALLET_PASSPHRASE");
  });
});

describe("aifinpay-mcp server", () => {
  it("loads the keystore without AIFINPAY_AGENT_SECRET being set", () => {
    const init = run(["init", "--plaintext"]);
    const expected = init.match(EVM)?.[0];

    // Explicitly blank the env var: the point is that the file alone suffices.
    const server = run([], { AIFINPAY_AGENT_SECRET: "" });

    expect(server).not.toMatch(/EPHEMERAL/);
    expect(server).not.toMatch(/DO NOT FUND/);
    expect(server).toContain(expected!);
  });

  it("still says so plainly when there is no wallet at all", () => {
    // With payments on by default the ephemeral start must still come up
    // (it signs nothing) and say the one way forward, which needs no restart.
    const out = run([], { AIFINPAY_AGENT_SECRET: "" });
    expect(out).toMatch(/EPHEMERAL wallet — DO NOT FUND/);
    expect(out).toMatch(/npx @aifinpay\/mcp init/);
    expect(out).toContain("no restart is needed to pay");
  });

  it("refuses to start when an env limit is above the built-in ceiling, naming the dashboard", () => {
    const r = runRaw([], { AIFINPAY_MAX_USD: "6" });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(
      "AIFINPAY_MAX_USD can only lower the built-in ceiling of 5; set the working limits in the dashboard"
    );
    const daily = runRaw([], { AIFINPAY_DAILY_USD: "21" });
    expect(daily.status).not.toBe(0);
    expect(daily.stderr).toContain("AIFINPAY_DAILY_USD can only lower the built-in ceiling of 20");
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
  // A fresh plaintext wallet may show its recovery key on a TTY. Piped output,
  // repeat init, and encrypted wallets must never expose the secret.

  it("keeps the recovery key out of noninteractive init output", () => {
    const out = run(["init", "--plaintext"]);
    const secret = JSON.parse(readFileSync(join(home, "agent.json"), "utf8")).secretB58 as string;
    expect(out.includes("RECOVERY KEY")).toBe(false);
    expect(out.includes(secret)).toBe(false);
    expect(out).toMatch(EVM);
  });

  it("shows a fresh plaintext recovery key only when stdout reports a TTY", () => {
    const tty = join(home, "tty-fixture.mjs");
    writeFileSync(tty, "Object.defineProperty(process.stdout, 'isTTY', { value: true });\n", {
      mode: 0o600,
    });
    const out = run(["init", "--plaintext"], {}, ["--import", tty]);
    const secret = JSON.parse(readFileSync(join(home, "agent.json"), "utf8")).secretB58 as string;
    // Keep even a failing assertion from printing the captured recovery key.
    expect(out.includes("RECOVERY KEY")).toBe(true);
    expect(out.includes(secret)).toBe(true);
    const second = run(["init", "--plaintext"], {}, ["--import", tty]);
    expect(second.includes("RECOVERY KEY")).toBe(false);
    expect(second.includes(secret)).toBe(false);
  });

  it("does NOT reprint the recovery key on a second init", () => {
    // Shown once means once. A second init keeps the wallet and must not surface
    // the secret again — that would turn "shown once" into "shown every run".
    run(["init", "--plaintext"]);
    const second = run(["init", "--plaintext"]);
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
    const out = run(["init", "--plaintext"]);
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

// ── Following init output to a server that can pay ──────────────────────
//
// 2.3.1 printed env {"AIFINPAY_MAX_USD": "0.10"} and nothing else, so a client
// configured from it never listed payable_fetch. The payment settings were a
// prose line whose gas cap, 0.05 POL, is below the worst case the SDK checks
// before signing at ~280 gwei (~0.10 POL paying in POL, ~0.21 POL in USDC), and
// the config of an encrypted wallet — the default — had no passphrase, so the
// server did not start at all.

const PAYMENT_KEYS = [
  "AIFINPAY_PAYMENTS_ENABLED",
  "AIFINPAY_GATEWAY_ORIGINS",
  "AIFINPAY_GATEWAY_PATH_MODE",
  "AIFINPAY_MAX_USD",
  "AIFINPAY_DAILY_USD",
  "AIFINPAY_MAX_GAS_POL",
  "AIFINPAY_MAX_GAS",
  "AIFINPAY_PAY_CHAIN",
  "AIFINPAY_PAY_ASSET",
  "AIFINPAY_MODE",
];

/** A server configured with exactly this env: its tool names, the payable_fetch
 *  answer and whether the call got past the setup gate to a (stubbed) purchase.
 *  The purchase is stubbed so nothing here touches the network. */
async function serverWith(
  env: Record<string, string>,
  url = "https://other.example/x"
): Promise<{ tools: string[]; payable: any; purchase?: any }> {
  vi.unstubAllEnvs();
  for (const name of [...PAYMENT_KEYS, "AIFINPAY_WALLET_PASSPHRASE"]) vi.stubEnv(name, undefined);
  for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
  const active = await createServer({
    ...loadConfigFromEnv(),
    seedHash: undefined,
    agentsFile: undefined,
    agentSecretB58: undefined,
    walletHome: home,
    logFn: () => {},
  });
  const purchase = vi.spyOn(active.agent, "fetchPaid").mockRejectedValue(new Error("stub: no network"));
  const client = new Client({ name: "init-output-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await active.server.connect(right);
  await client.connect(left);
  try {
    const tools = (await client.listTools()).tools.map((tool) => tool.name);
    const result = await client.callTool({ name: "payable_fetch", arguments: { url } });
    const text = String((result.content as Array<{ text: string }>)[0].text);
    return { tools, payable: { isError: result.isError, text }, purchase: purchase.mock.calls[0]?.[2] };
  } finally {
    await client.close();
    await active.server.close();
  }
}

// 2.12.1 (owner decision 2026-10-20): payments are on by default with a
// built-in $5 / $20 ceiling; the config init prints is all a first payment
// needs, and every env variable is an optional override that only narrows.
describe("aifinpay-mcp init payment settings", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("pays straight from the config init prints: no payment block, any https site, within the ceiling", async () => {
    const [config] = printed(run(["init", "--plaintext"]));
    const env = config.mcpServers.aifinpay.env;
    expect(Object.keys(env)).toEqual(["AIFINPAY_HOME"]);
    const paying = await serverWith(env);
    expect(paying.tools).toContain("payable_fetch");
    expect(paying.tools).toContain("payment_setup_status");
    // Past the setup gate, to the purchase: nothing asked the owner to edit env.
    expect(paying.purchase).toBeDefined();
    expect(paying.purchase).toMatchObject({
      maxAmountUsd: DEFAULT_MAX_USD,
      gatewayOrigins: ["https://other.example"],
      resourcePathMode: "direct",
      paymentIssuer: "https://api.aifinpay.io",
    });
    expect(paying.purchase.v14.maxGasWei).toBe(3n * 10n ** 17n);
  });

  it("with no env at all, payments are on", () => {
    vi.stubEnv("AIFINPAY_PAYMENTS_ENABLED", undefined);
    vi.stubEnv("AIFINPAY_MAX_USD", undefined);
    vi.stubEnv("AIFINPAY_DAILY_USD", undefined);
    vi.stubEnv("AIFINPAY_GATEWAY_ORIGINS", undefined);
    expect(loadConfigFromEnv()).toMatchObject({
      paymentsEnabled: true,
      paymentsByDefault: true,
      maxAmountUsd: 5,
      dailyAmountUsd: 20,
      gatewayOrigins: undefined,
      ownerOverrides: [],
    });
  });

  it("an ephemeral wallet still cannot pay: the checklist, no purchase", async () => {
    const ephemeral = await serverWith({});
    expect(ephemeral.purchase).toBeUndefined();
    expect(ephemeral.payable.isError).toBe(true);
    const status = JSON.parse(ephemeral.payable.text);
    expect(status.payments_enabled).toBe(true);
    expect(status.wallet.persistent).toBe(false);
    expect(status.next_step).toContain("npx @aifinpay/mcp init");
    expect(status.error).toContain("nothing was signed or paid");
  });

  it("AIFINPAY_PAYMENTS_ENABLED=0 turns payments off: the checklist names it, no purchase", async () => {
    const [config] = printed(run(["init", "--plaintext"]));
    const off = await serverWith({ ...config.mcpServers.aifinpay.env, AIFINPAY_PAYMENTS_ENABLED: "0" });
    expect(off.tools).toContain("payable_fetch");
    expect(off.purchase).toBeUndefined();
    const status = JSON.parse(off.payable.text);
    expect(status.payments_enabled).toBe(false);
    expect(status.next_step).toContain("AIFINPAY_PAYMENTS_ENABLED=0");
  });

  it("env lowers the ceiling, and the lower number is what the purchase may spend", async () => {
    const [config] = printed(run(["init", "--plaintext"]));
    const lower = await serverWith({
      ...config.mcpServers.aifinpay.env,
      AIFINPAY_MAX_USD: "2",
      AIFINPAY_DAILY_USD: "3",
    });
    expect(lower.purchase).toMatchObject({ maxAmountUsd: 2 });
  });

  it("env above the ceiling is refused with the dashboard hint, never clipped", async () => {
    const [config] = printed(run(["init", "--plaintext"]));
    await expect(serverWith({ ...config.mcpServers.aifinpay.env, AIFINPAY_MAX_USD: "6" })).rejects.toThrow(
      "AIFINPAY_MAX_USD can only lower the built-in ceiling of 5; set the working limits in the dashboard"
    );
    await expect(serverWith({ ...config.mcpServers.aifinpay.env, AIFINPAY_DAILY_USD: "100" })).rejects.toThrow(
      "AIFINPAY_DAILY_USD can only lower the built-in ceiling of 20"
    );
  });

  it("an owner origin allowlist narrows: an unlisted site is refused by name before any purchase", async () => {
    const [config] = printed(run(["init", "--plaintext"]));
    const env = { ...config.mcpServers.aifinpay.env, AIFINPAY_GATEWAY_ORIGINS: "https://listed.example" };
    const refused = await serverWith(env);
    expect(refused.purchase).toBeUndefined();
    expect(refused.payable.text).toContain("https://other.example is not an owner-approved site");
    const listed = await serverWith(env, "https://listed.example/x");
    expect(listed.purchase).toMatchObject({ gatewayOrigins: ["https://listed.example"] });
  });

  it("the optional block init prints leaves room for the worst-case gas at ~280 gwei", () => {
    const [, overrides] = printed(run(["init", "--plaintext"]));
    expect(Object.keys(overrides)).toEqual(["AIFINPAY_GATEWAY_ORIGINS", "AIFINPAY_MAX_GAS_POL"]);
    expect(Number(overrides.AIFINPAY_MAX_GAS_POL)).toBeGreaterThanOrEqual(0.21);
    expect(overrides.AIFINPAY_MAX_GAS_POL).toBe(DEFAULT_MAX_GAS_POL);
    expect(DEFAULT_MAX_USD).toBeGreaterThan(0.1);
    expect(DEFAULT_DAILY_USD).toBeGreaterThanOrEqual(DEFAULT_MAX_USD);
  });

  it("init's prose says payments are on and asks for no env", () => {
    const out = run(["init", "--plaintext"]);
    expect(out).toContain("Payments are on");
    expect(out).toContain("none of it is needed for a first payment");
    expect(out).not.toContain("As printed it cannot pay");
    expect(out).not.toContain('"AIFINPAY_PAYMENTS_ENABLED": "1"');
  });

  it("gives an encrypted wallet's config the passphrase variable, never the passphrase", () => {
    const pass = { AIFINPAY_WALLET_PASSPHRASE: "fixture-passphrase" };
    for (const out of [run(["init"], pass), run(["init"], pass)]) {
      const [config] = printed(out);
      expect(Object.keys(config.mcpServers.aifinpay.env)).toEqual(["AIFINPAY_HOME", "AIFINPAY_WALLET_PASSPHRASE"]);
      expect(out.includes(pass.AIFINPAY_WALLET_PASSPHRASE)).toBe(false);
    }
  });

  it("gives a plaintext wallet's config no passphrase", () => {
    const [config] = printed(run(["init", "--plaintext"]));
    expect(config.mcpServers.aifinpay.env).toEqual({ AIFINPAY_HOME: home });
  });
});

describe("README, as npm shows it", () => {
  it("shows the optional override block init prints", () => {
    const section = README.slice(README.indexOf("## Optional payment overrides"));
    const block = section.match(/```json\n([\s\S]*?)\n```/);
    expect(block, "README lost its override example").not.toBeNull();
    const [, overrides] = printed(run(["init", "--plaintext"]));
    expect(JSON.parse(block![1])).toEqual(overrides);
  });
});
