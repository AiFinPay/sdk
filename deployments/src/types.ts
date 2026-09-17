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
  idlPath: string | null;
  /** IDL metadata */
  idl: {
    name: string;
    version: string;
  } | null;
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

/** Per-ecosystem split registry file shape (v1.4) - matches splitter versioned deployments.json schema. */
export interface GovernanceConfig {
  safe: string;
  version: string;
  threshold: number;
  owners: string[];
}

export interface Governance {
  prod: GovernanceConfig;
  testnet: GovernanceConfig;
}

export interface SourceInfo {
  repo: string;
  commit: string;
  path: string;
}

export interface SourceArtifact {
  path: string;
  retrievedAt: string;
}

export interface EvmDeploymentRecord {
  chain: string;
  chainId: number;
  environment: "dev" | "prod";
  testnet: boolean;
  status: "enabled" | "disabled" | "invalid" | "retired";
  settlementEnabled: boolean;
  disabledReason?: string;
  runtimeCodeHash: string;
  contracts: {
    splitter: string;
    tokenList: string;
    profiles: string;
    admin: string;
    signer: string;
    pauser: string;
    treasury: string;
  };
  assets: Array<{
    symbol: string;
    name: string;
    address: string;
  }>;
  safe: {
    address: string;
    version: string;
    threshold: number;
  };
}

export interface SolanaDeploymentRecord {
  cluster: "mainnet" | "devnet";
  environment: "dev" | "prod";
  testnet: boolean;
  status: "enabled" | "disabled" | "invalid" | "retired";
  settlementEnabled: boolean;
  disabledReason: string;
  programId: string;
  idl: {
    name: string;
    version: string;
  };
  sourceArtifact: string;
}

export interface SplitterRegistry {
  $schema: string;
  version: string;
  description: string;
  schemaVersion: number;
  generatedAt: string;
  ecosystem: "evm" | "solana";
  protocolVersion: string;
  source: SourceInfo;
  governance?: Governance; // Only for EVM
  deployments: EvmDeploymentRecord[] | SolanaDeploymentRecord[];
  sourceArtifact: SourceArtifact;
}

export function isEvmDeployment(d: Deployment): d is EvmDeployment {
  return d.kind === "evm";
}

export function isSolanaDeployment(d: Deployment): d is SolanaDeployment {
  return d.kind === "solana";
}
