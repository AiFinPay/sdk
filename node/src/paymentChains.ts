import { V14_DEPLOYMENTS } from "./generated/v14Deployments.generated.js";

export interface PaymentChainDescriptor {
  chainId: number;
  label: string;
  /** Gas currency, and the native pay asset unless stablecoinOnly. */
  native: string;
  gasModel: "evm" | "op" | "nitro";
  defaultRpc: string;
  coingeckoId: string;
  maxSaneUsd: number;
  /** The gas token is itself a pinned stablecoin (Arc: native USDC is an
   *  18-decimal view of the 6-decimal ERC-20). Payment goes only through the
   *  pinned token; there is no native quote, and the native symbol names it. */
  stablecoinOnly?: true;
  /** The gas token has no independent USD price (BOT Chain: no feed on our
   *  backend or the public price sources), so there is no native quote to
   *  cross-check. Payment goes only through a pinned stablecoin; gas is still
   *  paid in the native token. coingeckoId is empty and never fetched. */
  noNativePayment?: true;
  /** Test network: quotes are network_mode "test", never live money. */
  testnet?: true;
}

const DESCRIPTORS = {
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
  // Paid in Bridged USDT only; gas is BOT, which has no USD price source.
  botchain: {
    chainId: 677,
    label: "BOT Chain",
    native: "BOT",
    gasModel: "evm",
    defaultRpc: "https://rpc.botchain.ai",
    coingeckoId: "",
    maxSaneUsd: 1000,
    noNativePayment: true,
  },
  // Gas is native USDC at $1 per 10^18 units, so a gas cap in native units is
  // already a USD amount. No price feed is read: there is no native payment.
  arc: {
    chainId: 5042,
    label: "Arc",
    native: "USDC",
    gasModel: "evm",
    defaultRpc: "https://rpc.blockdaemon.mainnet.arc.io",
    coingeckoId: "usd-coin",
    maxSaneUsd: 2,
    stablecoinOnly: true,
  },
  arctestnet: {
    chainId: 5042002,
    label: "Arc Testnet",
    native: "USDC",
    gasModel: "evm",
    defaultRpc: "https://rpc.blockdaemon.testnet.arc.io",
    coingeckoId: "usd-coin",
    maxSaneUsd: 2,
    stablecoinOnly: true,
    testnet: true,
  },
} as const satisfies Record<string, PaymentChainDescriptor>;

export type PaymentChain = keyof typeof DESCRIPTORS;

/** Owner-selectable EVM execution environments. Listing is not production activation. */
export const PAYMENT_CHAINS: Readonly<Record<PaymentChain, Readonly<PaymentChainDescriptor>>> =
  Object.freeze(DESCRIPTORS);

for (const descriptor of Object.values(PAYMENT_CHAINS)) Object.freeze(descriptor);

/** Unknown names never fall through to a default network. */
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
  // Bridged USDT, ERC-20 decimals() read 2026-10-29.
  botchain: { "0xababc7ddc03e501d190c676bf3d92ef0e6e87a3c": 6 },
  // ERC-20 decimals() read 2026-10-26. EURC is deliberately not pinned.
  arc: { "0x3600000000000000000000000000000000000000": 6 },
  arctestnet: { "0x3600000000000000000000000000000000000000": 6 },
};

/** Whether msg.value may pay: false on stablecoinOnly and noNativePayment chains. */
export function nativePayable(descriptor: PaymentChainDescriptor): boolean {
  return descriptor.stablecoinOnly !== true && descriptor.noNativePayment !== true;
}

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
