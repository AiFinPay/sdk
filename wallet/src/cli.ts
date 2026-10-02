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
 * @aifinpay/mcp reads. MCP derives every address from the stored Solana key,
 * which gives the addresses printed here only for a `--legacy-solana` wallet.
 *
 * SECURITY: New wallets are encrypted by default (scrypt-aes-256-gcm).
 * Use --plain to create legacy unencrypted keystores.
 * Use AIFINPAY_WALLET_PASSPHRASE environment variable for non-interactive mode.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createCipheriv, createDecipheriv, scryptSync, randomBytes, randomFillSync } from "node:crypto";
import { sha3_256 } from "@noble/hashes/sha3";
import { newWallet, walletFromSolanaSecret, walletFromSeed, type DerivedWallet, type DerivationMode } from "./index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));

function getPaths() {
  const HOME = process.env.AIFINPAY_HOME || join(homedir(), ".aifinpay");
  const KEYSTORE = join(HOME, "agent.json");
  const ENV_FILE = join(HOME, ".env");
  const INSTRUCTIONS_FILE = join(HOME, "instructions.md");
  const RULES_FILE = join(HOME, "rules.md");
  const AIIGNORE_FILE = join(HOME, ".aiignore");
  return { HOME, KEYSTORE, ENV_FILE, INSTRUCTIONS_FILE, RULES_FILE, AIIGNORE_FILE };
}

type EncryptedKeystore = {
  enc: "scrypt-aes-256-gcm";
  salt: string;
  /** `ct` is the Solana secret (base58) — what @aifinpay/mcp decrypts. */
  iv: string;
  tag: string;
  ct: string;
  /** The seed, encrypted under the same key with its own IV. Written for
   *  standard-mode wallets, whose Solana secret is not the seed. */
  seedIv?: string;
  seedTag?: string;
  seedCt?: string;
};

type PlainKeystore = {
  secretB58: string;
  seedHex?: string;
  created?: string;
  derivationMode?: DerivationMode;
};

type KeystoreFile = PlainKeystore | (EncryptedKeystore & { created?: string; derivationMode?: DerivationMode; seedHex?: string });

/** null when there is no keystore. A file that exists but is not a keystore
 *  this version understands throws: it may hold funds, so it must never be
 *  mistaken for "no wallet yet". */
function readStore(): KeystoreFile | null {
  const { KEYSTORE } = getPaths();
  if (!existsSync(KEYSTORE)) return null;
  let p: unknown;
  try {
    p = JSON.parse(readFileSync(KEYSTORE, "utf8"));
  } catch {
    p = null;
  }
  if (typeof p === "object" && p !== null) {
    // Only the scheme this version can open; another one is unreadable, not wrong-key.
    if ("enc" in p && p.enc === "scrypt-aes-256-gcm") return p as EncryptedKeystore & { created?: string };
    if (typeof (p as PlainKeystore).secretB58 === "string") return p as PlainKeystore;
  }
  throw new Error(`${KEYSTORE} is not a keystore this version can read. It may hold funds; it was left untouched.`);
}

function keyFor(passphrase: string, salt: Buffer): Buffer {
  return scryptSync(passphrase, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
}

function seal(key: Buffer, plaintext: string): { iv: string; tag: string; ct: string } {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return { iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

function open(key: Buffer, iv: string, tag: string, ct: string): string {
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(ct, "base64")), decipher.final()]).toString("utf8");
}

/** `ct` stays the Solana secret, in the format @aifinpay/mcp decrypts. A
 *  standard-mode seed cannot be recovered from that secret, so it is sealed
 *  beside it under the same key — never stored in the clear. */
function encryptSecret(secretB58: string, passphrase: string, seedHex?: string): EncryptedKeystore {
  const salt = randomBytes(16);
  const key = keyFor(passphrase, salt);
  const secret = seal(key, secretB58);
  const out: EncryptedKeystore = { enc: "scrypt-aes-256-gcm", salt: salt.toString("base64"), ...secret };
  if (seedHex) {
    const seed = seal(key, seedHex);
    Object.assign(out, { seedIv: seed.iv, seedTag: seed.tag, seedCt: seed.ct });
  }
  return out;
}

function print(w: DerivedWallet, created: boolean, isEncrypted: boolean = false) {
  const { KEYSTORE } = getPaths();
  if (created && !isEncrypted) process.stdout.write(`Created ${KEYSTORE} (mode 600).\n\n`);
  // MCP (and AiFinPayAgent.fromSolanaSecret) derive every address from the
  // stored Solana key. Only a legacy-solana wallet's Solana key is the seed, so
  // only there do they arrive at the addresses printed above.
  const clients =
    w.derivationMode === "legacy-solana"
      ? `Point any AiFinPay client at this wallet — the keystore is the one\n` +
        `@aifinpay/mcp reads, so \`npx @aifinpay/mcp\` uses it with no config.\n\n`
      : `Do not fund this wallet for use with @aifinpay/mcp: MCP derives its EVM\n` +
        `and Casper keys from the stored Solana key and would run the agent at\n` +
        `different addresses. For MCP, create the wallet with --legacy-solana.\n\n`;
  process.stdout.write(
    `Your agent's addresses — the EVM one is the same on every EVM chain:\n\n` +
      `  EVM     ${w.evmAddress}\n` +
      `  Solana  ${w.solanaAddress}\n` +
      `  Casper  ${w.casperAddress}\n\n` +
      clients +
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

async function create(useEncryption: boolean, mode?: DerivationMode): Promise<DerivedWallet> {
  const { HOME, KEYSTORE, ENV_FILE, INSTRUCTIONS_FILE, RULES_FILE, AIIGNORE_FILE } = getPaths();
  // Any file at that path refuses — one this version cannot read (a newer
  // format, a hand edit, a truncated write) may hold funds just the same.
  if (existsSync(KEYSTORE)) {
    process.stderr.write(`Refusing: ${KEYSTORE} already exists and may hold funds. Move it aside first.\n`);
    process.exit(1);
  }
  const w = await newWallet({ mode });
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  
  const SRC_INSTRUCTIONS = join(__dirname, "..", ".aifinpay", "instructions.md");
  const SRC_RULES = join(__dirname, "..", ".aifinpay", "rules.md");
  
  if (!existsSync(INSTRUCTIONS_FILE) && existsSync(SRC_INSTRUCTIONS)) {
    const content = readFileSync(SRC_INSTRUCTIONS, "utf8");
    writeFileSync(INSTRUCTIONS_FILE, content, { mode: 0o644 });
  }
  
  if (!existsSync(RULES_FILE) && existsSync(SRC_RULES)) {
    const content = readFileSync(SRC_RULES, "utf8");
    writeFileSync(RULES_FILE, content, { mode: 0o644 });
  }
  
  if (!existsSync(AIIGNORE_FILE)) {
    const aiignoreContent = `# AiFinPay agent files
agent.json
secrets/
`;
    writeFileSync(AIIGNORE_FILE, aiignoreContent, { mode: 0o644 });
  }
  
  let content: string;
  if (useEncryption) {
    const envPass = process.env.AIFINPAY_WALLET_PASSPHRASE;
    let passphrase: string;
    if (envPass) {
      passphrase = validatePassphrase(envPass);
    } else {
      passphrase = generateStrongPassphrase();
      savePassphraseToEnv(passphrase, ENV_FILE);
      process.stdout.write(`Generated strong passphrase and saved to ${ENV_FILE}\n\n`);
    }
    const seedHex = w.derivationMode === "standard" ? w.keys.seedHex : undefined;
    const encrypted = encryptSecret(w.keys.solanaSecretKeyB58, passphrase, seedHex);
    content = JSON.stringify({ ...encrypted, created: nowIso(), derivationMode: w.derivationMode }, null, 2) + "\n";
  } else {
    content = JSON.stringify({ secretB58: w.keys.solanaSecretKeyB58, seedHex: w.keys.seedHex, created: nowIso(), derivationMode: w.derivationMode }, null, 2) + "\n";
  }
  
  writeFileSync(KEYSTORE, content, { mode: 0o600 });
  chmodSync(KEYSTORE, 0o600);
  return w;
}

/** A keystore without `derivationMode` was written by `npx @aifinpay/mcp init`
 *  (or by this package before the field existed). Both use the Solana key as
 *  the seed, so that is how it must be read; every published release of this
 *  package writes the field. */
function modeOf(store: KeystoreFile): DerivationMode {
  return store.derivationMode === "standard" ? "standard" : "legacy-solana";
}

/** The wallet a keystore holds. Throws rather than guess: a seed that does not
 *  derive the stored Solana key is a damaged or tampered file. */
function loadWalletFromStore(store: KeystoreFile): DerivedWallet {
  const mode = modeOf(store);
  let secretB58: string;
  let seedHex: string | undefined = typeof store.seedHex === "string" && store.seedHex ? store.seedHex : undefined;
  if ("enc" in store) {
    const envPass = process.env.AIFINPAY_WALLET_PASSPHRASE;
    if (!envPass) {
      throw new Error(
        "AIFINPAY_WALLET_PASSPHRASE is required to decrypt the keystore. " +
        "Set it in the environment or .env file."
      );
    }
    const key = keyFor(validatePassphrase(envPass), Buffer.from(store.salt, "base64"));
    secretB58 = open(key, store.iv, store.tag, store.ct);
    if (store.seedCt && store.seedIv && store.seedTag) {
      seedHex = open(key, store.seedIv, store.seedTag, store.seedCt);
    } else if (seedHex) {
      const { KEYSTORE } = getPaths();
      process.stderr.write(
        `[warn] ${KEYSTORE} stores the seed unencrypted next to the ciphertext (a @aifinpay/wallet 1.1.0 keystore).\n` +
          `       Anyone who can read the file has the wallet; protect it as a plaintext key.\n`
      );
    }
  } else {
    secretB58 = store.secretB58;
  }
  if (mode === "legacy-solana") {
    const w = walletFromSolanaSecret(secretB58, { mode });
    if (seedHex && seedHex.toLowerCase() !== w.keys.seedHex) throw new Error("keystore seed does not match its key");
    return w;
  }
  if (!seedHex) throw new Error("seedHex required for standard derivation mode");
  const w = walletFromSeed(seedHex, { mode });
  if (w.keys.solanaSecretKeyB58 !== secretB58) throw new Error("keystore seed does not match its key");
  return w;
}

function nowIso(): string {
  return new Date().toISOString();
}

// No "$": the passphrase is saved to ~/.aifinpay/.env, and `source`-ing that
// file in a shell would expand it.
const PASSPHRASE_CHARSET = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@.^*_+=-";

function hasEveryClass(passphrase: string): boolean {
  return /[a-z]/.test(passphrase) && /[A-Z]/.test(passphrase) && /[0-9]/.test(passphrase) && /[!@$.^*_+=-]/.test(passphrase);
}

/** 32 characters that always pass the rule `validatePassphrase` enforces —
 *  drawn again until they do, which takes ~1.04 draws on average. */
export function generateStrongPassphrase(): string {
  for (;;) {
    const randomData = new Uint8Array(32);
    randomFillSync(randomData);
    let passphrase = "";
    for (let i = 0; i < 32; i++) {
      passphrase += PASSPHRASE_CHARSET[randomData[i] % PASSPHRASE_CHARSET.length];
    }
    if (hasEveryClass(passphrase)) return passphrase;
  }
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
  if (!hasEveryClass(passphrase)) {
    throw new Error(
      "AIFINPAY_WALLET_PASSPHRASE must contain: lowercase (a-z), uppercase (A-Z), digits (0-9), and special characters (!@$.^*_+=-). " +
      "No # or other special characters allowed.\n\n" +
      "Use `generateStrongPassphrase` function to get a strong password."
    );
  }
  return passphrase;
}

function savePassphraseToEnv(passphrase: string, envFile: string): void {
  const { HOME } = getPaths();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });

  const secretsDir = join(HOME, "secrets");
  const passphraseFile = join(secretsDir, "passphrase");
  if (!existsSync(secretsDir)) {
    mkdirSync(secretsDir, { recursive: true, mode: 0o700 });
  }
  writeFileSync(passphraseFile, passphrase, { mode: 0o600 });
  chmodSync(passphraseFile, 0o600);

  let envContent = "";
  if (existsSync(envFile)) {
    envContent = readFileSync(envFile, "utf8");
    const lines = envContent.split("\n");
    const filteredLines = lines.filter(line => !line.startsWith("AIFINPAY_WALLET_PASSPHRASE="));
    envContent = filteredLines.join("\n").trim();
  }

  const newLine = `AIFINPAY_WALLET_PASSPHRASE=${passphrase}`;
  const finalContent = envContent ? `${envContent}\n${newLine}\n` : `${newLine}\n`;

  // Write, not append: finalContent already holds every other line.
  writeFileSync(envFile, finalContent, { mode: 0o600 });
  chmodSync(envFile, 0o600);
}

function warnIfLoose() {
  const { KEYSTORE } = getPaths();
  if (!existsSync(KEYSTORE)) return;
  const mode = statSync(KEYSTORE).mode & 0o777;
  if (mode & 0o077) {
    process.stderr.write(`[warn] ${KEYSTORE} is mode ${mode.toString(8)} — run: chmod 600 ${KEYSTORE}\n`);
  }
}

// Read, never acted on, at module load: index.ts re-exports run(), and a
// library import must not print help and exit its host.
const cmd = (process.argv[2] || "").toLowerCase();

function printHelp(): void {
  process.stdout.write(
    `npx @aifinpay/wallet new                   create encrypted keystore (won't overwrite existing)\n` +
      `npx @aifinpay/wallet new --plain           create unencrypted legacy keystore\n` +
      `npx @aifinpay/wallet new --legacy-solana   create wallet with legacy Solana derivation (not recommended)\n` +
      `npx @aifinpay/wallet show                  print addresses\n` +
      `npx @aifinpay/wallet export                print the seed to back up\n` +
      `\nLibrary usage:\n` +
      `  import { newWallet, createWalletCLI } from "@aifinpay/wallet";\n` +
      `  await newWallet({ mode: "legacy-solana" });\n` +
      `  await createWalletCLI("new", ["node", "wallet", "--legacy-solana"]);\n`
  );
}

export const run = async (cmdArg?: string, argv?: string[], options?: { mode?: DerivationMode }) => {
  warnIfLoose();
  const localCmd = cmdArg ?? cmd;
  const localPlain = (argv || process.argv).includes("--plain");
  const localEncrypted = !localPlain;
  const localLegacy = options?.mode === "legacy-solana" || (argv || process.argv).includes("--legacy-solana");
  const derivationMode: DerivationMode = localLegacy ? "legacy-solana" : "standard";

  if (localCmd === "-h" || localCmd === "--help" || localCmd === "help") {
    printHelp();
    return;
  }
  if (localCmd === "export") {
    const s = readStore();
    if (!s) {
      process.stderr.write("no wallet found — run `npx @aifinpay/wallet new` first.\n");
      process.exit(1);
    }
    // Through the same path as `show`: an encrypted keystore's seed is only
    // ever printed after the passphrase opened it.
    process.stdout.write(loadWalletFromStore(s).keys.seedHex + "\n");
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
  const { KEYSTORE } = getPaths();
  const had = existsSync(KEYSTORE);
  const w = await create(localEncrypted, derivationMode);
  print(w, !had, localEncrypted);
};

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  run().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}
