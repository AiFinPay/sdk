// DO NOT EDIT BY HAND. Bundled copy of the Solana splitter v1.4 deployment
// artifacts from AiFinPay/solana-contract, so a shipped build resolves the
// Solana program id without a runtime GitHub fetch — the same discipline as
// v14Deployments.generated.ts (EVM) and splitterRoutes.generated.ts.
//
// Source: AiFinPay/solana-contract @ dev (commit
// 8a13d10d6210cd37345f7ae6684068bf849e24b1), files:
//   deployments/splitter_v14/splitter.mainnet.20260910-170049.json  (mainnet IDL)
//   deployments/splitter_v14/splitter-mainnet-deploy-20260910-170049.log
//   deployments/splitter_v14/splitter.devnet.20260910-143306.json   (devnet IDL)
//   deployments/splitter_v14/splitter-deploy-20260910-143306.log
//
// To refresh: read the same files off solana-contract's dev branch, e.g.
//   git show origin/dev:deployments/splitter_v14/splitter.mainnet.<ts>.json
// and update the program ids below. Development deployments are, by design,
// devnet; production is mainnet-beta. The program id in each entry is the
// canonical program id confirmed in the deploy log for that cluster.
//
// NOTE ON FALLBACK: unlike EVM (which falls back v1.4 -> v1.2), Solana has NO
// v1.2-equivalent splitter to fall back to. The previous Solana program
// (5g9zWHF1Vv6GiGpA2ZbJQbSCDZd5hAk9AyvabRJvKFx2) was closed and removed from
// mainnet, and the SDK never bundled it — it takes the program id at runtime
// from the bridge's pay_solana challenge. So the Solana resolver offers v1.4
// only; "auto" resolves v1.4 and raises a typed no-deployment error where v1.4
// is absent rather than inventing a downgrade.

import type { SdkEnvironment } from "./deploymentResolver.js";

/** Solana clusters the resolver understands. `dev` maps to devnet, `prod` to
 *  mainnet-beta. */
export type SolanaNetwork = "devnet" | "mainnet";

/** A Solana splitter v1.4 deployment, as recorded by the deploy scripts. */
export interface SolanaV14Deployment {
  network: SolanaNetwork;
  /** Which SDK environment this deployment belongs to: devnet is the dev
   *  target, mainnet is prod. */
  environment: SdkEnvironment;
  splitterVersion: "1.4";
  /** Base58 on-chain program id, from the deploy log's "Canonical program ID
   *  confirmed" line. Never hardcoded in resolver logic — read from here. */
  programId: string;
  /** IDL metadata (Anchor), for callers that load the IDL. */
  idl: {
    name: string;
    version: string;
    /** Path of the source IDL artifact in solana-contract, for provenance. */
    artifact: string;
  };
}

/** Where this table came from, so a build can be traced to a commit. */
export const SOLANA_V14_DEPLOYMENTS_SOURCE = {
  repo: "AiFinPay/solana-contract",
  branch: "dev",
  commit: "8a13d10d6210cd37345f7ae6684068bf849e24b1",
  path: "deployments/splitter_v14/",
} as const;

/** Solana v1.4 deployments, keyed by cluster. Devnet is dev-only; mainnet is
 *  prod-only. Absence of a cluster here means no v1.4 deployment for it. */
export const SOLANA_V14_DEPLOYMENTS: Record<string, SolanaV14Deployment> = {
  devnet: {
    network: "devnet",
    environment: "dev",
    splitterVersion: "1.4",
    programId: "Dg9v95m6ofTwaU9V69PNAyRaKeELwxrne4THUYuUTeon",
    idl: {
      name: "splitter",
      version: "1.4.1",
      artifact:
        "deployments/splitter_v14/splitter.devnet.20260910-143306.json",
    },
  },
  mainnet: {
    network: "mainnet",
    environment: "prod",
    splitterVersion: "1.4",
    programId: "8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y",
    idl: {
      name: "splitter",
      version: "1.4.1",
      artifact:
        "deployments/splitter_v14/splitter.mainnet.20260910-170049.json",
    },
  },
};

/** The single development cluster Solana v1.4 supports today. */
export const SOLANA_DEV_NETWORKS = ["devnet"] as const;
