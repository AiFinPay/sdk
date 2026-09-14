#!/usr/bin/env node
/**
 * `npx @aifinpay/wallet` — create or show an agent wallet, no heavy install.
 *
 *   npx @aifinpay/wallet          create one if absent, else show it
 *   npx @aifinpay/wallet new      create (refuses to overwrite a funded one)
 *   npx @aifinpay/wallet show     print the existing wallet's addresses
 *   npx @aifinpay/wallet export   print the seed to back up
 *   npx @aifinpay/wallet new --encrypt  create encrypted keystore (prompts for passphrase)
 *   npx @aifinpay/wallet keyring-save   store secret in OS keyring
 *   npx @aifinpay/wallet keyring-load   load secret from OS keyring
 *   npx @aifinpay/wallet keyring-delete remove secret from OS keyring
 *
 * The keystore is ~/.aifinpay/agent.json (mode 600) — the same file
 * @aifinpay/mcp reads, so `npx @aifinpay/mcp` picks up this wallet with no
 * further config.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from "node:crypto";
import { newWallet, walletFromSolanaSecret, type DerivedWallet } from "./index.js";

const SERVICE_NAME = "aifinpay-wallet";
const ACCOUNT_NAME = "agent-secret";

const HOME = process.env.AIFINPAY_HOME || join(homedir(), ".aifinpay");
const KEYSTORE = join(HOME, "agent.json");

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

function print(w: DerivedWallet, created: boolean) {
  if (created) process.stdout.write(`Created ${KEYSTORE} (mode 600).\n\n`);
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
    return walletFromSolanaSecret("secretB58" in existing ? existing.secretB58 : decrypt(existing, await promptPassphrase("Enter passphrase: ")));
  }
  if (existing && force) {
    process.stderr.write(`Refusing: ${KEYSTORE} already exists and may hold funds. Move it aside first.\n`);
    process.exit(1);
  }
  const w = await newWallet();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  
  let content: string;
  if (useEncryption) {
    const passphrase = await promptPassphrase("Enter passphrase for encrypted keystore: ");
    const encrypted = encryptSecret(w.keys.solanaSecretKeyB58, passphrase);
    content = JSON.stringify({ ...encrypted, created: nowIso() }, null, 2) + "\n";
  } else {
    content = JSON.stringify({ secretB58: w.keys.solanaSecretKeyB58, seedHex: w.keys.seedHex, created: nowIso() }, null, 2) + "\n";
  }
  
  writeFileSync(KEYSTORE, content, { mode: 0o600 });
  chmodSync(KEYSTORE, 0o600);
  return w;
}

function nowIso(): string {
  return new Date().toISOString();
}

function warnIfLoose() {
  if (!existsSync(KEYSTORE)) return;
  const mode = statSync(KEYSTORE).mode & 0o777;
  if (mode & 0o077) {
    process.stderr.write(`[warn] ${KEYSTORE} is mode ${mode.toString(8)} — run: chmod 600 ${KEYSTORE}\n`);
  }
}

async function keyringSave(): Promise<void> {
  const keytarModule = await import("keytar");
  const store = readStore();
  if (!store) {
    process.stderr.write("no wallet found — run `npx @aifinpay/wallet new` first.\n");
    process.exit(1);
  }
  const secretB58 = "secretB58" in store ? store.secretB58 : await decrypt(store, await promptPassphrase("Enter passphrase to decrypt keystore: "));
  await keytarModule.setPassword(SERVICE_NAME, ACCOUNT_NAME, secretB58);
  process.stdout.write(`Stored Solana secret in OS keyring (${SERVICE_NAME}/${ACCOUNT_NAME}).\n`);
  process.stdout.write(`You can now safely delete ${KEYSTORE} and use 'keyring-load' to restore it.\n`);
}

async function keyringLoad(): Promise<void> {
  const keytarModule = await import("keytar");
  const secretB58 = await keytarModule.getPassword(SERVICE_NAME, ACCOUNT_NAME);
  if (!secretB58) {
    process.stderr.write("no secret found in OS keyring.\n");
    process.exit(1);
  }
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(KEYSTORE, JSON.stringify({ secretB58, created: nowIso() }, null, 2) + "\n", { mode: 0o600 });
  chmodSync(KEYSTORE, 0o600);
  const w = walletFromSolanaSecret(secretB58);
  process.stdout.write(`Loaded wallet from OS keyring:\n`);
  process.stdout.write(`  EVM     ${w.evmAddress}\n`);
  process.stdout.write(`  Solana  ${w.solanaAddress}\n`);
  process.stdout.write(`  Casper  ${w.casperAddress}\n`);
}

async function keyringDelete(): Promise<void> {
  const keytarModule = await import("keytar");
  const deleted = await keytarModule.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
  if (deleted) {
    process.stdout.write(`Removed secret from OS keyring (${SERVICE_NAME}/${ACCOUNT_NAME}).\n`);
  } else {
    process.stderr.write("no secret found in OS keyring to delete.\n");
    process.exit(1);
  }
}

const cmd = (process.argv[2] || "").toLowerCase();
const hasEncryptFlag = process.argv.includes("--encrypt");

if (cmd === "-h" || cmd === "--help" || cmd === "help") {
  process.stdout.write(
    `npx @aifinpay/wallet          create if absent, else show\n` +
      `npx @aifinpay/wallet new      create (won't overwrite a funded wallet)\n` +
      `npx @aifinpay/wallet new --encrypt  create encrypted keystore (prompts for passphrase)\n` +
      `npx @aifinpay/wallet show     print addresses\n` +
      `npx @aifinpay/wallet export   print the seed to back up\n` +
      `npx @aifinpay/wallet keyring-save   store secret in OS keyring\n` +
      `npx @aifinpay/wallet keyring-load   load secret from OS keyring to ${KEYSTORE}\n` +
      `npx @aifinpay/wallet keyring-delete remove secret from OS keyring\n`
  );
  process.exit(0);
}

const run = async () => {
  warnIfLoose();
  if (cmd === "export") {
    const s = readStore();
    if (!s) {
      process.stderr.write("no wallet found — run `npx @aifinpay/wallet new` first.\n");
      process.exit(1);
    }
    let seedHex: string | undefined;
    if ("seedHex" in s && s.seedHex) {
      seedHex = s.seedHex;
    } else if ("enc" in s) {
      const secretB58 = decrypt(s, await promptPassphrase("Enter passphrase: "));
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
  if (cmd === "show") {
    const s = readStore();
    if (!s) {
      process.stderr.write("no wallet yet — run `npx @aifinpay/wallet new`.\n");
      process.exit(1);
    }
    const secretB58 = "secretB58" in s ? s.secretB58 : decrypt(s, await promptPassphrase("Enter passphrase: "));
    print(walletFromSolanaSecret(secretB58), false);
    return;
  }
  if (cmd === "keyring-save") {
    await keyringSave();
    return;
  }
  if (cmd === "keyring-load") {
    await keyringLoad();
    return;
  }
  if (cmd === "keyring-delete") {
    await keyringDelete();
    return;
  }
  if (cmd && cmd !== "new") {
    process.stderr.write(`unknown command "${cmd}". Try --help.\n`);
    process.exit(2);
  }
  const had = existsSync(KEYSTORE);
  const w = await create(cmd === "new", hasEncryptFlag);
  print(w, !had);
};

run().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
