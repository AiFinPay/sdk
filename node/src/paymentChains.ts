import { V14_DEPLOYMENTS } from "./generated/v14Deployments.generated.js";

/** Owner-selectable EVM execution environments. Listing is not production activation. */
export const PAYMENT_CHAINS = Object.freeze({
  polygon: {
    chainId: 137,
    label: "Polygon",
    native: "POL",
    gasModel: "evm",
    defaultRpc: "https://polygon.drpc.org",
    coingeckoId: "polygon-ecosystem-token",
    maxSaneUsd: 1000,
  },
  base: {
    chainId: 8453,
    label: "Base",
    native: "ETH",
    gasModel: "op",
    defaultRpc: "https://mainnet.base.org",
    coingeckoId: "ethereum",
    maxSaneUsd: 100000,
  },
  optimism: {
    chainId: 10,
    label: "Optimism",
    native: "ETH",
    gasModel: "op",
    defaultRpc: "https://mainnet.optimism.io",
    coingeckoId: "ethereum",
    maxSaneUsd: 100000,
  },
  arbitrum: {
    chainId: 42161,
    label: "Arbitrum",
    native: "ETH",
    gasModel: "nitro",
    defaultRpc: "https://arb1.arbitrum.io/rpc",
    coingeckoId: "ethereum",
    maxSaneUsd: 100000,
  },
  avalanche: {
    chainId: 43114,
    label: "Avalanche",
    native: "AVAX",
    gasModel: "evm",
    defaultRpc: "https://api.avax.network/ext/bc/C/rpc",
    coingeckoId: "avalanche-2",
    maxSaneUsd: 100000,
  },
  bnb: {
    chainId: 56,
    label: "BNB Chain",
    native: "BNB",
    gasModel: "evm",
    defaultRpc: "https://bsc-dataseed1.bnbchain.org",
    coingeckoId: "binancecoin",
    maxSaneUsd: 100000,
  },
  unichain: {
    chainId: 130,
    label: "Unichain",
    native: "ETH",
    gasModel: "op",
    defaultRpc: "https://mainnet.unichain.org",
    coingeckoId: "ethereum",
    maxSaneUsd: 100000,
  },
  xrplevm: {
    chainId: 1440000,
    label: "XRPL EVM",
    native: "XRP",
    gasModel: "evm",
    defaultRpc: "https://rpc.xrplevm.org",
    coingeckoId: "ripple",
    maxSaneUsd: 1000,
  },
  robinhood: {
    chainId: 4663,
    label: "Robinhood",
    native: "ETH",
    gasModel: "nitro",
    defaultRpc: "https://rpc.mainnet.chain.robinhood.com",
    coingeckoId: "ethereum",
    maxSaneUsd: 100000,
  },
} as const);

for (const descriptor of Object.values(PAYMENT_CHAINS)) Object.freeze(descriptor);

export type PaymentChain = keyof typeof PAYMENT_CHAINS;

/** Unknown names never fall through to a default or to the deprecated BOT network. */
export function paymentChain(name: string): (typeof PAYMENT_CHAINS)[PaymentChain] | undefined {
  return Object.hasOwn(PAYMENT_CHAINS, name) ? PAYMENT_CHAINS[name as PaymentChain] : undefined;
}

// Independent decimal pins, keyed by network AND token address. The registry
// still selects the allowed address; a new symbol/address cannot inherit 6.
// BNB and Robinhood18dp were read on2026-10-04 (release evidence). Other
// addresses retain the shipped6dp pins. XRPL EVM has no pinned stablecoin.
const TOKEN_DECIMALS: Readonly<Record<string, Readonly<Record<string, 6 | 18>>>> = {
  polygon: { "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359": 6, "0x2791bca1f2de4661ed88a30c99a7a9449aa84174": 6 },
  base: { "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913": 6 },
  optimism: { "0x0b2c639c533813f4aa9d7837caf62653d097ff85": 6 },
  arbitrum: { "0xaf88d065e77c8cc2239327c5edb3a432268e5831": 6 },
  avalanche: { "0xb97ef9ef8734c71904d8002f8b6bc66dd9c48a6e": 6, "0x9702230a8ea53601f5cd2dc00fdbc13d4df4a8c7": 6 },
  bnb: { "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d": 18, "0x55d398326f99059ff775485246999027b3197955": 18 },
  unichain: { "0x078d782b760474a361dda0af3839290b0ef57ad6": 6 },
  robinhood: { "0x5d3a1ff2b6bab83b63cd9ad0787074081a52ef34": 18, "0x5fc5360d0400a0fd4f2af552add042d716f1d168": 6 },
  amoy: { "0x41e94eb019c0762f9bfcf9fb1e58725bfb0e7582": 6 },
};

export function pinnedTokenDecimals(chain: string, token: string): 6 | 18 | undefined {
  return Object.hasOwn(TOKEN_DECIMALS, chain) ? TOKEN_DECIMALS[chain][token.toLowerCase()] : undefined;
}

/** Descriptor exists only when BOTH the deployed address and its decimals are pinned. */
export function paymentStableAsset(
  chain: PaymentChain,
  asset: string
): { symbol: string; address: `0x${string}`; decimals: 6 | 18 } | undefined {
  const pin = V14_DEPLOYMENTS[chain]?.splitter.assets.find((a) => a.symbol === asset);
  const decimals = pin && pinnedTokenDecimals(chain, pin.address);
  return pin && decimals ? { ...pin, decimals } : undefined;
}
