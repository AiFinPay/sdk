/**
 * @aifinpay/wallet — derive an AiFinPay agent wallet with four tiny crypto
 * dependencies and nothing else.
 *
 * `@aifinpay/agent` is the full SDK: it derives keys AND signs transactions, so
 * installing it pulls viem + @solana/web3.js — ~142 packages, ~157 MB. In a
 * constrained agent sandbox that install does not merely bloat, it FAILS (a real
 * Grok run died on TAR_ENTRY_ERROR after 14 minutes and never got a wallet).
 *
 * Making a wallet needs none of that. This package installs 4 packages / ~4.5 MB
 * in seconds. In legacy-solana mode it produces the same Solana, EVM and Casper
 * addresses as @aifinpay/agent's fromSeed (pinned to SDK-computed vectors in
 * tests/cli-and-derivation.test.ts). The keystore it writes is the one
 * @aifinpay/mcp reads; MCP derives every address from the stored Solana key,
 * which matches only for a legacy-solana wallet. This light package CREATES a
 * wallet anywhere; the full SDK is needed only when you actually PAY.
 */
export { deriveWallet, newWallet, walletFromSolanaSecret, walletFromSeed, DerivationDomain, LEGACY_SOLANA_DERIVATION } from "./derive.js";
export type { DerivedWallet, DerivationMode } from "./derive.js";
export { run as createWalletCLI } from "./cli.js";
