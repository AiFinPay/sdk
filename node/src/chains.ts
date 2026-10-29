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

export const arc: Chain = defineChain({
  id: 5042,
  name: "Arc",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.blockdaemon.mainnet.arc.io", "https://rpc.drpc.mainnet.arc.io"] } },
  blockExplorers: { default: { name: "Arc Explorer", url: "https://explorer.arc.io" } },
});

export const arcTestnet: Chain = defineChain({
  id: 5042002,
  name: "Arc Testnet",
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.blockdaemon.testnet.arc.io", "https://rpc.drpc.testnet.arc.io"] } },
  blockExplorers: { default: { name: "ArcScan", url: "https://testnet.arcscan.app" } },
  testnet: true,
});
