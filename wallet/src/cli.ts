#!/usr/bin/env node
/**
 * `npx @aifinpay/wallet` — create or show an agent wallet, no heavy install.
 *
 *   npx @aifinpay/wallet                    create one if absent, else show it (encrypted by default)
 *   npx @aifinpay/wallet new                create (refuses to overwrite, encrypted by default)
 *   npx @aifinpay/wallet new --plain        create unencrypted keystore (legacy format)
 *   npx @aifinpay/wallet show               print the existing wallet's addresses
 *   npx @aifinpay/wallet export             print the seed to back up
 *   npx @aifinpay/wallet keyring-save       store secret in OS keyring
 *   npx @aifinpay/wallet keyring-load       load secret from OS keyring
 *   npx @aifinpay/wallet keyring-delete     BLOCKED: use 'keyring-delete-all' instead
 *   npx @aifinpay/wallet keyring-save-passphrase   store passphrase in OS keyring (for agents)
 *   npx @aifinpay/wallet keyring-load-passphrase   load passphrase from OS keyring
 *   npx @aifinpay/wallet keyring-delete-all remove BOTH secret and passphrase (safe cleanup)
 *
 * SECURITY: Passphrase cannot be deleted alone - prevents orphaning encrypted wallets.
 *
 * The keystore is ~/.aifinpay/agent.json (mode 600) — the same file
 * @aifinpay/mcp reads, so `npx @aifinpay/mcp` picks up this wallet with no
 * further config.
 *
 * SECURITY: New wallets are encrypted by default (scrypt-aes-256-gcm).
 * Use --plain to create legacy unencrypted keystores.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { createCipheriv, createDecipheriv, scryptSync, randomBytes } from "node:crypto";
import { newWallet, walletFromSolanaSecret, type DerivedWallet } from "./index.js";

const SERVICE_NAME = "aifinpay-wallet";
const ACCOUNT_NAME = "agent-secret";
const PASSPHRASE_ACCOUNT = "agent-passphrase";

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
    if ("enc" in existing) {
      const envPass = process.env.AIFINPAY_WALLET_PASSPHRASE;
      const passphrase = envPass ?? await promptPassphrase("Enter passphrase: ");
      return walletFromSolanaSecret(decrypt(existing, passphrase));
    }
    return walletFromSolanaSecret(existing.secretB58);
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
      passphrase = envPass;
    } else {
      passphrase = await promptPassphrase("Enter passphrase for encrypted keystore: ");
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

async function getKeytar() {
  const mod = await import("keytar");
  return (mod.default ?? mod) as typeof import("keytar");
}

async function keyringSave(): Promise<void> {
  const keytar = await getKeytar();
  const store = readStore();
  if (!store) {
    process.stderr.write("no wallet found — run `npx @aifinpay/wallet new` first.\n");
    process.exit(1);
  }
  const secretB58 = "secretB58" in store ? store.secretB58 : await decrypt(store, await promptPassphrase("Enter passphrase to decrypt keystore: "));
  await keytar.setPassword(SERVICE_NAME, ACCOUNT_NAME, secretB58);
  process.stdout.write(`Stored Solana secret in OS keyring (${SERVICE_NAME}/${ACCOUNT_NAME}).\n`);
  process.stdout.write(`You can now safely delete ${KEYSTORE} and use 'keyring-load' to restore it.\n`);
}

async function keyringLoad(): Promise<void> {
  const keytar = await getKeytar();
  const secretB58 = await keytar.getPassword(SERVICE_NAME, ACCOUNT_NAME);
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

async function keyringDeleteSecretOnly(): Promise<void> {
  const keytar = await getKeytar();
  const deleted = await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
  if (deleted) {
    process.stdout.write(`Removed secret from OS keyring (${SERVICE_NAME}/${ACCOUNT_NAME}).\n`);
  } else {
    process.stderr.write("no secret found in OS keyring to delete.\n");
    process.exit(1);
  }
}

async function keyringSavePassphrase(): Promise<void> {
  const keytar = await getKeytar();
  const store = readStore();
  if (!store || !("enc" in store)) {
    process.stderr.write("no encrypted keystore found — run `npx @aifinpay/wallet new` first (without --plain).\n");
    process.exit(1);
  }
  const envPass = process.env.AIFINPAY_WALLET_PASSPHRASE;
  let passphrase: string;
  if (envPass) {
    passphrase = envPass;
  } else {
    passphrase = await promptPassphrase("Enter the keystore passphrase to store: ");
  }
  await keytar.setPassword(SERVICE_NAME, PASSPHRASE_ACCOUNT, passphrase);
  process.stdout.write(`Stored passphrase in OS keyring (${SERVICE_NAME}/${PASSPHRASE_ACCOUNT}).\n`);
  process.stdout.write(`Agents can now auto-decrypt ${KEYSTORE}.\n`);
}

async function keyringLoadPassphrase(): Promise<string> {
  const keytar = await getKeytar();
  const passphrase = await keytar.getPassword(SERVICE_NAME, PASSPHRASE_ACCOUNT);
  if (!passphrase) {
    process.stderr.write("no passphrase found in OS keyring.\n");
    process.exit(1);
  }
  return passphrase;
}

async function keyringDeleteAll(): Promise<void> {
  const keytar = await getKeytar();
  const deletedSecret = await keytar.deletePassword(SERVICE_NAME, ACCOUNT_NAME);
  const deletedPassphrase = await keytar.deletePassword(SERVICE_NAME, PASSPHRASE_ACCOUNT);
  if (deletedSecret || deletedPassphrase) {
    process.stdout.write(`Removed all keyring entries (${SERVICE_NAME}).\n`);
  } else {
    process.stderr.write("no entries found in OS keyring to delete.\n");
    process.exit(1);
  }
}

const cmd = (process.argv[2] || "").toLowerCase();
const hasPlainFlag = process.argv.includes("--plain");
const isEncryptedByDefault = !hasPlainFlag;

if (cmd === "-h" || cmd === "--help" || cmd === "help") {
  process.stdout.write(
    `npx @aifinpay/wallet                    create if absent, else show (encrypted by default)\n` +
      `npx @aifinpay/wallet new                create encrypted keystore (won't overwrite existing)\n` +
      `npx @aifinpay/wallet new --plain        create unencrypted legacy keystore\n` +
      `npx @aifinpay/wallet show               print addresses\n` +
      `npx @aifinpay/wallet export             print the seed to back up\n` +
      `npx @aifinpay/wallet keyring-save       store secret in OS keyring\n` +
      `npx @aifinpay/wallet keyring-load       load secret from OS keyring to ${KEYSTORE}\n` +
      `npx @aifinpay/wallet keyring-delete     ERROR: Use 'keyring-delete-all' instead\n` +
      `npx @aifinpay/wallet keyring-save-passphrase   store passphrase in OS keyring (for agents)\n` +
      `npx @aifinpay/wallet keyring-load-passphrase   load passphrase from OS keyring\n` +
      `npx @aifinpay/wallet keyring-delete-all remove BOTH secret and passphrase from OS keyring\n`
  );
  process.exit(0);
}

const run = async () => {
  warnIfLoose();
  async function getPassphrase(): Promise<string> {
    if (process.env.AIFINPAY_WALLET_PASSPHRASE) {
      return process.env.AIFINPAY_WALLET_PASSPHRASE;
    }
    const keytar = await getKeytar();
    const stored = await keytar.getPassword(SERVICE_NAME, PASSPHRASE_ACCOUNT);
    if (stored) return stored;
    return await promptPassphrase("Enter passphrase: ");
  }

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
      const passphrase = await getPassphrase();
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
  if (cmd === "show") {
    const s = readStore();
    if (!s) {
      process.stderr.write("no wallet yet — run `npx @aifinpay/wallet`.\n");
      process.exit(1);
    }
    let secretB58: string;
    if ("secretB58" in s) {
      secretB58 = s.secretB58;
    } else if ("enc" in s) {
      const passphrase = await getPassphrase();
      secretB58 = decrypt(s, passphrase);
    } else {
      process.stderr.write("invalid keystore format.\n");
      process.exit(1);
    }
    print(walletFromSolanaSecret(secretB58), false, "enc" in s);
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
    process.stderr.write(`ERROR: Cannot delete secret only - this would orphan the encrypted wallet.\n`);
    process.stderr.write(`Use 'keyring-delete-all' to remove both secret and passphrase, or delete the keystore file.\n`);
    process.exit(1);
  }
  if (cmd === "keyring-save-passphrase") {
    await keyringSavePassphrase();
    return;
  }
  if (cmd === "keyring-load-passphrase") {
    const passphrase = await keyringLoadPassphrase();
    process.stdout.write(passphrase + "\n");
    return;
  }
  if (cmd === "keyring-delete-all") {
    await keyringDeleteAll();
    return;
  }
  if (cmd && cmd !== "new") {
    process.stderr.write(`unknown command "${cmd}". Try --help.\n`);
    process.exit(2);
  }
  const had = existsSync(KEYSTORE);
  const w = await create(cmd === "new", isEncryptedByDefault);
  print(w, !had, isEncryptedByDefault);
};

run().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
