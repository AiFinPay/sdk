/**
 * Example: Creating wallets with @aifinpay/wallet
 * 
 * This example shows how to use the library programmatically
 * with different derivation modes including --legacy-solana.
 */

import { newWallet, deriveWallet, createWalletCLI } from "@aifinpay/wallet";

async function example() {
  // Example 1: Create wallet with standard derivation (recommended)
  const standardWallet = await newWallet({ mode: "standard" });
  console.log("Standard wallet:");
  console.log("  EVM:", standardWallet.evmAddress);
  console.log("  Solana:", standardWallet.solanaAddress);
  console.log("  Mode:", standardWallet.derivationMode);

  // Example 2: Create wallet with legacy Solana derivation (not recommended)
  // Use this only for compatibility with existing wallets
  const legacyWallet = await newWallet({ mode: "legacy-solana" });
  console.log("\nLegacy Solana wallet:");
  console.log("  EVM:", legacyWallet.evmAddress);
  console.log("  Solana:", legacyWallet.solanaAddress);
  console.log("  Mode:", legacyWallet.derivationMode);

  // Example 3: Recover wallet from existing seed
  const seedHex = legacyWallet.keys.seedHex;
  const recovered = deriveWallet(seedHex, { mode: "legacy-solana" });
  console.log("\nRecovered wallet from seed:");
  console.log("  EVM:", recovered.evmAddress);
  console.log("  Solana:", recovered.solanaAddress);
  console.log("  Mode:", recovered.derivationMode);

  // Example 4: Use CLI function programmatically with --legacy-solana
  // Note: This creates a keystore file at ~/.aifinpay/agent.json
  try {
    await createWalletCLI("new", ["node", "example", "--legacy-solana"]);
    console.log("\nWallet created via CLI with legacy-solana mode");
  } catch (error) {
    console.error("CLI error:", (error as Error).message);
  }
}

example().catch(console.error);
