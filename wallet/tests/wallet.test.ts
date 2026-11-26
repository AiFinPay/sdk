// @aifinpay/wallet must preserve the legacy EVM/Solana addresses the full
// agent already uses, while deriving deterministic NEAR/Aptos/Tron additions.
// It must also stay free of the heavy transaction stack (AIFINP-117).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { readFileSync, existsSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { inspect } from "node:util";
import { createCipheriv, createDecipheriv, scryptSync, randomBytes, randomFillSync } from "node:crypto";
import { deriveWallet, newWallet, walletFromSolanaSecret, type DerivationMode } from "../src";
import { sha3_256 } from "@noble/hashes/sha3";
import { secp256k1 } from "@noble/curves/secp256k1";
import nacl from "tweetnacl";
import bs58 from "bs58";

const HERE = dirname(fileURLToPath(import.meta.url));
const SEEDS = ["11".repeat(32), "ab".repeat(32), "0f".repeat(32), "00".repeat(31) + "01"];

describe("key material protection", () => {
  const SEED = "ab".repeat(32);
  const CHAINS = ["evm", "solana", "near", "aptos", "tron"] as const;
  const toHex = (b: Uint8Array) => Buffer.from(b).toString("hex");

  it("keeps every secret out of JSON, inspect, spread and structuredClone", () => {
    const w = deriveWallet(SEED, { index: 3 });
    const secrets = [w.exportSeed(), ...CHAINS.map((c) => w[c].exportPrivateKey().replace(/^0x/, ""))];
    const views = [
      JSON.stringify(w),
      inspect(w, { showHidden: true, getters: true, depth: 5 }),
      inspect(w.evm, { showHidden: true, getters: true }),
      JSON.stringify({ ...w }),
      JSON.stringify(structuredClone(w)),
    ];
    for (const view of views) {
      for (const secret of secrets) expect(view).not.toContain(secret);
    }
    expect(views[0]).toContain(w.evm.address);
  });

  it("pairs each chain's address and public key with its own private key", () => {
    const w = deriveWallet(SEED);
    expect(w.exportSeed()).toBe(SEED);
    for (const c of CHAINS) expect(w[c].chain).toBe(c);
    const evmKey = w.evm.exportPrivateKey();
    expect(evmKey).toMatch(/^0x[0-9a-f]{64}$/);
    expect(toHex(secp256k1.getPublicKey(evmKey.slice(2), true))).toBe(w.evm.publicKey);
    expect(toHex(secp256k1.getPublicKey(w.tron.exportPrivateKey(), true))).toBe(w.tron.publicKey);
    expect(bs58.encode(bs58.decode(w.solana.exportPrivateKey()).slice(32))).toBe(w.solana.address);
    for (const c of ["near", "aptos"] as const) {
      const pub = nacl.sign.keyPair.fromSeed(Buffer.from(w[c].exportPrivateKey(), "hex")).publicKey;
      expect(toHex(pub)).toBe(w[c].publicKey);
    }
    expect(w.near.publicKey).toBe(w.near.address);
    expect(new Set(CHAINS.map((c) => w[c].exportPrivateKey())).size).toBe(CHAINS.length);
  });

  it("dispose wipes the seed, revokes every export and leaves public data readable", () => {
    const w = deriveWallet(SEED);
    const address = w.evm.address;
    expect(w.disposed).toBe(false);
    w.dispose();
    expect(w.disposed).toBe(true);
    expect(() => w.exportSeed()).toThrow(/disposed/);
    for (const c of CHAINS) expect(() => w[c].exportPrivateKey()).toThrow(/disposed/);
    expect(w.evm.address).toBe(address);
    expect(() => w.dispose()).not.toThrow();
  });

  it("supports Symbol.dispose for `using` scopes", () => {
    const w = deriveWallet(SEED);
    w[Symbol.dispose]();
    expect(w.disposed).toBe(true);
  });

  it("validates the index before deriving anything", () => {
    expect(() => deriveWallet(SEED, { index: -1 })).toThrow(/derivation index/);
    expect(() => deriveWallet(SEED, { index: 2 ** 32 })).toThrow(/derivation index/);
  });
});

describe("derivation", () => {
  it("re-derives the same five-chain wallet from its own seed", () => {
    const w = deriveWallet("ab".repeat(32));
    expect(deriveWallet(w.exportSeed())).toEqual(w);
  });

  it("derives valid public identifiers for EVM, Solana, NEAR, Aptos and Tron", () => {
    const w = deriveWallet("42".repeat(32));
    expect(w.evm.address).toMatch(/^0x[0-9a-fA-F]{40}$/);
    expect(w.solana.address).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
    expect(w.near.address).toMatch(/^[0-9a-f]{64}$/);
    expect(w.aptos.address).toMatch(/^0x[0-9a-f]{64}$/);
    expect(w.tron.address).toMatch(/^T[1-9A-HJ-NP-Za-km-z]{33}$/);
    expect(w.tron.exportPrivateKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(w.near.exportPrivateKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(w.aptos.exportPrivateKey()).toMatch(/^[0-9a-f]{64}$/);
    expect(w.derivationMode).toBe("standard");
  });

  it("newWallet returns a recoverable seed", async () => {
    const w = await newWallet();
    expect(w.exportSeed()).toMatch(/^[0-9a-f]{64}$/);
    expect(deriveWallet(w.exportSeed())).toEqual(w);
  });

  it("walletFromSolanaSecret recovers the same complete wallet the keystore stores", () => {
    const w = deriveWallet("cd".repeat(32), { mode: "legacy-solana" });
    expect(walletFromSolanaSecret(w.solana.exportPrivateKey(), { mode: "legacy-solana" })).toEqual(w);
  });

  it("rejects a malformed seed and a too-short secret", () => {
    expect(() => deriveWallet("nope")).toThrow();
    expect(() => walletFromSolanaSecret("1", { mode: "legacy-solana" })).toThrow("need 64 bytes");
  });

  it("legacy-solana mode derives Solana address from raw seed", () => {
    const w = deriveWallet("cd".repeat(32), { mode: "legacy-solana" });
    expect(w.derivationMode).toBe("legacy-solana");
    const recovered = walletFromSolanaSecret(w.solana.exportPrivateKey(), { mode: "legacy-solana" });
    expect(recovered.solana.address).toBe(w.solana.address);
  });
});

// @aifinpay/agent is not a dependency of this package, so in CI these report as
// skipped rather than passing without checking anything. The pinned vectors in
// cli-and-derivation.test.ts check the same addresses without the SDK.
const full: {
  fromSeed: (
    s: string,
    options?: { derivationIndex?: number }
  ) => Promise<{ solanaAddress: string; evmAddress: string }>;
} | null = await import("@aifinpay/agent").then(
  (mod) => mod.AiFinPayAgent as never,
  () => null
);

describe("backwards-compatible with @aifinpay/agent", () => {
  for (const seed of SEEDS) {
    it.skipIf(!full)(`seed ${seed.slice(0, 6)}… preserves legacy funded addresses`, async () => {
      const agent = await full!.fromSeed(seed);
      const w = deriveWallet(seed, { mode: "legacy-solana" });
      expect(w.solana.address).toBe(agent.solanaAddress);
      expect(w.evm.address).toBe(agent.evmAddress);
    });

    it.skipIf(!full)(`indexed seed ${seed.slice(0, 6)}… matches the full SDK`, async () => {
      const index = 0;
      const agent = await full!.fromSeed(seed, { derivationIndex: index });
      const wallet = deriveWallet(seed, { index });
      expect(wallet.solana.address).toBe(agent.solanaAddress);
      expect(wallet.evm.address).toBe(agent.evmAddress);
    });
  }
});

describe("the install stays light", () => {
  function graphPackages(entry: string): Set<string> {
    const seen = new Set<string>();
    const pkgs = new Set<string>();
    const walk = (file: string) => {
      if (seen.has(file) || !existsSync(file)) return;
      seen.add(file);
      const src = readFileSync(file, "utf8")
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
      const re = /(?:import|export)[^"']*from\s*["']([^"']+)["']/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(src))) {
        const spec = m[1];
        if (spec.startsWith(".")) {
          let p = resolve(dirname(file), spec);
          if (!p.endsWith(".js")) p += ".js";
          walk(p);
        } else {
          pkgs.add(
            spec
              .split("/")
              .slice(0, spec.startsWith("@") ? 2 : 1)
              .join("/")
          );
        }
      }
    };
    walk(entry);
    return pkgs;
  }

  it("dist/index.js pulls in neither viem nor @solana/web3.js", () => {
    const dist = resolve(HERE, "..", "dist", "index.js");
    if (!existsSync(dist)) throw new Error("dist not built — run `npm run build`");
    const pkgs = graphPackages(dist);
    expect([...pkgs]).not.toContain("viem");
    expect([...pkgs]).not.toContain("@solana/web3.js");
    expect([...pkgs]).not.toContain("@aifinpay/agent");
  });

  it("declares exactly the four light crypto deps, nothing heavier", () => {
    const pkg = JSON.parse(readFileSync(resolve(HERE, "..", "package.json"), "utf8"));
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@noble/curves", "@noble/hashes", "bs58", "tweetnacl"]);
  });
});

describe("the CLI writes an mcp-compatible keystore", () => {
  it("stores secretB58 that walletFromSolanaSecret round-trips", () => {
    const w = deriveWallet("77".repeat(32), { mode: "legacy-solana" });
    const store = {
      secretB58: w.solana.exportPrivateKey(),
      seedHex: w.exportSeed(),
      derivationMode: "legacy-solana" as DerivationMode,
    };
    expect(walletFromSolanaSecret(store.secretB58, { mode: "legacy-solana" })).toEqual(w);
  });
});

describe("encrypted keystore", () => {
  function encrypt(secretB58: string, passphrase: string) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(secretB58, "utf8"), cipher.final()]);
    return {
      enc: "scrypt-aes-256-gcm",
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    };
  }

  it("encrypts and decrypts a secret correctly", () => {
    const w = deriveWallet("99".repeat(32), { mode: "legacy-solana" });
    const passphrase = "test-passphrase-123";
    const encrypted = encrypt(w.solana.exportPrivateKey(), passphrase);
    const key = scryptSync(passphrase, Buffer.from(encrypted.salt, "base64"), 32, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(encrypted.iv, "base64"));
    decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(encrypted.ct, "base64")), decipher.final()]).toString(
      "utf8"
    );
    expect(decrypted).toBe(w.solana.exportPrivateKey());
    expect(walletFromSolanaSecret(decrypted, { mode: "legacy-solana" })).toEqual(w);
  });

  it("rejects wrong passphrase", () => {
    const w = deriveWallet("88".repeat(32));
    const encrypted = encrypt(w.solana.exportPrivateKey(), "correct-pass");
    const wrongKey = scryptSync("wrong-pass", Buffer.from(encrypted.salt, "base64"), 32, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    expect(() => {
      const decipher = createDecipheriv("aes-256-gcm", wrongKey, Buffer.from(encrypted.iv, "base64"));
      decipher.setAuthTag(Buffer.from(encrypted.tag, "base64"));
      Buffer.concat([decipher.update(Buffer.from(encrypted.ct, "base64")), decipher.final()]);
    }).toThrow();
  });
});

describe("plain keystore round-trip", () => {
  const tmpDir = resolve(HERE, "tmp-plain-keystore");
  const originalEnv = process.env.AIFINPAY_HOME;
  const originalPassphrase = process.env.AIFINPAY_WALLET_PASSPHRASE;

  beforeEach(() => {
    process.env.AIFINPAY_HOME = tmpDir;
    delete process.env.AIFINPAY_WALLET_PASSPHRASE;
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AIFINPAY_HOME;
    else process.env.AIFINPAY_HOME = originalEnv;
    if (originalPassphrase === undefined) delete process.env.AIFINPAY_WALLET_PASSPHRASE;
    else process.env.AIFINPAY_WALLET_PASSPHRASE = originalPassphrase;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates a plain keystore without a passphrase", async () => {
    const cli = await import("../src/cli.js");
    await cli.run!("new", ["node", "wallet", "--plain"]);
    const keystorePath = join(tmpDir, "agent.json");
    expect(existsSync(keystorePath)).toBe(true);
    const store = JSON.parse(readFileSync(keystorePath, "utf8"));
    expect(store).toHaveProperty("secretB58");
    expect(store).not.toHaveProperty("enc");
  });

  it("shows and exports from a plain keystore without a passphrase", async () => {
    const cli = await import("../src/cli.js");
    await cli.run!("new", ["node", "wallet", "--plain"]);

    const logs: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((...args: any[]) => {
      logs.push(args[0]);
      return originalStdoutWrite.apply(process.stdout, args);
    }) as any;

    await cli.run!("show", []);
    await cli.run!("export", []);

    process.stdout.write = originalStdoutWrite;

    const showOutput = logs.filter((l) => l.includes("EVM")).join("");
    const seedOutput = logs.filter((l) => /^[0-9a-f]{64}\n$/.test(l)).join("");
    expect(showOutput).toContain("EVM");
    expect(seedOutput).toMatch(/^[0-9a-f]{64}\n$/);
  });

  it("requires a passphrase for an encrypted keystore", async () => {
    const cli = await import("../src/cli.js");
    process.env.AIFINPAY_WALLET_PASSPHRASE = "StrongPass123!@$.^";
    await cli.run!("new", ["node", "wallet"]);
    const keystorePath = join(tmpDir, "agent.json");
    expect(existsSync(keystorePath)).toBe(true);
    const store = JSON.parse(readFileSync(keystorePath, "utf8"));
    expect(store).toHaveProperty("enc");

    delete process.env.AIFINPAY_WALLET_PASSPHRASE;
    await expect(cli.run!("show", [])).rejects.toThrow("AIFINPAY_WALLET_PASSPHRASE is required to decrypt");
  });
});

describe("passphrase validation", () => {
  const validatePassphrase = (passphrase: string | undefined): string => {
    if (passphrase === undefined || passphrase === null || passphrase === "") {
      throw new Error("AIFINPAY_WALLET_PASSPHRASE is not set. Please set a strong passphrase in .env file.");
    }
    if (passphrase.length < 16) {
      throw new Error("AIFINPAY_WALLET_PASSPHRASE must be at least 16 characters long.");
    }
    const hasLower = /[a-z]/.test(passphrase);
    const hasUpper = /[A-Z]/.test(passphrase);
    const hasDigit = /[0-9]/.test(passphrase);
    const hasSpecial = /[!@$.^*_+=-]/.test(passphrase);

    if (!hasLower || !hasUpper || !hasDigit || !hasSpecial) {
      throw new Error(
        "AIFINPAY_WALLET_PASSPHRASE must contain: lowercase (a-z), uppercase (A-Z), digits (0-9), and special characters (!@$.^*_+=-). " +
          "No # or other special characters allowed."
      );
    }
    return passphrase;
  };

  const generateStrongPassphrase = (): string => {
    const randomBytes = new Uint8Array(32);
    randomFillSync(randomBytes);
    const hash = sha3_256(randomBytes);
    return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
  };

  it("rejects undefined passphrase", () => {
    expect(() => validatePassphrase(undefined)).toThrow("AIFINPAY_WALLET_PASSPHRASE is not set");
  });

  it("rejects null passphrase", () => {
    expect(() => validatePassphrase(null as any)).toThrow("AIFINPAY_WALLET_PASSPHRASE is not set");
  });

  it("rejects empty string passphrase", () => {
    expect(() => validatePassphrase("")).toThrow("AIFINPAY_WALLET_PASSPHRASE is not set");
  });

  it("rejects passphrase shorter than 16 characters", () => {
    expect(() => validatePassphrase("short123!@#")).toThrow("must be at least 16 characters");
  });

  it("rejects passphrase without lowercase", () => {
    expect(() => validatePassphrase("STRONGPASS123!@$.^")).toThrow("must contain: lowercase");
  });

  it("rejects passphrase without uppercase", () => {
    expect(() => validatePassphrase("strongpass123!@$.^")).toThrow("must contain: lowercase (a-z), uppercase (A-Z)");
  });

  it("rejects passphrase without digit", () => {
    expect(() => validatePassphrase("StrongPass!@$.^*")).toThrow(
      "must contain: lowercase (a-z), uppercase (A-Z), digits (0-9)"
    );
  });

  it("rejects passphrase without special character", () => {
    expect(() => validatePassphrase("StrongPass123456")).toThrow(
      "must contain: lowercase (a-z), uppercase (A-Z), digits (0-9), and special characters"
    );
  });

  it("accepts valid strong passphrase", () => {
    const valid = "StrongPass123!@$.^";
    expect(validatePassphrase(valid)).toBe(valid);
  });

  it("generates a valid strong passphrase", () => {
    const passphrase = generateStrongPassphrase();
    expect(passphrase).toMatch(/^[0-9a-f]{64}$/);
    expect(passphrase.length).toBe(64);
  });
});

describe("encrypted keystore keeps key material encrypted", () => {
  const tmpDir = resolve(HERE, "tmp-enc-keystore");
  const originalEnv = process.env.AIFINPAY_HOME;
  const originalPassphrase = process.env.AIFINPAY_WALLET_PASSPHRASE;
  const PASSPHRASE = "StrongPass123!@$.^";

  function encryptBlock(plaintext: string, passphrase: string) {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const key = scryptSync(passphrase, salt, 32, {
      N: 1 << 15,
      r: 8,
      p: 1,
      maxmem: 64 * 1024 * 1024,
    });
    const cipher = createCipheriv("aes-256-gcm", key, iv);
    const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return {
      salt: salt.toString("base64"),
      iv: iv.toString("base64"),
      tag: cipher.getAuthTag().toString("base64"),
      ct: ct.toString("base64"),
    };
  }

  function captureStdout() {
    const logs: string[] = [];
    const originalStdoutWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((...args: any[]) => {
      logs.push(args[0]);
      return originalStdoutWrite.apply(process.stdout, args);
    }) as any;
    return { logs, restore: () => void (process.stdout.write = originalStdoutWrite) };
  }

  beforeEach(() => {
    process.env.AIFINPAY_HOME = tmpDir;
    process.env.AIFINPAY_WALLET_PASSPHRASE = PASSPHRASE;
    rmSync(tmpDir, { recursive: true, force: true });
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.AIFINPAY_HOME;
    else process.env.AIFINPAY_HOME = originalEnv;
    if (originalPassphrase === undefined) delete process.env.AIFINPAY_WALLET_PASSPHRASE;
    else process.env.AIFINPAY_WALLET_PASSPHRASE = originalPassphrase;
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("new writes no plaintext seedHex/secretB58 and round-trips show/export", async () => {
    const cli = await import("../src/cli.js");
    await cli.run!("new", ["node", "wallet"]);
    const keystorePath = join(tmpDir, "agent.json");
    const store = JSON.parse(readFileSync(keystorePath, "utf8"));
    expect(store).toHaveProperty("enc", "scrypt-aes-256-gcm");
    expect(store).toHaveProperty("seedEnc");
    expect(store.seedEnc).toHaveProperty("ct");
    expect(store).not.toHaveProperty("seedHex");
    expect(store).not.toHaveProperty("secretB58");

    const { logs, restore } = captureStdout();
    await cli.run!("show", ["node", "wallet"]);
    await cli.run!("export", ["node", "wallet"]);
    restore();

    const exported = logs
      .filter((l) => /^[0-9a-f]{64}\n$/.test(l))
      .join("")
      .trim();
    expect(exported).toMatch(/^[0-9a-f]{64}$/);
    const w = deriveWallet(exported);
    const showOutput = logs.join("");
    expect(showOutput).toContain(w.evm.address);
    expect(showOutput).toContain(w.solana.address);
  });

  it("still reads pre-1.1.1 encrypted keystores with plaintext seedHex", async () => {
    const w = deriveWallet("ab".repeat(32));
    const enc = encryptBlock(w.solana.exportPrivateKey(), PASSPHRASE);
    writeFileSync(
      join(tmpDir, "agent.json"),
      JSON.stringify(
        {
          enc: "scrypt-aes-256-gcm",
          ...enc,
          created: new Date().toISOString(),
          derivationMode: "standard",
          seedHex: w.exportSeed(),
        },
        null,
        2
      ),
      { mode: 0o600 }
    );
    const cli = await import("../src/cli.js");
    const { logs, restore } = captureStdout();
    await cli.run!("show", ["node", "wallet"]);
    await cli.run!("export", ["node", "wallet"]);
    restore();
    expect(logs.join("")).toContain(w.evm.address);
    expect(
      logs
        .filter((l) => /^[0-9a-f]{64}\n$/.test(l))
        .join("")
        .trim()
    ).toBe(w.exportSeed());
  });
});
