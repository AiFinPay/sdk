#!/usr/bin/env node
/**
 * Programmatic wallet creation script with --legacy-solana support.
 * 
 * Usage:
 *   node scripts/create-wallet.ts --legacy-solana
 *   node scripts/create-wallet.ts --plain
 *   node scripts/create-wallet.ts --legacy-solana --plain
 */
import { run } from "../src/cli.js";

const args = process.argv.slice(2);
const isLegacy = args.includes("--legacy-solana");
const isPlain = args.includes("--plain");

const argv = ["node", "create-wallet"];
if (isLegacy) argv.push("--legacy-solana");
if (isPlain) argv.push("--plain");

run("new", argv).catch((e) => {
  process.stderr.write(`${(e as Error).message}\n`);
  process.exit(1);
});
