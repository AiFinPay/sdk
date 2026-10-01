import type { Aifp1V14Chain } from "@aifinpay/agent";

/**
 * The chains payable_fetch can settle on, and everything that differs between
 * them. The owner picks one with AIFINPAY_PAY_CHAIN; nothing here is ever taken
 * from a quote or a tool argument.
 *
 * Adding a chain is one entry, once @aifinpay/agent can settle on it (its
 * Aifp1V14Chain type is the gate — an entry the SDK cannot pay on does not
 * compile) and the backend serves it.
 */
export interface PayChain {
  name: Aifp1V14Chain;
  /** How messages to the owner name it. */
  label: string;
  /** Native currency: the default pay asset and the gas currency. */
  native: string;
  /** Public RPC used when the owner sets none; also read for the Chainlink price. */
  defaultRpc: string;
  /** Chainlink <native>/USD aggregator proxy on this chain, 8 decimals. */
  chainlinkNativeUsd: `0x${string}`;
  /** Coinbase spot pair, e.g. "ETH-USD". */
  coinbasePair: string;
  /** CoinGecko simple/price id. */
  coingeckoId: string;
  /** Upper bound of a plausible native/USD price; anything above is refused. */
  maxSaneUsd: number;
}

export const PAY_CHAINS: Readonly<Record<Aifp1V14Chain, PayChain>> = Object.freeze({
  polygon: {
    name: "polygon",
    label: "Polygon",
    native: "POL",
    defaultRpc: "https://polygon.drpc.org",
    // MATIC/USD proxy; POL replaced MATIC 1:1 and the feed kept its name. Read
    // 2026-09-23: 0.1064, updated 3 s earlier, within 0.1% of Coinbase.
    chainlinkNativeUsd: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0",
    coinbasePair: "POL-USD",
    // NOT matic-network: that id stopped updating in February 2026 and answers
    // a stale, higher price.
    coingeckoId: "polygon-ecosystem-token",
    maxSaneUsd: 1000,
  },
  base: {
    name: "base",
    label: "Base",
    native: "ETH",
    defaultRpc: "https://mainnet.base.org",
    // "ETH / USD" proxy on Base. Read 2026-10-01: 2689.997, updated 50 s
    // earlier; Coinbase 2690.635, CoinGecko 2692.5.
    chainlinkNativeUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70",
    coinbasePair: "ETH-USD",
    coingeckoId: "ethereum",
    maxSaneUsd: 100_000,
  },
});

export const PAY_CHAIN_NAMES = Object.keys(PAY_CHAINS) as Aifp1V14Chain[];

export function payChain(name: string | undefined): PayChain {
  const key = (name ?? "polygon") as Aifp1V14Chain;
  const chain = Object.hasOwn(PAY_CHAINS, key) ? PAY_CHAINS[key] : undefined;
  if (!chain) throw new Error(`AIFINPAY_PAY_CHAIN must be one of ${PAY_CHAIN_NAMES.join(", ")}`);
  return chain;
}
