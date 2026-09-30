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
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { loadConfigFromEnv } from "../src/config.js";

const BIN = fileURLToPath(new URL("../bin/aifinpay-mcp.js", import.meta.url));
const README = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const VERSION: string = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aifp-mcp-"));
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

function run(args: string[], extraEnv: Record<string, string> = {}, nodeArgs: string[] = []): string {
  const r = spawnSync(process.execPath, [...nodeArgs, BIN, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    cwd: home,
    input: "", // stdio server would otherwise wait forever
    env: isolatedEnv(extraEnv),
  });
  if (r.error) throw r.error;
  if (r.status !== 0) {
    throw Object.assign(new Error(`exited ${r.status}: ${r.stderr}`), { status: r.status });
  }
  return (r.stdout ?? "") + (r.stderr ?? "");
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

  it("pins the printed MCP config to the version that initialized the wallet", () => {
    const [config] = printed(run(["init", "--plaintext"]));
    expect(config.mcpServers.aifinpay.command).toBe("npx");
    expect(config.mcpServers.aifinpay.args).toEqual(["-y", `@aifinpay/mcp@${VERSION}`]);
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
        const child = spawn(process.execPath, ["--import", barrier, BIN, "init", "--plaintext"], {
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
  "AIFINPAY_PAY_ASSET",
  "AIFINPAY_MODE",
];

/** Tool names a server configured with exactly this env lists. */
async function toolsWith(env: Record<string, string>): Promise<string[]> {
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
  const client = new Client({ name: "init-output-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await active.server.connect(right);
  await client.connect(left);
  try {
    return (await client.listTools()).tools.map((tool) => tool.name);
  } finally {
    await client.close();
    await active.server.close();
  }
}

describe("aifinpay-mcp init payment settings", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("registers payable_fetch once its payment block is added to the printed env", async () => {
    const [config, payment] = printed(run(["init", "--plaintext"]));
    const env = config.mcpServers.aifinpay.env;
    expect(await toolsWith(env)).not.toContain("payable_fetch");
    expect(await toolsWith({ ...env, ...payment })).toContain("payable_fetch");
  });

  it("leaves room above the smallest batch and for the worst-case gas at ~280 gwei", () => {
    const [, payment] = printed(run(["init", "--plaintext"]));
    expect(Number(payment.AIFINPAY_MAX_USD)).toBeGreaterThan(0.1);
    expect(Number(payment.AIFINPAY_MAX_GAS_POL)).toBeGreaterThanOrEqual(0.21);
  });

  it("gives an encrypted wallet's config the passphrase variable, never the passphrase", () => {
    const pass = { AIFINPAY_WALLET_PASSPHRASE: "fixture-passphrase" };
    for (const out of [run(["init"], pass), run(["init"], pass)]) {
      const [config] = printed(out);
      expect(Object.keys(config.mcpServers.aifinpay.env)).toEqual(["AIFINPAY_WALLET_PASSPHRASE"]);
      expect(out.includes(pass.AIFINPAY_WALLET_PASSPHRASE)).toBe(false);
    }
  });

  it("gives a plaintext wallet's config no passphrase", () => {
    const [config] = printed(run(["init", "--plaintext"]));
    expect(config.mcpServers.aifinpay.env).toEqual({});
  });
});

describe("README, as npm shows it", () => {
  it("shows the payment block init prints", () => {
    const section = README.slice(README.indexOf("## Enable native paid GET requests"));
    const block = section.match(/```json\n([\s\S]*?)\n```/);
    expect(block, "README lost its payment example").not.toBeNull();
    const [, payment] = printed(run(["init", "--plaintext"]));
    expect(JSON.parse(block![1])).toEqual(payment);
  });

  it("names this release", () => {
    // 2.3.1 was published saying "Version **2.2.4**".
    expect(README).toContain(`Version **${VERSION}**`);
    for (const [pinned] of README.matchAll(/@aifinpay\/mcp@\d+\.\d+\.\d+/g)) {
      expect(pinned).toBe(`@aifinpay/mcp@${VERSION}`);
    }
  });
});
