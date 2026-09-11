// DO NOT EDIT BY HAND. Bundled copy of the B2BSplitter v1.4 deployment
// artifacts from AiFinPay/evm-contract, so a shipped build resolves v1.4
// addresses without a runtime GitHub fetch — the same discipline as
// splitterRoutes.generated.ts.
//
// Source: AiFinPay/evm-contract @ dev (commit
// 67b3f518dbc615961f2207761fa6320e6c1a42ff), files:
//   deployments/amoy-v14-amoy-latest.json      + amoy-safe-multisig-latest.json
//   deployments/polygon-v14-polygon-latest.json + polygon-safe-multisig-latest.json
//
// To refresh: read the same files off evm-contract's dev branch, e.g.
//   git show origin/dev:deployments/polygon-v14-polygon-latest.json
// and update the entries below. Development deployments are, by design, read
// from the dev branch; production deployments from the same shared deployments
// directory. Every address here was written by the v1.4 deploy scripts and
// its runtimeCodeHash is the keccak-256 of the deployed runtime bytecode.

import type { SdkEnvironment } from "./deploymentResolver.js";

/** The v1.4 splitter's role holders and linked contracts, exactly as the
 *  deploy artifact records them. address(0) in a token slot means the token is
 *  not configured on that network (native settlement only for it). */
export interface V14Splitter {
  address: `0x${string}`;
  /** DEFAULT_ADMIN_ROLE holder (governance). */
  admin: `0x${string}`;
  /** SIGN_OPERATOR_ROLE holder — the only key that can sign a v1.4 quote. */
  signer: `0x${string}`;
  /** PAUSER_ROLE holder. */
  pauser: `0x${string}`;
  treasury: `0x${string}`;
  /** External TokenList contract (owner-mutable stablecoin allowlist). */
  tokenList: `0x${string}`;
  /** External Profiles contract (route fee profiles). */
  profiles: `0x${string}`;
  usdc: `0x${string}`;
  usdt: `0x${string}`;
}

/** The Gnosis Safe that holds admin authority over the v1.4 splitter. */
export interface V14Safe {
  address: `0x${string}`;
  version: string;
  threshold: number;
  owners: readonly `0x${string}`[];
}

export interface V14Deployment {
  network: string;
  chainId: number;
  /** Which SDK environment this deployment belongs to. Amoy is the dev target;
   *  the production networks carry env "prod". */
  environment: SdkEnvironment;
  splitterVersion: "1.4";
  splitter: V14Splitter;
  /** keccak-256 of the deployed runtime bytecode, from the deploy artifact. */
  runtimeCodeHash: `0x${string}`;
  safe: V14Safe;
}

/** Where this table came from, so a build can be traced to a commit. */
export const V14_DEPLOYMENTS_SOURCE = {
  repo: "AiFinPay/evm-contract",
  branch: "dev",
  commit: "67b3f518dbc615961f2207761fa6320e6c1a42ff",
  path: "deployments/",
} as const;

/** v1.4 EVM deployments, keyed by network name. Amoy is dev-only; Polygon is a
 *  production network. Chains absent here have no v1.4 deployment yet, which is
 *  what makes `version: "auto"` fall back to v1.2 for them. */
export const V14_DEPLOYMENTS: Record<string, V14Deployment> = {
  amoy: {
    network: "amoy",
    chainId: 80002,
    environment: "dev",
    splitterVersion: "1.4",
    splitter: {
      address: "0xBdC126193FADf38A86Cd509e56018a95d5B6eeFA",
      admin: "0x00009352dc8a1041A724c01632dc549935e05B98",
      signer: "0x0000e81aEf36D89373FBF0012550B10B63dAa873",
      pauser: "0x00008a55086A450Dc8D7789312D21ACEa142F45e",
      treasury: "0x0000DA1886e173C09A4e04723d8226D84d9c5122",
      tokenList: "0xe67E48966a67AaaaDE5A97F6196E66cd5B16Ac3F",
      profiles: "0x632082e6b99E567005FA4e87774AC199Df9a81a6",
      usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582",
      usdt: "0x0000000000000000000000000000000000000000",
    },
    runtimeCodeHash:
      "0xd4990487312c00916aa218bdcd697bbf1a2729335b6a4fda903517b9d3153a27",
    safe: {
      address: "0xc9ab36c2af2888414c7ea9160d9e33b773c2b388",
      version: "1.4.1",
      threshold: 3,
      owners: [
        "0x25A834b6fEC79e9ee6ED04Ef5b97440149C6Cc24",
        "0x2118c57dEBD53f614DDfE464Ff2941BE6646cA82",
        "0x3C31dd9daCeC5473cC9B660CD69247A20701cF19",
        "0x588A80e94a762C670711ff77CC60a2e65E64F53A",
      ],
    },
  },
  polygon: {
    network: "polygon",
    chainId: 137,
    environment: "prod",
    splitterVersion: "1.4",
    splitter: {
      address: "0x78bed24B8D3A5eB2cf8D9A0D6A9Da6Bc5d7f32eB",
      admin: "0x01b80329ff81ce1d22a9e2e8807df5f92414c3c3",
      signer: "0x0000e81aEf36D89373FBF0012550B10B63dAa873",
      pauser: "0x01b80329ff81ce1d22a9e2e8807df5f92414c3c3",
      treasury: "0x01b80329ff81ce1d22a9e2e8807df5f92414c3c3",
      tokenList: "0xbA98C0797707611787B04680E260036573D9D7a1",
      profiles: "0x4dcDd923d9c45bd306aA21c4438B3D325f8F783C",
      usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
      usdt: "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174",
    },
    runtimeCodeHash:
      "0x974b871ac79082d92a7e3bba89ba52794f7906f99119dfad7959017e5b0bf038",
    safe: {
      address: "0x01b80329ff81ce1d22a9e2e8807df5f92414c3c3",
      version: "1.5.0",
      threshold: 3,
      owners: [
        "0x25A834b6fEC79e9ee6ED04Ef5b97440149C6Cc24",
        "0x2118c57dEBD53f614DDfE464Ff2941BE6646cA82",
        "0x3C31dd9daCeC5473cC9B660CD69247A20701cF19",
        "0x588A80e94a762C670711ff77CC60a2e65E64F53A",
      ],
    },
  },
};

/** The single development network v1.4 supports today. */
export const V14_DEV_NETWORKS = ["amoy"] as const;
