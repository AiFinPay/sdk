import { PAYMENT_CHAINS, type Aifp1V14Chain } from "@aifinpay/agent";

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
  name: Aifp1V14Chain | "solana";
  /** How messages to the owner name it. */
  label: string;
  /** Native currency: the default pay asset and the gas currency. */
  native: string;
  /** Public RPC used when the owner sets none; also read for the Chainlink price. */
  defaultRpc: string;
  /** Chainlink <native>/USD aggregator proxy on this chain, 8 decimals. */
  chainlinkNativeUsd?: `0x${string}`;
  /** Coinbase spot pair, e.g. "ETH-USD". */
  coinbasePair: string;
  /** CoinGecko simple/price id. */
  coingeckoId: string;
  /** Upper bound of a plausible native/USD price; anything above is refused. */
  maxSaneUsd: number;
}

// Reuse the SDK's trusted chain descriptors. Feed proxies are included only
// where already independently pinned; other chains use Coinbase/CoinGecko.
const payChains = {} as Record<Aifp1V14Chain, PayChain>;
for (const name of Object.keys(PAYMENT_CHAINS) as Aifp1V14Chain[]) {
  const descriptor = PAYMENT_CHAINS[name];
  payChains[name] = Object.freeze({
    ...descriptor,
    name,
    coinbasePair: `${descriptor.native}-USD`,
    ...(name === "polygon"
      ? { chainlinkNativeUsd: "0xAB594600376Ec9fD91F8e885dADF0CE036862dE0" as const }
      : name === "base"
        ? { chainlinkNativeUsd: "0x71041dddad3595F9CEd3DcCFBe3D1F4b0a16Bb70" as const }
        : {}),
  });
}
export const PAY_CHAINS: Readonly<Record<Aifp1V14Chain, PayChain>> = Object.freeze(payChains);

export const SOLANA_PAY_CHAIN: Readonly<PayChain> = Object.freeze({
  name: "solana",
  label: "Solana",
  native: "SOL",
  defaultRpc: "https://api.mainnet-beta.solana.com",
  coinbasePair: "SOL-USD",
  coingeckoId: "solana",
  maxSaneUsd: 100_000,
});
export const PAY_CHAIN_NAMES = [...Object.keys(PAY_CHAINS), "solana"];

export function payChain(name: string | undefined): PayChain {
  if (name === "solana") return SOLANA_PAY_CHAIN;
  const key = (name ?? "polygon") as Aifp1V14Chain;
  const chain = Object.hasOwn(PAY_CHAINS, key) ? PAY_CHAINS[key] : undefined;
  if (!chain) throw new Error(`AIFINPAY_PAY_CHAIN must be one of ${PAY_CHAIN_NAMES.join(", ")}`);
  return chain;
}
