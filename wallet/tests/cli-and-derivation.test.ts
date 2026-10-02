// The wallet CLI and derivation, exercised the way a user meets them.
//
// Every CLI test runs the real `run()` against a throwaway AIFINPAY_HOME (and a
// throwaway HOME as a backstop, so homedir() can never reach a real keystore),
// with process.exit turned into a thrown error: the CLI exits on several paths,
// and an exit that merely returned would let `new` carry on past "Refusing" and
// overwrite the keystore it just refused to touch.
//
// Tests written as `it.fails` describe correct behaviour the package does not
// have today. Each is a real bug, listed in the change that adds it and not
// fixed there; when one is fixed its test starts passing, which `it.fails`
// reports as a failure so the marker is removed.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { deriveWallet, newWallet, walletFromSeed, walletFromSolanaSecret } from "../src/index.js";
import { generateStrongPassphrase, run } from "../src/cli.js";

const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

// ── Known answers from the full SDK ──────────────────────────────────────────
//
// Computed with @aifinpay/agent 2.3.0 built from node/ in this repository
// (AiFinPayAgent.fromSeed / .fromSolanaSecret, which use viem and tweetnacl —
// an implementation independent of this package's @noble code). The wallet
// package does not install the SDK, so the byte-identity test in
// wallet.test.ts skips in CI; these vectors keep that promise checked.
const SDK = {
  ["11".repeat(32)]: {
    solana: "F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4",
    evm: "0x467aeE37983Eb1d4aa98e837e7D621bD71Af0F48",
    casper: "account-hash-30e600ae3e6e66b6637581eebd823cbe9b9ffea1950db27655e4cd66c1aa1c37",
  },
  ["ab".repeat(32)]: {
    solana: "3TeRu8UfgdkNi3D8c9o6QntCtuEpoPMb2WDu1d7tmptw",
    evm: "0xf04Aa0d4EC1440Db063a8510d9cd8F861D44898f",
    casper: "account-hash-7ddc3b976b25f87ca175f8f28ddb65020858c57ac7890baab241990d980c9727",
  },
} as Record<string, { solana: string; evm: string; casper: string }>;

// What @aifinpay/agent 2.3.0 AiFinPayAgent.fromSolanaSecret — the call
// @aifinpay/mcp makes on agent.json's secretB58 (mcp/src/identity.ts,
// mcp/src/server.ts) — derives from the keystore that `wallet new` writes for
// seed 0x11…11 in the default ("standard") mode.
const SDK_LOADS_STANDARD_KEYSTORE_11 = {
  evm: "0xd2F2331ff1636087e98c0A3A6bf4a360cE8716d6",
  casper: "account-hash-b4c6cb67cf9ced4418e0ab4656cba9d09c527ad0879edc3d74316fb3fde29c9a",
};

/** The EVM address @aifinpay/agent/@aifinpay/mcp derive from a keystore's secretB58:
 *  secp256k1(SHA-256("aifinpay:evm:v1\0" || secret[0..32])) — i.e. the secret's
 *  first 32 bytes treated as the seed. Pinned against the SDK below. */
function evmMcpWouldUse(secretB58: string): string {
  return deriveWallet(hex(bs58.decode(secretB58).slice(0, 32)), { mode: "legacy-solana" }).evmAddress;
}

describe("derivation agrees with @aifinpay/agent", () => {
  for (const [seed, sdk] of Object.entries(SDK)) {
    it(`legacy-solana mode reproduces the SDK's addresses for seed ${seed.slice(0, 4)}…`, () => {
      const w = deriveWallet(seed, { mode: "legacy-solana" });
      expect({ solana: w.solanaAddress, evm: w.evmAddress, casper: w.casperAddress }).toEqual(sdk);
    });

    it(`EVM and Casper do not depend on the Solana mode, for seed ${seed.slice(0, 4)}…`, () => {
      const w = deriveWallet(seed);
      expect([w.evmAddress, w.casperAddress]).toEqual([sdk.evm, sdk.casper]);
    });
  }

  it("evmMcpWouldUse() is the SDK's rule, not a guess", () => {
    const secret = deriveWallet("11".repeat(32)).keys.solanaSecretKeyB58;
    expect(evmMcpWouldUse(secret)).toBe(SDK_LOADS_STANDARD_KEYSTORE_11.evm);
  });

  it("the EVM address is EIP-55 checksummed", () => {
    // Mixed case is the checksum; an all-lowercase address would still be valid
    // hex and silently lose the typo protection wallets rely on.
    const { evmAddress } = deriveWallet("11".repeat(32));
    expect(evmAddress).toBe("0x467aeE37983Eb1d4aa98e837e7D621bD71Af0F48");
    expect(evmAddress).not.toBe(evmAddress.toLowerCase());
  });
});

describe("seed and secret input", () => {
  const seed = "ab".repeat(32);

  it("accepts a 0x prefix and upper case as the same seed", () => {
    const w = deriveWallet(seed);
    expect(deriveWallet(`0x${seed}`)).toEqual(w);
    expect(deriveWallet(seed.toUpperCase())).toEqual(w);
  });

  it.each([
    ["63 hex characters", "a".repeat(63)],
    ["65 hex characters", "a".repeat(65)],
    ["non-hex characters", "zz".repeat(32)],
    ["an empty string", ""],
    ["a 0x prefix alone", "0x"],
  ])("refuses %s", (_label, bad) => {
    expect(() => deriveWallet(bad)).toThrow("seed must be 32 bytes");
  });

  it("walletFromSeed is deriveWallet", () => {
    expect(walletFromSeed(seed)).toEqual(deriveWallet(seed));
    expect(walletFromSeed(seed, { mode: "legacy-solana" })).toEqual(deriveWallet(seed, { mode: "legacy-solana" }));
  });

  it("walletFromSolanaSecret refuses the standard mode, whose secret is not the seed", () => {
    const secret = deriveWallet(seed).keys.solanaSecretKeyB58;
    expect(() => walletFromSolanaSecret(secret)).toThrow("only supports legacy-solana");
  });

  it("walletFromSolanaSecret refuses something that is not base58", () => {
    expect(() => walletFromSolanaSecret("0OIl", { mode: "legacy-solana" })).toThrow();
  });

  it("newWallet gives a different wallet each time, recoverable from its seed", async () => {
    const [a, b] = await Promise.all([newWallet(), newWallet()]);
    expect(a.keys.seedHex).not.toBe(b.keys.seedHex);
    expect(walletFromSeed(a.keys.seedHex)).toEqual(a);
  });
});

// ── the CLI ─────────────────────────────────────────────────────────────────

class Exit extends Error {
  constructor(readonly code: number) {
    super(`process.exit(${code})`);
  }
}

const STRONG = "Correct-Horse-Battery-9";
let root: string;
let out: string[];
let err: string[];
const saved = {
  AIFINPAY_HOME: process.env.AIFINPAY_HOME,
  AIFINPAY_WALLET_PASSPHRASE: process.env.AIFINPAY_WALLET_PASSPHRASE,
  HOME: process.env.HOME,
};

const home = () => process.env.AIFINPAY_HOME!;
const keystorePath = () => join(home(), "agent.json");
const keystore = () => JSON.parse(readFileSync(keystorePath(), "utf8"));
const mode = (path: string) => statSync(path).mode & 0o777;
const printed = (label: string) => out.join("").match(new RegExp(`^\\s+${label}\\s+(\\S+)\\s*$`, "m"))?.[1];

function restoreEnv(name: keyof typeof saved) {
  if (saved[name] === undefined) delete process.env[name];
  else process.env[name] = saved[name];
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "aifp-wallet-cli-"));
  process.env.HOME = root;
  process.env.AIFINPAY_HOME = join(root, ".aifinpay"); // not created: the CLI must create it
  delete process.env.AIFINPAY_WALLET_PASSPHRASE;
  out = [];
  err = [];
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => (out.push(String(chunk)), true));
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: unknown) => (err.push(String(chunk)), true));
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Exit(code ?? 0);
  }) as never);
});

afterEach(() => {
  vi.restoreAllMocks();
  restoreEnv("AIFINPAY_HOME");
  restoreEnv("AIFINPAY_WALLET_PASSPHRASE");
  restoreEnv("HOME");
  rmSync(root, { recursive: true, force: true });
});

describe("wallet new --plain", () => {
  it("creates an owner-only keystore in an owner-only directory", async () => {
    await run("new", ["node", "wallet", "--plain"]);
    expect(mode(home())).toBe(0o700);
    expect(mode(keystorePath())).toBe(0o600);
    expect(out.join("")).toContain(`Created ${keystorePath()} (mode 600)`);
    expect(readFileSync(join(home(), ".aiignore"), "utf8")).toMatch(/^agent\.json$/m);
  });

  it("show and export report the wallet the keystore holds", async () => {
    await run("new", ["node", "wallet", "--plain"]);
    const store = keystore();
    const expected = walletFromSeed(store.seedHex);
    out = [];
    await run("show", []);
    expect(printed("EVM")).toBe(expected.evmAddress);
    expect(printed("Solana")).toBe(expected.solanaAddress);
    expect(printed("Casper")).toBe(expected.casperAddress);
    out = [];
    await run("export", []);
    expect(out.join("")).toBe(`${store.seedHex}\n`);
  });

  it("--legacy-solana writes a keystore the full SDK derives the same addresses from", async () => {
    await run("new", ["node", "wallet", "--plain", "--legacy-solana"]);
    const store = keystore();
    expect(store.derivationMode).toBe("legacy-solana");
    expect(evmMcpWouldUse(store.secretB58)).toBe(printed("EVM"));
  });
});

describe("wallet new refuses to overwrite", () => {
  it("an existing keystore, leaving it byte for byte", async () => {
    await run("new", ["node", "wallet", "--plain"]);
    const before = readFileSync(keystorePath());
    await expect(run("new", ["node", "wallet", "--plain"])).rejects.toEqual(new Exit(1));
    expect(err.join("")).toContain("Refusing");
    expect(readFileSync(keystorePath()).equals(before)).toBe(true);
  });

  // W3. readStore() returns null for a file it cannot parse or does not
  // recognise, and create() then writes a new keystore over it. A keystore from
  // a newer release, a hand-edited one, or one truncated by a full disk "may
  // hold funds" exactly as much as a valid one.
  it.fails("an agent.json it cannot read (W3)", async () => {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const unknown = JSON.stringify({ version: 3, crypto: { cipher: "aes-128-ctr" } });
    writeFileSync(keystorePath(), unknown, { mode: 0o600 });
    await expect(run("new", ["node", "wallet", "--plain"])).rejects.toEqual(new Exit(1));
    expect(readFileSync(keystorePath(), "utf8")).toBe(unknown);
  });
});

describe("encrypted keystores", () => {
  it.each([
    ["too short", "Ab1!"],
    ["no upper case", "correct-horse-battery-9"],
    ["no digit", "Correct-Horse-Battery"],
    ["no allowed special character", "CorrectHorseBattery9#"],
  ])("refuse a weak passphrase (%s) and write no keystore", async (_why, weak) => {
    process.env.AIFINPAY_WALLET_PASSPHRASE = weak;
    await expect(run("new", ["node", "wallet"])).rejects.toThrow(/AIFINPAY_WALLET_PASSPHRASE must/);
    expect(existsSync(keystorePath())).toBe(false);
  });

  it("open with the right passphrase and refuse a wrong one", async () => {
    process.env.AIFINPAY_WALLET_PASSPHRASE = STRONG;
    await run("new", ["node", "wallet"]);
    expect(keystore().enc).toBe("scrypt-aes-256-gcm");
    const evm = printed("EVM");
    out = [];
    await run("show", []);
    expect(printed("EVM")).toBe(evm);

    process.env.AIFINPAY_WALLET_PASSPHRASE = "Another-Strong-Pass-1";
    await expect(run("show", [])).rejects.toThrow();
    delete process.env.AIFINPAY_WALLET_PASSPHRASE;
    await expect(run("show", [])).rejects.toThrow("AIFINPAY_WALLET_PASSPHRASE is required");
  });

  it("an encrypted legacy-solana wallet opens to the addresses it was created with", async () => {
    process.env.AIFINPAY_WALLET_PASSPHRASE = STRONG;
    await run("new", ["node", "wallet"], { mode: "legacy-solana" });
    expect(keystore().derivationMode).toBe("legacy-solana");
    const created = [printed("EVM"), printed("Solana")];
    out = [];
    await run("show", []);
    expect([printed("EVM"), printed("Solana")]).toEqual(created);
  });

  it("a generated passphrase is stored owner-only, in both places, identically", async () => {
    await run("new", ["node", "wallet"]);
    const secretFile = join(home(), "secrets", "passphrase");
    const envFile = join(home(), ".env");
    expect(mode(secretFile)).toBe(0o600);
    expect(mode(join(home(), "secrets"))).toBe(0o700);
    expect(mode(envFile)).toBe(0o600);
    const passphrase = readFileSync(secretFile, "utf8");
    expect(readFileSync(envFile, "utf8")).toContain(`AIFINPAY_WALLET_PASSPHRASE=${passphrase}\n`);
    expect(keystore().enc).toBe("scrypt-aes-256-gcm");
  });

  // W2. The keystore is encrypted, and next to the ciphertext sits seedHex in
  // plaintext (cli.ts create()). The seed derives every key, so anyone who can
  // read agent.json has the wallet; the passphrase protects nothing.
  it.fails("do not store the seed in plaintext (W2)", async () => {
    process.env.AIFINPAY_WALLET_PASSPHRASE = STRONG;
    await run("new", ["node", "wallet"]);
    out = [];
    await run("export", []);
    const seed = out.join("").trim();
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(keystorePath(), "utf8")).not.toContain(seed);
  });

  // W2, as a user sees it: `export` prints the seed of an encrypted keystore
  // without asking for the passphrase.
  it.fails("do not export the seed without the passphrase (W2)", async () => {
    process.env.AIFINPAY_WALLET_PASSPHRASE = STRONG;
    await run("new", ["node", "wallet"]);
    delete process.env.AIFINPAY_WALLET_PASSPHRASE;
    out = [];
    await expect(run("export", [])).rejects.toThrow();
    expect(out.join("")).not.toMatch(/[0-9a-f]{64}/);
  });

  // W4. generateStrongPassphrase() draws 32 characters from the allowed set
  // without guaranteeing one of each class; validatePassphrase() requires all
  // four. About 3–4% of generated passphrases lack a digit or a special
  // character — the CLI then refuses the passphrase it wrote to ~/.aifinpay/.env,
  // and the owner cannot open their own wallet with it.
  it.fails("accept every passphrase the CLI itself generates (W4)", async () => {
    const allClasses = (p: string) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[!@$.^*_+=-]/.test(p);
    let candidate: string | undefined;
    for (let i = 0; i < 5000 && !candidate; i++) {
      const p = generateStrongPassphrase();
      if (!allClasses(p)) candidate = p;
    }
    if (!candidate) return; // every sampled passphrase had all four classes
    process.env.AIFINPAY_WALLET_PASSPHRASE = candidate;
    await run("new", ["node", "wallet"]);
    expect(keystore().enc).toBe("scrypt-aes-256-gcm");
  });

  // W8. savePassphraseToEnv() filters the old passphrase line out of .env and
  // then APPENDS the whole filtered content to the same file: every existing
  // line is duplicated and the old AIFINPAY_WALLET_PASSPHRASE line stays.
  it.fails("keep other .env lines exactly once when saving a generated passphrase (W8)", async () => {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    writeFileSync(join(home(), ".env"), "OPENAI_BASE_URL=https://example.test\n", { mode: 0o600 });
    await run("new", ["node", "wallet"]);
    const lines = readFileSync(join(home(), ".env"), "utf8").trim().split("\n");
    expect(lines.filter((l) => l.startsWith("OPENAI_BASE_URL=")).length).toBe(1);
    expect(lines.filter((l) => l.startsWith("AIFINPAY_WALLET_PASSPHRASE=")).length).toBe(1);
  });
});

describe("interoperability with @aifinpay/mcp", () => {
  // W1. In the default ("standard") mode the Solana key is derived from
  // SHA-256("aifinpay:solana:v1\0" || seed), and that key is what the CLI
  // stores as secretB58. @aifinpay/mcp reads only secretB58 and derives the EVM
  // and Casper keys from its first 32 bytes, so it runs the agent at a different
  // EVM address from the one this CLI printed — and told the owner to fund.
  it.fails("the EVM address `new` prints is the one MCP loads from the keystore (W1)", async () => {
    await run("new", ["node", "wallet", "--plain"]);
    expect(evmMcpWouldUse(keystore().secretB58)).toBe(printed("EVM"));
  });

  // W7. `npx @aifinpay/mcp init` writes { secretB58, created } — no seedHex and
  // no derivationMode (mcp/bin/aifinpay-mcp.js). The wallet CLI defaults such a
  // file to "standard" mode, which needs seedHex, and refuses to show it.
  it.fails("show reads a keystore written by `npx @aifinpay/mcp init` (W7)", async () => {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const secretB58 = deriveWallet("11".repeat(32), { mode: "legacy-solana" }).keys.solanaSecretKeyB58;
    writeFileSync(keystorePath(), JSON.stringify({ secretB58, created: "2026-09-01T00:00:00.000Z" }), { mode: 0o600 });
    await run("show", []);
    expect(printed("EVM")).toBe(SDK["11".repeat(32)].evm);
  });
});

describe("CLI errors", () => {
  it("show and export without a wallet exit 1 and say how to make one", async () => {
    await expect(run("show", [])).rejects.toEqual(new Exit(1));
    await expect(run("export", [])).rejects.toEqual(new Exit(1));
    expect(err.join("")).toMatch(/npx @aifinpay\/wallet new/);
  });

  it("an unknown or empty command exits 2", async () => {
    await expect(run("rm", [])).rejects.toEqual(new Exit(2));
    await expect(run("", [])).rejects.toEqual(new Exit(2));
  });

  it("warns when the keystore is readable by others", async () => {
    await run("new", ["node", "wallet", "--plain"]);
    chmodSync(keystorePath(), 0o644);
    err = [];
    await run("show", []);
    expect(err.join("")).toContain(`chmod 600 ${keystorePath()}`);
  });
});

describe("the library", () => {
  // W5. cli.ts handles --help at module load (print, process.exit(0)), and
  // index.ts re-exports run from cli.ts. So any program that imports
  // @aifinpay/wallet and was itself started with `--help`, `-h` or `help` as its
  // first argument prints the wallet's help and exits.
  it.fails("importing @aifinpay/wallet never exits the host process (W5)", async () => {
    const argv = process.argv;
    process.argv = [argv[0], "/usr/local/bin/some-agent", "--help"];
    vi.resetModules();
    try {
      await expect(import("../src/index.js")).resolves.toHaveProperty("deriveWallet");
    } finally {
      process.argv = argv;
    }
  });
});
