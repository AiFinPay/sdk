// Robinhood Chain and XRPL EVM are not shipped with viem/chains, so
// they are defined here rather than in each module that needs them. Two
// definitions of the same chain is a drift risk: they would be edited
// separately and eventually disagree about an RPC or a chain id.
import { defineChain, type Chain } from "viem";

/**
 * @deprecated BOT Chain (chainId: 677) is deprecated. Use robinhood (chainId: 4663) instead.
 * This export is retained for backward compatibility and will be removed in a future version.
 */
export const botchain: Chain = defineChain({
  id: 677,
  name: "BOT Chain",
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.botchain.ai"] } },
  blockExplorers: {
    default: { name: "BOT Chain Explorer", url: "https://scan.botchain.ai" },
  },
});

export const xrplevm: Chain = defineChain({
  id: 1440000,
  name: "XRPL EVM",
  nativeCurrency: { name: "XRP", symbol: "XRP", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xrplevm.org"] } },
  blockExplorers: {
    default: { name: "XRPL EVM Explorer", url: "https://explorer.xrplevm.org" },
  },
});

/** Metadata only. v1.4 settlement remains disabled until the TokenList and
 * backend verification gates pass. */
export const robinhood: Chain = defineChain({
  id: 4663,
  name: "Robinhood Chain",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.mainnet.chain.robinhood.com"] } },
  blockExplorers: {
    default: {
      name: "Robinhood Chain Blockscout",
      url: "https://robinhoodchain.blockscout.com",
    },
  },
});
