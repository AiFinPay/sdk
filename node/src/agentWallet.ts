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
import { stringToHex, type WalletClient } from "viem";

export type EvmWalletClient = WalletClient;

/**
 * AgentWallet backed by a raw EVM private key — the self-custodial default,
 * identical to what `evmPrivateKey` options already build internally.
 */
export function evmPrivateKeyWallet(privateKey: `0x${string}`): AgentWallet {
  return privateKeyToAccount(privateKey) as unknown as AgentWallet;
}

/**
 * Minimal EIP-1193 provider shape (`window.ethereum`, Coinbase Wallet, Rabby,
 * WalletConnect's Ethereum provider, …). Only `request` is used — no vendor
 * SDK, no new dependency.
 */
export interface Eip1193Provider {
  request(args: { method: string; params?: unknown }): Promise<unknown>;
}

/**
 * AgentWallet backed by a browser/injected EIP-1193 wallet (MetaMask and any
 * generic EVM wallet exposing the provider API). The address is read via
 * `eth_requestAccounts`, so construction is async. Message signing uses
 * `personal_sign`, typed-data signing uses `eth_signTypedData_v4`.
 *
 * The provider is fully trusted with signing: the SDK never sees key
 * material, but a malicious provider can sign anything it is asked for —
 * same as any dapp connection. Connect only wallets the owner controls.
 */
export async function eip1193Wallet(provider: Eip1193Provider): Promise<AgentWallet> {
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as string[];
  const address = accounts?.[0] as `0x${string}` | undefined;
  if (!address) {
    throw new Error("eip1193Wallet: the provider returned no accounts");
  }
  return {
    address,
    signMessage: async ({ message }) =>
      (await provider.request({
        method: "personal_sign",
        params: [stringToHex(message), address],
      })) as `0x${string}`,
    signTypedData: async (typedData) =>
      (await provider.request({
        method: "eth_signTypedData_v4",
        params: [address, JSON.stringify(typedData)],
      })) as `0x${string}`,
  };
}

/**
 * AgentWallet backed by a viem `WalletClient` — the integration point for
 * embedded/smart wallets that hand out viem clients (Privy, Crossmint,
 * ZeroDev, Coinbase Smart Wallet, custom transports). The client must carry
 * an account; transports are never touched by the adapter itself, so no
 * network access happens here beyond what the caller's client already does.
 */
export function viemWalletClientWallet(client: WalletClient): AgentWallet {
  const account = client.account;
  if (!account) {
    throw new Error("viemWalletClientWallet: the WalletClient has no account");
  }
  if (!/^0x[0-9a-f]{40}$/i.test(account.address)) {
    throw new Error("viemWalletClientWallet: the WalletClient has an invalid account address");
  }
  if (typeof client.signMessage !== "function" || typeof client.signTypedData !== "function") {
    throw new Error("viemWalletClientWallet: the WalletClient cannot sign messages and typed data");
  }
  return {
    address: account.address,
    signMessage: (args) => client.signMessage({ ...args, account }),
    signTypedData: (args) => client.signTypedData({ ...args, account }),
  };
}
