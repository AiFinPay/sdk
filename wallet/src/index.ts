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
 * in seconds and produces the exact same Solana, EVM and Casper addresses the
 * full SDK would — verified byte-for-byte against @aifinpay/agent in CI. The
 * keystore it writes is the one @aifinpay/mcp reads, so the division of labour is
 * clean: this light package to CREATE a wallet anywhere, the full SDK only when
 * you actually PAY.
 */
export { deriveWallet, newWallet, walletFromSolanaSecret } from "./derive.js";
export type { DerivedWallet } from "./derive.js";
