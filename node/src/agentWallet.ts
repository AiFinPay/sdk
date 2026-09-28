/**
 * AgentWallet — the minimal wallet surface AiFinPay settlement needs.
 *
 * Wallets and payment rails are different layers: x402/AIFP facilitators only
 * ever ask a wallet for three things — its address, a plain-message signature
 * (payment authorization), and a typed-data signature (EIP-712 / EIP-3009).
 * This interface pins exactly that surface so an external wallet (an in-house
 * signer, a hardware-backed key, a future Coinbase/Circle/MetaMask adapter)
 * can be injected without the SDK holding its private key. Any viem
 * LocalAccount satisfies this interface structurally.
 *
 * It deliberately has NO balance or send method: balances and settlement go
 * through the facilitator/backend layer, not through the wallet.
 */
export interface AgentWallet {
  readonly address: `0x${string}`;
  signMessage(args: { message: string }): Promise<`0x${string}`>;
  // `any` matches the EIP-712 payload the x402 facilitator builds; viem's LocalAccount is assignable here.
  signTypedData(args: any): Promise<`0x${string}`>;
}

import { privateKeyToAccount } from "viem/accounts";

/**
 * AgentWallet backed by a raw EVM private key — the self-custodial default,
 * identical to what `evmPrivateKey` options already build internally.
 */
export function evmPrivateKeyWallet(privateKey: `0x${string}`): AgentWallet {
  return privateKeyToAccount(privateKey) as unknown as AgentWallet;
}
