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
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from "node:fs";
import { join, dirname } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { createCipheriv, createDecipheriv, scryptSync, randomBytes, randomFillSync } from "node:crypto";
import bs58 from "bs58";
import {
  MAX_DERIVATION_INDEX,
  newWallet,
  walletFromSolanaSecret,
  walletFromSeed,
  type DerivedWallet,
  type DerivationMode,
} from "./index.js";

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

type EncryptedSeed = {
  salt: string;
  iv: string;
  tag: string;
  ct: string;
};

type EncryptedKeystore = {
  enc: "scrypt-aes-256-gcm";
  salt: string;
  iv: string;
  tag: string;
  ct: string;
  /** AES-GCM of the 32-byte seedHex — the recovery secret for standard
   * derivation. Present on keystores written by 1.1.1+; older encrypted
   * keystores carry the seed in plaintext `seedHex` instead. */
  seedEnc?: EncryptedSeed;
};

type PlainKeystore = {
  secretB58: string;
  seedHex?: string;
  created?: string;
  derivationMode?: DerivationMode;
  derivationIndex?: number;
};

type KeystoreFile =
  | PlainKeystore
  | (EncryptedKeystore & {
      created?: string;
      derivationMode?: DerivationMode;
      derivationIndex?: number;
    });

function readStore(): KeystoreFile | null {
  const { KEYSTORE } = getPaths();
  if (!existsSync(KEYSTORE)) return null;
  const unreadable = () => new Error(`${KEYSTORE} is not a keystore this version can read`);
  let p: unknown;
  try {
    p = JSON.parse(readFileSync(KEYSTORE, "utf8"));
  } catch {
    throw unreadable();
  }
  if (typeof p === "object" && p !== null) {
    const o = p as Record<string, unknown>;
    if (typeof o.secretB58 === "string") return p as PlainKeystore;
    if (
      o.enc === "scrypt-aes-256-gcm" &&
      typeof o.salt === "string" &&
      typeof o.iv === "string" &&
      typeof o.tag === "string" &&
      typeof o.ct === "string"
    ) {
      return p as EncryptedKeystore & { created?: string };
    }
  }
  throw unreadable();
}

function encryptSecret(plaintext: string, passphrase: string): EncryptedKeystore {
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
    enc: "scrypt-aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}

function decrypt(store: Pick<EncryptedKeystore, "salt" | "iv" | "tag" | "ct">, passphrase: string): string {
  const key = scryptSync(passphrase, Buffer.from(store.salt, "base64"), 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(store.iv, "base64"));
  decipher.setAuthTag(Buffer.from(store.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(store.ct, "base64")), decipher.final()]).toString("utf8");
}

function print(w: DerivedWallet, created: boolean, isEncrypted: boolean = false) {
  const { KEYSTORE } = getPaths();
  if (created && !isEncrypted) process.stdout.write(`Created ${KEYSTORE} (mode 600).\n\n`);
  process.stdout.write(
    `Your agent's addresses${w.derivationIndex === undefined ? "" : ` (index ${w.derivationIndex})`} — ` +
      `the EVM one is the same on every EVM chain:\n\n` +
      `  EVM     ${w.evmAddress}\n` +
      `  Solana  ${w.solanaAddress}\n\n` +
      (w.derivationMode === "legacy-solana" || w.derivationIndex !== undefined
        ? `The keystore is the one @aifinpay/mcp reads, so \`npx @aifinpay/mcp\`\n` + `uses it with no config.\n\n`
        : `Do not fund this wallet for use with @aifinpay/mcp: standard mode derives a\n` +
          `different identity there. Create it with --legacy-solana instead.\n\n`) +
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

    const question = (q: string): Promise<string> =>
      new Promise((res) => {
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

async function create(
  force: boolean,
  useEncryption: boolean,
  mode?: DerivationMode,
  index?: number
): Promise<DerivedWallet> {
  const { HOME, KEYSTORE, ENV_FILE, INSTRUCTIONS_FILE, RULES_FILE, AIIGNORE_FILE } = getPaths();
  // A file that exists but cannot be read may hold funds exactly as much as a
  // valid one: refuse to overwrite it rather than parse-then-clobber.
  let existing: KeystoreFile | null = null;
  if (existsSync(KEYSTORE)) {
    try {
      existing = readStore();
    } catch {
      existing = null;
    }
    if (!existing || force) {
      process.stderr.write(`Refusing: ${KEYSTORE} already exists and may hold funds. Move it aside first.\n`);
      process.exit(1);
    }
    const wallet = loadWalletFromStore(existing);
    if (index !== undefined && wallet.derivationIndex !== index) {
      throw new Error(`wallet already exists with derivation index ${wallet.derivationIndex ?? "none"}`);
    }
    return wallet;
  }
  const w = await newWallet({ mode, index });
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
    const encrypted = encryptSecret(w.keys.solanaSecretKeyB58, passphrase);
    // Preserve the recovery seed for standard and indexed wallets in its own
    // AES-GCM envelope; `ct` stays the Solana secret for existing MCP readers.
    const seedBlock = encryptSecret(w.keys.seedHex, passphrase);
    const seedEnc: EncryptedSeed = { salt: seedBlock.salt, iv: seedBlock.iv, tag: seedBlock.tag, ct: seedBlock.ct };
    content =
      JSON.stringify(
        {
          ...encrypted,
          seedEnc,
          created: nowIso(),
          derivationMode: w.derivationMode,
          ...(w.derivationIndex === undefined ? {} : { derivationIndex: w.derivationIndex }),
        },
        null,
        2
      ) + "\n";
  } else {
    content =
      JSON.stringify(
        {
          secretB58: w.keys.solanaSecretKeyB58,
          seedHex: w.keys.seedHex,
          created: nowIso(),
          derivationMode: w.derivationMode,
          ...(w.derivationIndex === undefined ? {} : { derivationIndex: w.derivationIndex }),
        },
        null,
        2
      ) + "\n";
  }

  writeFileSync(KEYSTORE, content, { mode: 0o600 });
  chmodSync(KEYSTORE, 0o600);
  return w;
}

function parseIndexArg(args: string[], position: number): number {
  const arg = args[position];
  const raw = arg === "--index" ? args[position + 1] : arg.slice("--index=".length);
  if (!raw || !/^(0|[1-9][0-9]*)$/.test(raw)) {
    throw new Error("--index requires a non-negative integer");
  }
  const index = Number(raw);
  if (!Number.isSafeInteger(index) || index > MAX_DERIVATION_INDEX) {
    throw new Error(`--index must be between 0 and ${MAX_DERIVATION_INDEX}`);
  }
  return index;
}

function storedMode(store: KeystoreFile): DerivationMode | undefined {
  return "derivationMode" in store && (store.derivationMode === "legacy-solana" || store.derivationMode === "standard")
    ? store.derivationMode
    : undefined;
}

function storedSeed(store: KeystoreFile): string | undefined {
  return "seedHex" in store && typeof store.seedHex === "string" && store.seedHex ? store.seedHex : undefined;
}

/** 1.1.0 encrypted keystore: Solana secret sealed, seed in the clear next to
 *  it. The plaintext seed sits outside the GCM tag, so it is only trusted
 *  after it re-derives the sealed key. */
function loadLegacyEncrypted(store: EncryptedKeystore, passphrase: string, index?: number): DerivedWallet {
  const { KEYSTORE } = getPaths();
  const secretB58 = decrypt(store, passphrase);
  const seedHex = storedSeed(store as KeystoreFile);
  const mode = storedMode(store as KeystoreFile) ?? "standard";
  if (index !== undefined && !seedHex) throw new Error("seedHex required to recover an indexed wallet");
  if (seedHex) {
    const w = walletFromSeed(seedHex, { mode, index });
    if (w.keys.solanaSecretKeyB58 !== secretB58) {
      throw new Error("keystore seed does not match its key");
    }
    process.stderr.write(`[warn] ${KEYSTORE} stores the seed unencrypted — recreate it with \`wallet new\`.\n`);
    return w;
  }
  if (mode === "legacy-solana") return walletFromSolanaSecret(secretB58, { mode });
  throw new Error("seedHex required for standard derivation mode in encrypted keystore");
}

function loadWalletFromStore(store: KeystoreFile, indexOverride?: number): DerivedWallet {
  const index = indexOverride ?? store.derivationIndex;
  if ("secretB58" in store) {
    const seedHex = storedSeed(store);
    // No derivationMode recorded: a keystore with a seed is standard (this
    // CLI always wrote both); a bare { secretB58 } is `mcp init` output,
    // whose Solana key IS the seed.
    const mode: DerivationMode = storedMode(store) ?? (seedHex ? "standard" : "legacy-solana");
    if (index !== undefined) {
      if (!seedHex) throw new Error("seedHex required to recover an indexed wallet");
      return walletFromSeed(seedHex, { mode, index });
    }
    if (mode === "legacy-solana") {
      return walletFromSolanaSecret(store.secretB58, { mode });
    }
    if (!seedHex) {
      throw new Error("seedHex required for standard derivation mode");
    }
    return walletFromSeed(seedHex, { mode });
  }
  if ("enc" in store) {
    const envPass = process.env.AIFINPAY_WALLET_PASSPHRASE;
    if (!envPass) {
      throw new Error(
        "AIFINPAY_WALLET_PASSPHRASE is required to decrypt the keystore. " + "Set it in the environment or .env file."
      );
    }
    const passphrase = validatePassphrase(envPass);
    const mode = storedMode(store) ?? "standard";
    // New format (1.1.1+): the seed itself is encrypted — no plaintext key material.
    if ("seedEnc" in store && store.seedEnc) {
      return walletFromSeed(decrypt(store.seedEnc, passphrase), { mode, index });
    }
    return loadLegacyEncrypted(store, passphrase, index);
  }
  throw new Error("invalid keystore format.");
}

function nowIso(): string {
  return new Date().toISOString();
}

export function generateStrongPassphrase(): string {
  // No "$": the passphrase is saved to a .env file a shell may `source`.
  // Rejection-sample until validatePassphrase's four classes are all present,
  // so the CLI never writes a passphrase it would itself refuse.
  const charset = "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789!@.^*_+=-";
  const valid = (p: string) => /[a-z]/.test(p) && /[A-Z]/.test(p) && /[0-9]/.test(p) && /[!@.^*_+=-]/.test(p);
  const randomData = new Uint8Array(32);
  for (;;) {
    randomFillSync(randomData);
    let passphrase = "";
    for (let i = 0; i < 32; i++) {
      passphrase += charset[randomData[i] % charset.length];
    }
    if (valid(passphrase)) return passphrase;
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
    const filteredLines = lines.filter((line) => !line.startsWith("AIFINPAY_WALLET_PASSPHRASE="));
    envContent = filteredLines.join("\n").trim();
  }

  const newLine = `AIFINPAY_WALLET_PASSPHRASE=${passphrase}`;
  const finalContent = envContent ? `${envContent}\n${newLine}\n` : `${newLine}\n`;

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

const cmd = (process.argv[2] || "").toLowerCase();
const hasPlainFlag = process.argv.includes("--plain");
const isEncryptedByDefault = !hasPlainFlag;
const hasLegacyFlag = process.argv.includes("--legacy-solana");
// index.ts re-exports run from this module, so nothing below may act — print
// or exit — unless this file is the process entry point.
const isMain = !!(process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href);

if (isMain && (cmd === "-h" || cmd === "--help" || cmd === "help")) {
  process.stdout.write(
    `npx @aifinpay/wallet new                   create encrypted keystore (won't overwrite existing)\n` +
      `npx @aifinpay/wallet new --index N         derive child N from the chain domains\n` +
      `npx @aifinpay/wallet new --plain           create unencrypted legacy keystore\n` +
      `npx @aifinpay/wallet new --legacy-solana   create wallet with legacy Solana derivation (not recommended)\n` +
      `npx @aifinpay/wallet show                  print addresses\n` +
      `npx @aifinpay/wallet show --index N        show child N without changing the keystore\n` +
      `npx @aifinpay/wallet export                print the seed to back up\n` +
      `\nLibrary usage:\n` +
      `  import { newWallet, createWalletCLI } from "@aifinpay/wallet";\n` +
      `  await newWallet({ mode: "legacy-solana" });\n` +
      `  await createWalletCLI("new", ["node", "wallet", "--legacy-solana"]);\n`
  );
  process.exit(0);
}

export const run = async (cmdArg?: string, argv?: string[], options?: { mode?: DerivationMode; index?: number }) => {
  warnIfLoose();
  const localCmd = cmdArg ?? cmd;
  const localPlain = (argv || process.argv).includes("--plain");
  const localEncrypted = !localPlain;
  const localLegacy = options?.mode === "legacy-solana" || (argv || process.argv).includes("--legacy-solana");
  const derivationMode: DerivationMode = localLegacy ? "legacy-solana" : "standard";
  const args = argv || process.argv;
  const indexArg = args.findIndex((arg) => arg === "--index" || arg.startsWith("--index="));
  if (options?.index !== undefined && indexArg >= 0) {
    throw new Error("provide derivation index either as an option or a flag, not both");
  }
  const index = options?.index ?? (indexArg < 0 ? undefined : parseIndexArg(args, indexArg));
  if (index !== undefined && localCmd !== "new" && localCmd !== "show") {
    throw new Error("--index is supported only by the new and show commands");
  }

  if (localCmd === "export") {
    const s = readStore();
    if (!s) {
      process.stderr.write("no wallet found — run `npx @aifinpay/wallet new` first.\n");
      process.exit(1);
    }
    let seedHex: string | undefined;
    if ("enc" in s) {
      const envPass = process.env.AIFINPAY_WALLET_PASSPHRASE;
      if (!envPass) {
        throw new Error("AIFINPAY_WALLET_PASSPHRASE is required to decrypt the keystore.");
      }
      const passphrase = validatePassphrase(envPass);
      if ("seedEnc" in s && s.seedEnc) {
        seedHex = decrypt(s.seedEnc, passphrase);
        if (!/^(0x)?[0-9a-fA-F]{64}$/.test(seedHex)) throw new Error("invalid keystore.");
      } else {
        // 1.1.0 format: seed in the clear — trusted only after it re-derives
        // the sealed Solana key.
        seedHex = loadLegacyEncrypted(s, passphrase).keys.seedHex;
      }
    } else if (storedSeed(s)) {
      seedHex = storedSeed(s);
    } else {
      // Bare MCP keystore: the stored Solana key's first 32 bytes are the seed.
      seedHex = Buffer.from(bs58.decode(s.secretB58).slice(0, 32)).toString("hex");
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
    const w = loadWalletFromStore(s, index);
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
  const w = await create(localCmd === "new", localEncrypted, derivationMode, index);
  print(w, !had, localEncrypted);
};

if (isMain) {
  run().catch((e) => {
    process.stderr.write(`${(e as Error).message}\n`);
    process.exit(1);
  });
}
