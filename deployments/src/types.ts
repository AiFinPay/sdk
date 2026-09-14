/**
 * Canonical AIFP deployment registry types.
 *
 * The registry is optimized for O(1) lookup of the latest deployment per chain.
 * It combines EVM and Solana deployments, always surfacing the newest record
 * by semantic version then timestamp.
 */

export interface Stablecoin {
  symbol: string;
  name: string;
  address: string;
}

export interface EvmDeployment {
  kind: "evm";
  chainId: number;
  network: string;
  version: string;
  splitterAddress: string;
  tokenListAddress: string;
  profilesAddress: string;
  admin: string;
  signer: string;
  pauser: string;
  treasury: string;
  runtimeCodeHash: string;
  stablecoins: Stablecoin[];
  settlementEnabled: boolean;
  status: string;
  deployedAt: string; // ISO 8601
  sourceUrl: string;
  /** Path to the local ABI bundle, once manually added. */
  abiPath: string | null;
}

export interface SolanaDeployment {
  kind: "solana";
  cluster: "mainnet" | "devnet";
  version: string;
  programAddress: string;
  deployedAt: string; // ISO 8601 from filename
  sourceUrl: string;
  /** Path to the local IDL artifact copied from the upstream deployment. */
  idlPath: string;
}

export type Deployment = EvmDeployment | SolanaDeployment;

/** O(1) map: chainId (or Solana cluster) -> latest deployment record. */
export interface DeploymentRegistry {
  /** EVM records keyed by numeric chainId as a string. */
  evm: Record<string, EvmDeployment>;
  /** Solana records keyed by cluster name. */
  solana: Record<string, SolanaDeployment>;
  /** ISO 8601 timestamp of when this registry was generated. */
  generatedAt: string;
  /** Provenance for each included record. */
  sources: string[];
}

/** Per-ecosystem split registry file shape (v1.4). */
export interface EcosystemRegistry<T extends Deployment> {
  schemaVersion: number;
  generatedAt: string;
  ecosystem: "evm" | "solana";
  protocolVersion: string;
  sources: string[];
  deployments: T[];
}

export function isEvmDeployment(d: Deployment): d is EvmDeployment {
  return d.kind === "evm";
}

export function isSolanaDeployment(d: Deployment): d is SolanaDeployment {
  return d.kind === "solana";
}
