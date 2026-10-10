// The wallet CLI and derivation, exercised the way a user meets them.
//
// Every CLI test runs the real `run()` against a throwaway AIFINPAY_HOME (and a
// throwaway HOME as a backstop, so homedir() can never reach a real keystore),
// with process.exit turned into a thrown error: the CLI exits on several paths,
// and an exit that merely returned would let `new` carry on past "Refusing" and
// overwrite the keystore it just refused to touch.
//
// The bugs the coverage pass found (AiFinPay/sdk#96) are fixed and pinned
// here, each labelled W1–W8. W1 is still `it.fails`: fixing it changes how a
// new wallet derives its keys, which is a decision for a human, not a test.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, mkdirSync } from "node:fs";
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import bs58 from "bs58";
import { DerivationDomain, deriveWallet, newWallet, walletFromSeed, walletFromSolanaSecret } from "../src/index.js";
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

    it(`preserves deprecated Casper material in both modes, for seed ${seed.slice(0, 4)}…`, () => {
      const standard = deriveWallet(seed);
      const legacy = deriveWallet(seed, { mode: "legacy-solana" });
      expect(DerivationDomain.CASPER).toBe("aifinpay:casper:v1\0");
      expect(standard.casperAddress).toBe(sdk.casper);
      expect(standard.casperPublicKey).toBe(legacy.casperPublicKey);
      expect(standard.keys.casperSecretSeedHex).toBe(legacy.keys.casperSecretSeedHex);
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
    expect(out.join("")).not.toMatch(/casper/i);
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

describe("deprecated Casper is not advertised by the CLI", () => {
  it.each([
    ["standard", true],
    ["standard", false],
    ["legacy-solana", true],
    ["legacy-solana", false],
  ] as const)("new and show omit Casper (%s, plain=%s)", async (derivationMode, plain) => {
    process.env.AIFINPAY_WALLET_PASSPHRASE = STRONG;
    const argv = plain ? ["node", "wallet", "--plain"] : ["node", "wallet"];
    await run("new", argv, { mode: derivationMode });
    expect(out.join("")).not.toMatch(/casper/i);
    const created = [printed("EVM"), printed("Solana")];
    expect(created.every(Boolean)).toBe(true);
    out = [];
    await run("show", []);
    expect(out.join("")).not.toMatch(/casper/i);
    expect([printed("EVM"), printed("Solana")]).toEqual(created);
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

  // W3. A keystore from a newer release, a hand-edited one, or one truncated by
  // a full disk "may hold funds" exactly as much as a valid one.
  it("an agent.json it cannot read (W3)", async () => {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const unknown = JSON.stringify({ version: 3, crypto: { cipher: "aes-128-ctr" } });
    writeFileSync(keystorePath(), unknown, { mode: 0o600 });
    await expect(run("new", ["node", "wallet", "--plain"])).rejects.toEqual(new Exit(1));
    expect(readFileSync(keystorePath(), "utf8")).toBe(unknown);
  });

  it("an encrypted agent.json in a scheme this version does not know (W3)", async () => {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const future = JSON.stringify({ enc: "argon2id-xchacha20", ct: "AAAA" });
    writeFileSync(keystorePath(), future, { mode: 0o600 });
    process.env.AIFINPAY_WALLET_PASSPHRASE = STRONG;
    await expect(run("show", [])).rejects.toThrow("is not a keystore this version can read");
    await expect(run("new", ["node", "wallet"])).rejects.toEqual(new Exit(1));
    expect(readFileSync(keystorePath(), "utf8")).toBe(future);
  });

  it("show and export say an unreadable agent.json is not a keystore, not that there is no wallet (W3)", async () => {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    writeFileSync(keystorePath(), "{ truncated", { mode: 0o600 });
    await expect(run("show", [])).rejects.toThrow("is not a keystore this version can read");
    await expect(run("export", [])).rejects.toThrow("is not a keystore this version can read");
    expect(err.join("")).not.toContain("wallet new");
    expect(readFileSync(keystorePath(), "utf8")).toBe("{ truncated");
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

  // W2. The seed derives every key: stored in the clear next to the ciphertext,
  // anyone who can read agent.json has the wallet and the passphrase protects
  // nothing.
  it("do not store the seed in plaintext (W2)", async () => {
    process.env.AIFINPAY_WALLET_PASSPHRASE = STRONG;
    await run("new", ["node", "wallet"]);
    out = [];
    await run("export", []);
    const seed = out.join("").trim();
    expect(seed).toMatch(/^[0-9a-f]{64}$/);
    expect(readFileSync(keystorePath(), "utf8")).not.toContain(seed);
  });

  // W2, as a user sees it: `export` must not print an encrypted keystore's seed
  // without the passphrase.
  it("do not export the seed without the passphrase (W2)", async () => {
    process.env.AIFINPAY_WALLET_PASSPHRASE = STRONG;
    await run("new", ["node", "wallet"]);
    delete process.env.AIFINPAY_WALLET_PASSPHRASE;
    out = [];
    await expect(run("export", [])).rejects.toThrow();
    expect(out.join("")).not.toMatch(/[0-9a-f]{64}/);
  });

  // W4. validatePassphrase() requires all four character classes; a generator
  // that does not guarantee them wrote passphrases (~3–4%) the CLI then refused,
  // and the owner could not open their own wallet. "$" is excluded because the
  // passphrase is saved to a .env file a shell may `source`.
  it("generate only passphrases the CLI itself accepts, without a shell-expanded $ (W4)", () => {
    const allClasses = (p: string) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[!@$.^*_+=-]/.test(p);
    const sample = Array.from({ length: 5000 }, () => generateStrongPassphrase());
    expect(sample.filter((p) => !allClasses(p))).toEqual([]);
    expect(sample.filter((p) => p.includes("$"))).toEqual([]);
    expect(sample.every((p) => p.length === 32)).toBe(true);
  });

  // W8. The filtered .env content was appended to the file it came from, so
  // every existing line was duplicated and the old passphrase line stayed.
  it("keep other .env lines exactly once when saving a generated passphrase (W8)", async () => {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    writeFileSync(join(home(), ".env"), "OPENAI_BASE_URL=https://example.test\n", { mode: 0o600 });
    await run("new", ["node", "wallet"]);
    const lines = readFileSync(join(home(), ".env"), "utf8").trim().split("\n");
    expect(lines.filter((l) => l.startsWith("OPENAI_BASE_URL=")).length).toBe(1);
    expect(lines.filter((l) => l.startsWith("AIFINPAY_WALLET_PASSPHRASE=")).length).toBe(1);
  });
});

/** The key @aifinpay/mcp derives from AIFINPAY_WALLET_PASSPHRASE (mcp/src/identity.ts). */
const mcpKey = (passphrase: string, salt: string) =>
  scryptSync(passphrase, Buffer.from(salt, "base64"), 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });

/** What @aifinpay/mcp decrypts from an encrypted agent.json: `ct`, and nothing else. */
function mcpDecrypts(store: { salt: string; iv: string; tag: string; ct: string }, passphrase: string): string {
  const decipher = createDecipheriv("aes-256-gcm", mcpKey(passphrase, store.salt), Buffer.from(store.iv, "base64"));
  decipher.setAuthTag(Buffer.from(store.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(store.ct, "base64")), decipher.final()]).toString("utf8");
}

/** An encrypted keystore exactly as @aifinpay/wallet 1.1.0 wrote it: the
 *  Solana secret sealed, the seed next to it in the clear. */
function wallet110Keystore(seedHex: string, passphrase: string) {
  const w = deriveWallet(seedHex);
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", mcpKey(passphrase, salt.toString("base64")), iv);
  const ct = Buffer.concat([cipher.update(w.keys.solanaSecretKeyB58, "utf8"), cipher.final()]);
  return {
    enc: "scrypt-aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
    created: "2026-09-20T00:00:00.000Z",
    derivationMode: "standard",
    seedHex,
  };
}

describe("the encrypted keystore format", () => {
  it.each([
    ["standard", []],
    ["legacy-solana", ["--legacy-solana"]],
  ])("keeps ct the Solana secret MCP decrypts (%s)", async (_mode, flags) => {
    process.env.AIFINPAY_WALLET_PASSPHRASE = STRONG;
    await run("new", ["node", "wallet", ...flags]);
    out = [];
    await run("export", []);
    const seed = out.join("").trim();
    const store = keystore();
    const w = deriveWallet(seed, { mode: store.derivationMode });
    expect(mcpDecrypts(store, STRONG)).toBe(w.keys.solanaSecretKeyB58);
    // A legacy-solana seed IS the Solana key, so only standard needs it sealed.
    expect("seedCt" in store).toBe(store.derivationMode === "standard");
    expect(store.seedHex).toBeUndefined();
  });

  it("still opens a 1.1.0 keystore, and warns that its seed is in the clear", async () => {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const seed = "ab".repeat(32);
    writeFileSync(keystorePath(), JSON.stringify(wallet110Keystore(seed, STRONG)), { mode: 0o600 });
    process.env.AIFINPAY_WALLET_PASSPHRASE = STRONG;
    await run("show", []);
    expect(printed("EVM")).toBe(SDK[seed].evm);
    expect(err.join("")).toMatch(/stores the seed unencrypted/);
    out = [];
    await run("export", []);
    expect(out.join("")).toBe(`${seed}\n`);

    delete process.env.AIFINPAY_WALLET_PASSPHRASE;
    out = [];
    await expect(run("export", [])).rejects.toThrow("AIFINPAY_WALLET_PASSPHRASE is required");
    expect(out.join("")).toBe("");
  });

  it("refuses a 1.1.0 keystore whose plaintext seed was swapped", async () => {
    // The plaintext seed sits outside the GCM tag. Trusting it would show — and
    // invite funding of — an address the sealed key does not control.
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const store = { ...wallet110Keystore("ab".repeat(32), STRONG), seedHex: "11".repeat(32) };
    writeFileSync(keystorePath(), JSON.stringify(store), { mode: 0o600 });
    process.env.AIFINPAY_WALLET_PASSPHRASE = STRONG;
    await expect(run("show", [])).rejects.toThrow("keystore seed does not match its key");
    await expect(run("export", [])).rejects.toThrow("keystore seed does not match its key");
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

  // W1, until it is fixed: the CLI must not tell the owner MCP will use a
  // wallet it would run at different addresses.
  it("tells the owner a default-mode wallet is not the one MCP would run", async () => {
    await run("new", ["node", "wallet", "--plain"]);
    expect(out.join("")).toContain("Do not fund this wallet for use with @aifinpay/mcp");
    expect(out.join("")).not.toContain("uses it with no config");
    out = [];
    rmSync(keystorePath());
    await run("new", ["node", "wallet", "--plain", "--legacy-solana"]);
    expect(out.join("")).toContain("uses it with no config");
  });

  // W7. `npx @aifinpay/mcp init` writes { secretB58, created } — no seedHex and
  // no derivationMode (mcp/bin/aifinpay-mcp.js). Its Solana key is the seed.
  it("show reads a keystore written by `npx @aifinpay/mcp init` (W7)", async () => {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const secretB58 = deriveWallet("11".repeat(32), { mode: "legacy-solana" }).keys.solanaSecretKeyB58;
    writeFileSync(keystorePath(), JSON.stringify({ secretB58, created: "2026-09-01T00:00:00.000Z" }), { mode: 0o600 });
    await run("show", []);
    expect(printed("EVM")).toBe(SDK["11".repeat(32)].evm);
  });
});

describe("export from an MCP keystore", () => {
  it("prints the seed, which is the stored Solana key's first 32 bytes", async () => {
    mkdirSync(home(), { recursive: true, mode: 0o700 });
    const secretB58 = deriveWallet("11".repeat(32), { mode: "legacy-solana" }).keys.solanaSecretKeyB58;
    writeFileSync(keystorePath(), JSON.stringify({ secretB58, created: "2026-09-01T00:00:00.000Z" }), { mode: 0o600 });
    await run("export", []);
    expect(out.join("")).toBe(`${"11".repeat(32)}\n`);
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
  // W5. index.ts re-exports run from cli.ts, so help handled at module load made
  // any program started with `--help`, `-h` or `help` that imported
  // @aifinpay/wallet print the wallet's help and exit.
  it("importing @aifinpay/wallet never exits the host process (W5)", async () => {
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
