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
 * in seconds. Indexed wallets (`{ index }`) match the full SDK's per-domain
 * derivation, and @aifinpay/mcp loads them from the keystore's recovery seed
 * and index. Unindexed wallets share the SDK's EVM address but not its Solana
 * one, so MCP does not run them as the same identity.
 * This light package CREATES a wallet anywhere; the full SDK is needed only
 * when you actually PAY.
 * Tron is derived from its own `aifinpay:tron:v1\0` domain; the full SDK does
 * not derive or sign for Tron.
 */
export { deriveWallet, newWallet, walletFromSeed, DerivationDomain, MAX_DERIVATION_INDEX } from "./derive.js";
export type { DerivedWallet, ChainAccount, ChainName, DeriveOptions } from "./derive.js";
export { run as createWalletCLI } from "./cli.js";
