// BOT Chain (677) and XRPL EVM (1440000) are not shipped with viem/chains, so
// they are defined here rather than in each module that needs them. Two
// definitions of the same chain is a drift risk: they would be edited
// separately and eventually disagree about an RPC or a chain id.
import { defineChain, type Chain } from "viem";

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
