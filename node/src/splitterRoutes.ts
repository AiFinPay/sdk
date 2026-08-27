/**
 * v1.3 splitter selection, keyed by chain AND protocol route.
 *
 * From v1.3 a chain carries one splitter per protocol route, because the fee
 * split is immutable at construction and the two protocols need different
 * economics:
 *
 *   merchant-aifp1 (100/0) — the agent pays the quoted gross amount, the
 *     AiFinPay treasury receives 1%, the merchant receives 99%.
 *   agent-x402 (0/0) — the provider receives 100% of the provider-defined
 *     price and the AiFinPay fee is 0% for now. This route is NOT fee-on-top;
 *     fee-on-top semantics arrive in a future contract version.
 *
 * Selection must use both chain and route, and must never fall back from one
 * route to the other. That is not a style preference. The splitters were
 * deployed with CREATE, so an address derives from deployer and nonce and the
 * same address recurs on other chains for the other route:
 *
 *   0x1Fe2021336596655Fac72bC7bC40F7FFFA501d55
 *     is OP's merchant-aifp1 AND Base's agent-x402
 *   0xF03B3387415D557b6ab709D06E8aF0b4ABD6Eb74
 *     is Unichain's merchant-aifp1, Avalanche's agent-x402, AND the legacy
 *     v1.2 splitter on Optimism
 *
 * An address on its own therefore says nothing about which economics apply.
 * Resolving by chain alone would settle at the wrong fee split, silently,
 * and the amounts would still look plausible in every log.
 *
 * Generated from the canonical registry in AiFinPay/evm-contract
 * (registry/generated/splitter-table.json, schemaVersion 2). Every field below
 * was read from the chain by verify-registry.mjs — treasury, both bps values
 * and the runtime code hash — not transcribed by hand.
 */
import { polygon, base, optimism, unichain, bsc, arbitrum, avalanche, type Chain } from "viem/chains";
import { botchain, xrplevm } from "./chains.js";

/** Protocol routes. A route is a fee profile fixed at construction. */
export type SplitterRoute = "merchant-aifp1" | "agent-x402";

/** Chains carrying v1.3 route splitters. */
export type SplitterRouteChain =
  | "polygon"
  | "optimism"
  | "bnb"
  | "unichain"
  | "botchain"
  | "base"
  | "arbitrum"
  | "avalanche"
  | "xrplevm";

/** Key into SPLITTER_ROUTES. Both halves are required. */
export type SplitterRouteKey = `${SplitterRouteChain}:${SplitterRoute}`;

export interface SplitterRouteDeployment {
  chain: SplitterRouteChain;
  route: SplitterRoute;
  chainId: number;
  viemChain: Chain;
  splitter: `0x${string}`;
  /** Owner and treasury are the same governance Safe on every chain. */
  treasury: `0x${string}`;
  /** Immutable, baked into runtime code. 100 = 1%. */
  treasuryBps: number;
  ipCreatorBps: number;
  /** keccak-256 of the deployed runtime bytecode, read from chain. */
  runtimeCodeHash: `0x${string}`;
  /**
   * Deployed and verified is not the same as payable. A route is enabled
   * individually, and only after a successful mainnet paid end-to-end
   * settlement on that exact route with verified balance deltas.
   */
  settlementEnabled: boolean;
  /** Policy review window. Outside it, a route must not settle. */
  validFrom: string;
  validUntil: string;
  defaultRpc: string;
  explorer: string;
}

export const SPLITTER_ROUTES: Record<SplitterRouteKey, SplitterRouteDeployment> = {
  "arbitrum:agent-x402": {
    chain: "arbitrum",
    route: "agent-x402",
    chainId: 42161,
    viemChain: arbitrum,
    splitter: "0xE34Fc0E6694821c600Fa0955C0F74720ea6d8440",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 0,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x0eb0f8ca7792b13ab70f2aa3e779609cd352d279e925ddcd9e901fd9fd68b1b0",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
  },
  "arbitrum:merchant-aifp1": {
    chain: "arbitrum",
    route: "merchant-aifp1",
    chainId: 42161,
    viemChain: arbitrum,
    splitter: "0x80e2B445DFc44B3B2254aa376B31AEdDd3Ff934a",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 100,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x4ba01815b55bf6ed2d608bed91f480c179fd644d706680c3e4a91d8181ba5c6b",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://arb1.arbitrum.io/rpc",
    explorer: "https://arbiscan.io",
  },
  "avalanche:agent-x402": {
    chain: "avalanche",
    route: "agent-x402",
    chainId: 43114,
    viemChain: avalanche,
    splitter: "0xF03B3387415D557b6ab709D06E8aF0b4ABD6Eb74",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 0,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x0eb0f8ca7792b13ab70f2aa3e779609cd352d279e925ddcd9e901fd9fd68b1b0",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://api.avax.network/ext/bc/C/rpc",
    explorer: "https://snowtrace.io",
  },
  "avalanche:merchant-aifp1": {
    chain: "avalanche",
    route: "merchant-aifp1",
    chainId: 43114,
    viemChain: avalanche,
    splitter: "0xE34Fc0E6694821c600Fa0955C0F74720ea6d8440",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 100,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x4ba01815b55bf6ed2d608bed91f480c179fd644d706680c3e4a91d8181ba5c6b",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://api.avax.network/ext/bc/C/rpc",
    explorer: "https://snowtrace.io",
  },
  "base:agent-x402": {
    chain: "base",
    route: "agent-x402",
    chainId: 8453,
    viemChain: base,
    splitter: "0x1Fe2021336596655Fac72bC7bC40F7FFFA501d55",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 0,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x0eb0f8ca7792b13ab70f2aa3e779609cd352d279e925ddcd9e901fd9fd68b1b0",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
  },
  "base:merchant-aifp1": {
    chain: "base",
    route: "merchant-aifp1",
    chainId: 8453,
    viemChain: base,
    splitter: "0xB385Cc32fe39CF5B5778DF0Df0e8E9978b5F662a",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 100,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x4ba01815b55bf6ed2d608bed91f480c179fd644d706680c3e4a91d8181ba5c6b",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
  },
  "bnb:agent-x402": {
    chain: "bnb",
    route: "agent-x402",
    chainId: 56,
    viemChain: bsc,
    splitter: "0x7656fb8B6627311A7d87273913D31b837Bb2b5A4",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 0,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x0eb0f8ca7792b13ab70f2aa3e779609cd352d279e925ddcd9e901fd9fd68b1b0",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://bsc-dataseed.bnbchain.org",
    explorer: "https://bscscan.com",
  },
  "bnb:merchant-aifp1": {
    chain: "bnb",
    route: "merchant-aifp1",
    chainId: 56,
    viemChain: bsc,
    splitter: "0x79D481B835Cb050FAb7a045E619A6Fb9Cd73f510",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 100,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x4ba01815b55bf6ed2d608bed91f480c179fd644d706680c3e4a91d8181ba5c6b",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://bsc-dataseed.bnbchain.org",
    explorer: "https://bscscan.com",
  },
  "botchain:agent-x402": {
    chain: "botchain",
    route: "agent-x402",
    chainId: 677,
    viemChain: botchain,
    splitter: "0x7E92FbE28aAc3a3942FDf019d29172bd02c96Cf0",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 0,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x0eb0f8ca7792b13ab70f2aa3e779609cd352d279e925ddcd9e901fd9fd68b1b0",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://rpc.botchain.ai",
    explorer: "https://scan.botchain.ai",
  },
  "botchain:merchant-aifp1": {
    chain: "botchain",
    route: "merchant-aifp1",
    chainId: 677,
    viemChain: botchain,
    splitter: "0xe855e491D0950140704DB9Cec6B7b3F725360a56",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 100,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x4ba01815b55bf6ed2d608bed91f480c179fd644d706680c3e4a91d8181ba5c6b",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://rpc.botchain.ai",
    explorer: "https://scan.botchain.ai",
  },
  "optimism:agent-x402": {
    chain: "optimism",
    route: "agent-x402",
    chainId: 10,
    viemChain: optimism,
    splitter: "0x38Ef6173ce0AC540f129680C2Aa4Ef739787bdBf",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 0,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x0eb0f8ca7792b13ab70f2aa3e779609cd352d279e925ddcd9e901fd9fd68b1b0",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://mainnet.optimism.io",
    explorer: "https://optimistic.etherscan.io",
  },
  "optimism:merchant-aifp1": {
    chain: "optimism",
    route: "merchant-aifp1",
    chainId: 10,
    viemChain: optimism,
    splitter: "0x1Fe2021336596655Fac72bC7bC40F7FFFA501d55",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 100,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x4ba01815b55bf6ed2d608bed91f480c179fd644d706680c3e4a91d8181ba5c6b",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://mainnet.optimism.io",
    explorer: "https://optimistic.etherscan.io",
  },
  "polygon:agent-x402": {
    chain: "polygon",
    route: "agent-x402",
    chainId: 137,
    viemChain: polygon,
    splitter: "0x660Cd915Fc54A7EaE5CEA6854505638bd2A08531",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 0,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x0eb0f8ca7792b13ab70f2aa3e779609cd352d279e925ddcd9e901fd9fd68b1b0",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://polygon-bor-rpc.publicnode.com",
    explorer: "https://polygonscan.com",
  },
  "polygon:merchant-aifp1": {
    chain: "polygon",
    route: "merchant-aifp1",
    chainId: 137,
    viemChain: polygon,
    splitter: "0x27C1C07563c92C1AEa52cC9b4452dF49dC5a7942",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 100,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x4ba01815b55bf6ed2d608bed91f480c179fd644d706680c3e4a91d8181ba5c6b",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://polygon-bor-rpc.publicnode.com",
    explorer: "https://polygonscan.com",
  },
  "unichain:agent-x402": {
    chain: "unichain",
    route: "agent-x402",
    chainId: 130,
    viemChain: unichain,
    splitter: "0xC701F45b3Bae9CA3a58cB33fCBA6291594D17843",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 0,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x0eb0f8ca7792b13ab70f2aa3e779609cd352d279e925ddcd9e901fd9fd68b1b0",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://mainnet.unichain.org",
    explorer: "https://uniscan.xyz",
  },
  "unichain:merchant-aifp1": {
    chain: "unichain",
    route: "merchant-aifp1",
    chainId: 130,
    viemChain: unichain,
    splitter: "0xF03B3387415D557b6ab709D06E8aF0b4ABD6Eb74",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 100,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x4ba01815b55bf6ed2d608bed91f480c179fd644d706680c3e4a91d8181ba5c6b",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://mainnet.unichain.org",
    explorer: "https://uniscan.xyz",
  },
  "xrplevm:agent-x402": {
    chain: "xrplevm",
    route: "agent-x402",
    chainId: 1440000,
    viemChain: xrplevm,
    splitter: "0x7E92FbE28aAc3a3942FDf019d29172bd02c96Cf0",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 0,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x0eb0f8ca7792b13ab70f2aa3e779609cd352d279e925ddcd9e901fd9fd68b1b0",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://rpc.xrplevm.org",
    explorer: "https://explorer.xrplevm.org",
  },
  "xrplevm:merchant-aifp1": {
    chain: "xrplevm",
    route: "merchant-aifp1",
    chainId: 1440000,
    viemChain: xrplevm,
    splitter: "0xe855e491D0950140704DB9Cec6B7b3F725360a56",
    treasury: "0xFd936f75D9221949f2FEaB54Cd342F7527154eD5",
    treasuryBps: 100,
    ipCreatorBps: 0,
    runtimeCodeHash: "0x4ba01815b55bf6ed2d608bed91f480c179fd644d706680c3e4a91d8181ba5c6b",
    settlementEnabled: false,
    validFrom: "2026-08-27T00:00:00.000Z",
    validUntil: "2026-11-25T00:00:00.000Z",
    defaultRpc: "https://rpc.xrplevm.org",
    explorer: "https://explorer.xrplevm.org",
  },};

export class UnknownSplitterRouteError extends Error {
  constructor(chain: string, route: string) {
    super(
      `No v1.3 splitter registered for ${chain}:${route}. Supported: ` +
        `${Object.keys(SPLITTER_ROUTES).join(", ")}. There is deliberately no ` +
        `fallback between routes — merchant-aifp1 and agent-x402 have different ` +
        `immutable fee splits, so substituting one for the other would settle ` +
        `at the wrong amount.`,
    );
    this.name = "UnknownSplitterRouteError";
  }
}

export class SplitterRouteNotSettlingError extends Error {
  constructor(key: string, reason: string) {
    super(`Splitter route ${key} must not settle: ${reason}`);
    this.name = "SplitterRouteNotSettlingError";
  }
}

/**
 * Resolve a splitter by chain AND route. Throws on an unknown pair rather
 * than falling back, because the fallback is the bug: every route resolves to
 * a real, deployed, working contract with the wrong economics.
 */
export function resolveSplitterRoute(
  chain: SplitterRouteChain | string,
  route: SplitterRoute | string,
): SplitterRouteDeployment {
  const entry = (SPLITTER_ROUTES as Partial<Record<string, SplitterRouteDeployment>>)[
    `${chain}:${route}`
  ];
  if (!entry) throw new UnknownSplitterRouteError(String(chain), String(route));
  return entry;
}

/**
 * Resolve a route that is cleared to move money. Separate from
 * resolveSplitterRoute on purpose: reading the registry and being allowed to
 * settle are different questions, and conflating them is how a disabled route
 * ends up paying.
 */
export function resolveSettlingSplitterRoute(
  chain: SplitterRouteChain | string,
  route: SplitterRoute | string,
  now: Date = new Date(),
): SplitterRouteDeployment {
  const entry = resolveSplitterRoute(chain, route);
  const key = `${entry.chain}:${entry.route}`;
  if (!entry.settlementEnabled) {
    throw new SplitterRouteNotSettlingError(
      key,
      "settlement is not enabled for this route yet — it is enabled only after a " +
        "successful mainnet paid end-to-end settlement with verified balance deltas",
    );
  }
  const t = now.getTime();
  if (t < Date.parse(entry.validFrom)) {
    throw new SplitterRouteNotSettlingError(key, `its policy window opens ${entry.validFrom}`);
  }
  if (t >= Date.parse(entry.validUntil)) {
    throw new SplitterRouteNotSettlingError(
      key,
      `its policy window expired ${entry.validUntil} and has not been re-reviewed`,
    );
  }
  return entry;
}
