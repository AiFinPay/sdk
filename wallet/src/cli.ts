#!/usr/bin/env node
/**
 * `npx @aifinpay/wallet` — create or show an agent wallet, no heavy install.
 *
 *   npx @aifinpay/wallet          create one if absent, else show it
 *   npx @aifinpay/wallet new      create (refuses to overwrite a funded one)
 *   npx @aifinpay/wallet show     print the existing wallet's addresses
 *   npx @aifinpay/wallet export   print the seed to back up
 *
 * The keystore is ~/.aifinpay/agent.json (mode 600) — the same file
 * @aifinpay/mcp reads, so `npx @aifinpay/mcp` picks up this wallet with no
 * further config.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, chmodSync, statSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { newWallet, walletFromSolanaSecret, type DerivedWallet } from "./index.js";

const HOME = process.env.AIFINPAY_HOME || join(homedir(), ".aifinpay");
const KEYSTORE = join(HOME, "agent.json");

function readStore(): { secretB58: string; seedHex?: string } | null {
  if (!existsSync(KEYSTORE)) return null;
  try {
    const p = JSON.parse(readFileSync(KEYSTORE, "utf8"));
    return typeof p?.secretB58 === "string" ? p : null;
  } catch {
    return null;
  }
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
      `The addresses hold nothing yet. Send POL to the EVM address to fund it.\n`,
  );
}

async function create(force: boolean): Promise<DerivedWallet> {
  const existing = readStore();
  if (existing && !force) {
    // Never silently overwrite: the file may already hold funds.
    return walletFromSolanaSecret(existing.secretB58);
  }
  if (existing && force) {
    process.stderr.write(
      `Refusing: ${KEYSTORE} already exists and may hold funds. Move it aside first.\n`,
    );
    process.exit(1);
  }
  const w = await newWallet();
  mkdirSync(HOME, { recursive: true, mode: 0o700 });
  writeFileSync(
    KEYSTORE,
    JSON.stringify({ secretB58: w.keys.solanaSecretKeyB58, seedHex: w.keys.seedHex, created: nowIso() }, null, 2) + "\n",
    { mode: 0o600 },
  );
  chmodSync(KEYSTORE, 0o600);
  return w;
}

// process.env-free timestamp: Date is fine at runtime (only the workflow VM bans it).
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

const cmd = (process.argv[2] || "").toLowerCase();

if (cmd === "-h" || cmd === "--help" || cmd === "help") {
  process.stdout.write(
    `npx @aifinpay/wallet          create if absent, else show\n` +
      `npx @aifinpay/wallet new      create (won't overwrite a funded wallet)\n` +
      `npx @aifinpay/wallet show     print addresses\n` +
      `npx @aifinpay/wallet export   print the seed to back up\n`,
  );
  process.exit(0);
}

const run = async () => {
  warnIfLoose();
  if (cmd === "export") {
    const s = readStore();
    if (!s?.seedHex) {
      process.stderr.write("no wallet with a stored seed — run `npx @aifinpay/wallet new` first.\n");
      process.exit(1);
    }
    process.stdout.write(s.seedHex + "\n");
    return;
  }
  if (cmd === "show") {
    const s = readStore();
    if (!s) {
      process.stderr.write("no wallet yet — run `npx @aifinpay/wallet new`.\n");
      process.exit(1);
    }
    print(walletFromSolanaSecret(s.secretB58), false);
    return;
  }
  if (cmd && cmd !== "new") {
    process.stderr.write(`unknown command "${cmd}". Try --help.\n`);
    process.exit(2);
  }
  // default or "new"
  const had = existsSync(KEYSTORE);
  const w = await create(cmd === "new");
  print(w, !had);
};

run().catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
