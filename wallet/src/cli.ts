#!/usr/bin/env node
/**
 * `npx @aifinpay/wallet` — create or show an agent wallet, no heavy install.
 *
 *   npx @aifinpay/wallet new          create (refuses to overwrite, encrypted by default)
 *   npx @aifinpay/wallet new --plain  create unencrypted legacy keystore
 *   npx @aifinpay/wallet show         print the existing wallet's addresses
 *   npx @aifinpay/wallet export       print the seed to back up
 *
 * The keystore is ~/.aifinpay/agent.json (mode 600) — the same file
 * @aifinpay/mcp reads, so `npx @aifinpay/mcp` picks up this wallet with no
 * further config.
 *
 * SECURITY: New wallets are encrypted by default (scrypt-aes-256-gcm).
 * Use --plain to create legacy unencrypted keystores.
 * Use AIFINPAY_WALLET_PASSPHRASE environment variable for non-interactive mode.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync, appendFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir } from "node:os";
import { createCipheriv, createDecipheriv, scryptSync, randomBytes, randomFillSync } from "node:crypto";
import { sha3_256 } from "@noble/hashes/sha3";
import { newWallet, walletFromSolanaSecret, type DerivedWallet } from "./index.js";

const HOME = process.env.AIFINPAY_HOME || join(homedir(), ".aifinpay");
const KEYSTORE = join(HOME, "agent.json");
const ENV_FILE = join(HOME, ".env");

type EncryptedKeystore = {
  enc: "scrypt-aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ct: string;
};

type PlainKeystore = {
  secretB58: string;
  seedHex?: string;
  created?: string;
};

type KeystoreFile = PlainKeystore | (EncryptedKeystore & { created?: string });

function readStore(): KeystoreFile | null {
  if (!existsSync(KEYSTORE)) return null;
  try {
    const p = JSON.parse(readFileSync(KEYSTORE, "utf8"));
    if (typeof p === "object" && p !== null) {
      if ("enc" in p && typeof p.enc === "string") return p as EncryptedKeystore & { created?: string };
      if (typeof (p as PlainKeystore).secretB58 === "string") return p as PlainKeystore;
    }
    return null;
  } catch {
    return null;
  }
}

function encryptSecret(secretB58: string, passphrase: string): EncryptedKeystore {
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

function decrypt(store: EncryptedKeystore, passphrase: string): string {
  const key = scryptSync(passphrase, Buffer.from(store.salt, "base64"), 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(store.iv, "base64"));
  decipher.setAuthTag(Buffer.from(store.tag, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(store.ct, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

function print(w: DerivedWallet, created: boolean, isEncrypted: boolean = false) {
  if (created && !isEncrypted) process.stdout.write(`Created ${KEYSTORE} (mode 600).\n\n`);
  process.stdout.write(
    `Your agent's addresses — the EVM one is the same on every EVM chain:\n\n` +
      `  EVM     ${w.evmAddress}\n` +
      `  Solana  ${w.solanaAddress}\n` +
      `  Casper  ${w.casperAddress}\n\n` +
      `Point any AiFinPay client at this wallet — the keystore is the one\n` +
      `@aifinpay/mcp reads, so \`npx @aifinpay/mcp\` uses it with no config.\n\n` +
      `Back up ${KEYSTORE}. It is the only copy, and the derivation is not\n` +
      `BIP-39 — no standard wallet can recover it from a phrase.\n\n` +
      `The addresses hold nothing yet. Send POL to the EVM address to fund it.\n`
  );
}

async function promptPassphrase(prompt: string): Promise<string> {
  const tty = await import("node:tty");
  const readline = await import("node:readline");
  
  if (!tty.isatty(0)) {
    throw new Error("Passphrase prompt requires an interactive terminal");
  }
  
  return new Promise((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: true,
    });
    
    (rl as any)._writeToOutput = (out: string) => {
      if (process.stdout.isTTY) {
        process.stdout.write("\x1B[?25l"); // hide cursor
      }
      process.stdout.write(out);
    };
    
    const question = (q: string): Promise<string> => new Promise((res) => {
      rl.question(q, res);
    });
    
    (async () => {
      try {
        const pass1 = await question(prompt);
        if (!pass1) {
          rl.close();
          reject(new Error("Passphrase cannot be empty"));
          return;
        }
        const pass2 = await question("Confirm passphrase: ");
        rl.close();
        if (pass1 !== pass2) {
          reject(new Error("Passphrases do not match"));
          return;
        }
        process.stdout.write("\n");
        resolve(pass1);
      } catch (e) {
        rl.close();
        reject(e);
      }
    })();
  });
}

async function create(force: boolean, useEncryption: boolean): Promise<DerivedWallet> {
  const existing = readStore();
  if (existing && !force) {
    return loadWalletFromStore(existing);
  }
  if (existing && force) {
    process.stderr.write(`Refusing: ${KEYSTORE} already exists and may hold funds. Move it aside first.\n`);
    process.exit(1);
  }
  const w = await newWallet();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  
  let content: string;
  if (useEncryption) {
    const envPass = process.env.AIFINPAY_WALLET_PASSPHRASE;
    let passphrase: string;
    if (envPass) {
      passphrase = validatePassphrase(envPass);
    } else {
      passphrase = generateStrongPassphrase();
      savePassphraseToEnv(passphrase);
      process.stdout.write(`Generated strong passphrase and saved to ${ENV_FILE}\n\n`);
    }
    const encrypted = encryptSecret(w.keys.solanaSecretKeyB58, passphrase);
    content = JSON.stringify({ ...encrypted, created: nowIso() }, null, 2) + "\n";
  } else {
    content = JSON.stringify({ secretB58: w.keys.solanaSecretKeyB58, seedHex: w.keys.seedHex, created: nowIso() }, null, 2) + "\n";
  }
  
  writeFileSync(KEYSTORE, content, { mode: 0o600 });
  chmodSync(KEYSTORE, 0o600);
  return w;
}

function loadWalletFromStore(store: KeystoreFile): DerivedWallet {
  if ("secretB58" in store) {
    return walletFromSolanaSecret(store.secretB58);
  }
  if ("enc" in store) {
    const envPass = process.env.AIFINPAY_WALLET_PASSPHRASE;
    if (!envPass) {
      throw new Error(
        "AIFINPAY_WALLET_PASSPHRASE is required to decrypt the keystore. " +
        "Set it in the environment or .env file."
      );
    }
    const passphrase = validatePassphrase(envPass);
    return walletFromSolanaSecret(decrypt(store, passphrase));
  }
  throw new Error("invalid keystore format.");
}

function nowIso(): string {
  return new Date().toISOString();
}

export function generateStrongPassphrase(): string {
  const randomBytes = new Uint8Array(32);
  randomFillSync(randomBytes);

  const hash = sha3_256(randomBytes);
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validatePassphrase(passphrase: string | undefined): string {
  if (!passphrase) {
    throw new Error(
      "AIFINPAY_WALLET_PASSPHRASE is required for encrypted keystore.\n\n" +
      "Use `generateStrongPassphrase` function to get a strong password."
    );
  }
  if (passphrase.length < 16) {
    throw new Error(
      "AIFINPAY_WALLET_PASSPHRASE must be at least 16 characters long.\n\n" +
      "Use `generateStrongPassphrase` function to get a strong password."
    );
  }
  const hasLower = /[a-z]/.test(passphrase);
  const hasUpper = /[A-Z]/.test(passphrase);
  const hasDigit = /[0-9]/.test(passphrase);
  const hasSpecial = /[!@$.^*_+=-]/.test(passphrase);

  if (!hasLower || !hasUpper || !hasDigit || !hasSpecial) {
    throw new Error(
      "AIFINPAY_WALLET_PASSPHRASE must contain: lowercase (a-z), uppercase (A-Z), digits (0-9), and special characters (!@$.^*_+=-). " +
      "No # or other special characters allowed.\n\n" +
      "Use `generateStrongPassphrase` function to get a strong password."
    );
  }
  return passphrase;
}

function savePassphraseToEnv(passphrase: string): void {
  mkdirSync(HOME, { recursive: true, mode: 0o700 });

  let envContent = "";
  if (existsSync(ENV_FILE)) {
    envContent = readFileSync(ENV_FILE, "utf8");
    const lines = envContent.split("\n");
    const filteredLines = lines.filter(line => !line.startsWith("AIFINPAY_WALLET_PASSPHRASE="));
    envContent = filteredLines.join("\n").trim();
  }

  const newLine = `AIFINPAY_WALLET_PASSPHRASE=${passphrase}`;
  const finalContent = envContent ? `${envContent}\n${newLine}\n` : `${newLine}\n`;

  appendFileSync(ENV_FILE, finalContent, { mode: 0o600 });
  chmodSync(ENV_FILE, 0o600);
}

function warnIfLoose() {
  if (!existsSync(KEYSTORE)) return;
  const mode = statSync(KEYSTORE).mode & 0o777;
  if (mode & 0o077) {
    process.stderr.write(`[warn] ${KEYSTORE} is mode ${mode.toString(8)} — run: chmod 600 ${KEYSTORE}\n`);
  }
}

const cmd = (process.argv[2] || "").toLowerCase();
const hasPlainFlag = process.argv.includes("--plain");
const isEncryptedByDefault = !hasPlainFlag;

if (cmd === "-h" || cmd === "--help" || cmd === "help") {
  process.stdout.write(
    `npx @aifinpay/wallet new          create encrypted keystore (won't overwrite existing)\n` +
      `npx @aifinpay/wallet new --plain  create unencrypted legacy keystore\n` +
      `npx @aifinpay/wallet show         print addresses\n` +
      `npx @aifinpay/wallet export       print the seed to back up\n`
  );
  process.exit(0);
}

export const run = async (cmdArg?: string, argv?: string[]) => {
  warnIfLoose();
  const localCmd = cmdArg ?? cmd;
  const localPlain = (argv || process.argv).includes("--plain");
  const localEncrypted = !localPlain;

  if (localCmd === "export") {
    const s = readStore();
    if (!s) {
      process.stderr.write("no wallet found — run `npx @aifinpay/wallet new` first.\n");
      process.exit(1);
    }
    let seedHex: string | undefined;
    if ("seedHex" in s && s.seedHex) {
      seedHex = s.seedHex;
    } else if ("enc" in s) {
      const envPass = process.env.AIFINPAY_WALLET_PASSPHRASE;
      if (!envPass) {
        throw new Error("AIFINPAY_WALLET_PASSPHRASE is required to decrypt the keystore.");
      }
      const passphrase = validatePassphrase(envPass);
      const secretB58 = decrypt(s, passphrase);
      const w = walletFromSolanaSecret(secretB58);
      seedHex = w.keys.seedHex;
    } else {
      seedHex = s.seedHex;
    }
    if (!seedHex) {
      process.stderr.write("no stored seed — may need to regenerate from secret.\n");
      process.exit(1);
    }
    process.stdout.write(seedHex + "\n");
    return;
  }
  if (localCmd === "show") {
    const s = readStore();
    if (!s) {
      process.stderr.write("no wallet yet — run `npx @aifinpay/wallet new`.\n");
      process.exit(1);
    }
    const w = loadWalletFromStore(s);
    print(w, false, "enc" in s);
    return;
  }
  if (localCmd && localCmd !== "new") {
    process.stderr.write(`unknown command "${localCmd}". Try --help.\n`);
    process.exit(2);
  }
  if (!localCmd) {
    process.stderr.write("command required — use `npx @aifinpay/wallet new`.\n");
    process.exit(2);
  }
  const had = existsSync(KEYSTORE);
  const w = await create(localCmd === "new", localEncrypted);
  print(w, !had, localEncrypted);
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}
