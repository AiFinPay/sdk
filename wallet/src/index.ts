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
 * in seconds. Unindexed legacy-solana mode produces the same Solana and EVM
 * addresses as @aifinpay/agent's fromSeed. Indexed derivations match the full
 * SDK's per-domain derivation. The keystore it writes is the one
 * @aifinpay/mcp reads; for indexed wallets MCP uses the stored recovery seed
 * and index, while unindexed wallets retain the existing secret-key path.
 * This light package CREATES a wallet anywhere; the full SDK is needed only
 * when you actually PAY.
 * Deprecated Casper fields remain available for legacy compatibility only.
 */
export {
  deriveWallet,
  newWallet,
  walletFromSolanaSecret,
  walletFromSeed,
  DerivationDomain,
  LEGACY_SOLANA_DERIVATION,
  MAX_DERIVATION_INDEX,
} from "./derive.js";
export type { DerivedWallet, DerivationMode } from "./derive.js";
export { run as createWalletCLI } from "./cli.js";
