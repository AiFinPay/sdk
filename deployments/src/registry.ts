import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  EvmDeploymentRecord,
  SolanaDeploymentRecord,
  SplitterRegistry,
  Governance,
} from "./types.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_ROOT = join(__dirname, "../registry");

const EVM_VERSIONS = ["1.1", "1.2", "1.3", "1.4", "latest"] as const;
type EvmVersion = typeof EVM_VERSIONS[number];

function resolveEvmVersion(version: EvmVersion): string {
  if (version === "latest") return "1.4";
  return version;
}

/**
 * Programmatic interface to query AIFP deployment records.
 * Provides type-safe access to EVM and Solana deployments with O(1) lookups.
 */
export class AifinpayRegistry {
  private evmRegistry: Map<number, EvmDeploymentRecord>;
  private solanaRegistry: Map<string, SolanaDeploymentRecord>;
  private governance?: Governance;
  private readonly version: string;
  private readonly generatedAt: string;

  private constructor(
    evmRecords: EvmDeploymentRecord[],
    solanaRecords: SolanaDeploymentRecord[],
    version: string,
    generatedAt: string,
    governance?: Governance,
  ) {
    this.evmRegistry = new Map(
      evmRecords.map((r) => [r.chainId, r]),
    );
    this.solanaRegistry = new Map(
      solanaRecords.map((r) => [r.cluster, r]),
    );
    this.version = version;
    this.generatedAt = generatedAt;
    this.governance = governance;
  }

  /**
   * Load EVM registry.
   * @param version - EVM version to load. Accepts "1.1", "1.2", "1.3", "1.4", or "latest". Defaults to "latest".
   */
  static loadEvm(version: EvmVersion = "latest"): AifinpayRegistry {
    const resolved = resolveEvmVersion(version);
    const path = join(REGISTRY_ROOT, `splitter/evm/v${resolved}/deployments.json`);
    const data = JSON.parse(readFileSync(path, "utf-8")) as SplitterRegistry & {
      governance?: Governance;
      deployments: EvmDeploymentRecord[];
    };
    return new AifinpayRegistry(
      data.deployments,
      [],
      data.version,
      data.generatedAt,
      data.governance,
    );
  }

  /**
   * Load Solana registry.
   * @param _version - Solana version to load. Accepts "1.4" or "latest". Defaults to "latest".
   */
  static loadSolana(_version: "1.4" | "latest" = "latest"): AifinpayRegistry {
    const path = join(REGISTRY_ROOT, "splitter/solana/deployments.json");
    const data = JSON.parse(readFileSync(path, "utf-8")) as SplitterRegistry & {
      deployments: SolanaDeploymentRecord[];
    };
    return new AifinpayRegistry(
      [],
      data.deployments,
      data.version,
      data.generatedAt,
    );
  }

  /**
   * Get EVM deployment by chain ID.
   * Returns null if not found.
   */
  getEvmDeployment(chainId: number): EvmDeploymentRecord | null {
    return this.evmRegistry.get(chainId) ?? null;
  }

  /**
   * Get EVM deployment by network name (e.g., "optimism", "polygon").
   * Returns null if not found.
   */
  getEvmByNetwork(network: string): EvmDeploymentRecord | null {
    for (const record of this.evmRegistry.values()) {
      if (record.chain.toLowerCase() === network.toLowerCase()) {
        return record;
      }
    }
    return null;
  }

  /**
   * Get all EVM deployments.
   */
  getAllEvmDeployments(): EvmDeploymentRecord[] {
    return Array.from(this.evmRegistry.values());
  }

  /**
   * Get Solana deployment by cluster.
   * Returns null if not found.
   */
  getSolanaDeployment(cluster: "mainnet" | "devnet"): SolanaDeploymentRecord | null {
    return this.solanaRegistry.get(cluster) ?? null;
  }

  /**
   * Get all Solana deployments.
   */
  getAllSolanaDeployments(): SolanaDeploymentRecord[] {
    return Array.from(this.solanaRegistry.values());
  }

  /**
   * Check if settlement is enabled for a chain.
   */
  isSettlementEnabled(chainId: number): boolean {
    const record = this.getEvmDeployment(chainId);
    return record?.settlementEnabled ?? false;
  }

  /**
   * Get stablecoin list for a chain.
   * Returns empty array if not found.
   */
  getStablecoins(chainId: number): Array<{
    symbol: string;
    name: string;
    address: string;
  }> {
    const record = this.getEvmDeployment(chainId);
    return record?.assets ?? [];
  }

  /**
   * Get the Splitter contract address for a chain.
   * Returns null if not found.
   */
  getSplitterAddress(chainId: number): string | null {
    const record = this.getEvmDeployment(chainId);
    return record?.contracts?.splitter ?? (record as any)?.splitter ?? null;
  }

  /**
   * Get the TokenList contract address for a chain.
   * Returns null if not found.
   */
  getTokenListAddress(chainId: number): string | null {
    const record = this.getEvmDeployment(chainId);
    return record?.contracts?.tokenList ?? null;
  }

  /**
   * Get the Profiles contract address for a chain.
   * Returns null if not found.
   */
  getProfilesAddress(chainId: number): string | null {
    const record = this.getEvmDeployment(chainId);
    return record?.contracts?.profiles ?? null;
  }

  /**
   * Get governance Safe address for environment.
   */
  getGovernanceSafe(env: "prod" | "testnet"): string | null {
    if (env === "prod") {
      return this.governance?.prod.safe ?? null;
    }
    return this.governance?.testnet.safe ?? null;
  }

  /**
   * Get registry version.
   */
  getVersion(): string {
    return this.version;
  }

  /**
   * Get registry generation timestamp.
   */
  getGeneratedAt(): string {
    return this.generatedAt;
  }

  /**
   * Filter deployments by status.
   */
  filterByStatus(status: "enabled" | "disabled" | "invalid" | "retired"): EvmDeploymentRecord[] {
    return this.getAllEvmDeployments().filter((d) => d.status === status);
  }

  /**
   * Get only production deployments (excludes testnet/dev).
   */
  getProdDeployments(): EvmDeploymentRecord[] {
    return this.getAllEvmDeployments().filter((d) => d.environment === "prod" && !d.testnet);
  }

  /**
   * Get only testnet deployments.
   */
  getTestnetDeployments(): EvmDeploymentRecord[] {
    return this.getAllEvmDeployments().filter((d) => d.testnet);
  }

  /**
   * Get list of supported chain IDs.
   * @param filter - Optional filter: "all" | "prod" | "testnet" | "enabled"
   */
  getSupportedChains(filter?: "all" | "prod" | "testnet" | "enabled"): number[] {
    const deployments = this.getAllEvmDeployments();
    const filtered = deployments.filter((d) => {
      if (filter === "prod") return d.environment === "prod" && !d.testnet;
      if (filter === "testnet") return d.testnet;
      if (filter === "enabled") return d.status === "enabled" && d.settlementEnabled;
      return true;
    });
    return filtered.map((d) => d.chainId).sort((a, b) => a - b);
  }

  /**
   * Get list of supported networks with metadata.
   * @param filter - Optional filter: "all" | "prod" | "testnet" | "enabled"
   */
  getNetworkList(filter?: "all" | "prod" | "testnet" | "enabled"): Array<{
    chainId: number;
    name: string;
    status: string;
    settlementEnabled: boolean;
    testnet: boolean;
  }> {
    const deployments = this.getAllEvmDeployments();
    const filtered = deployments.filter((d) => {
      if (filter === "prod") return d.environment === "prod" && !d.testnet;
      if (filter === "testnet") return d.testnet;
      if (filter === "enabled") return d.status === "enabled" && d.settlementEnabled;
      return true;
    });
    return filtered
      .sort((a, b) => a.chainId - b.chainId)
      .map((d) => ({
        chainId: d.chainId,
        name: d.chain,
        status: d.status,
        settlementEnabled: d.settlementEnabled,
        testnet: d.testnet,
      }));
  }

  /**
   * Check if a chain is supported.
   */
  isChainSupported(chainId: number): boolean {
    return this.getEvmDeployment(chainId) !== null;
  }

  /**
   * Get chain ID by network name.
   * Returns null if not found.
   */
  getChainIdByNetwork(network: string): number | null {
    const deployment = this.getEvmByNetwork(network);
    return deployment?.chainId ?? null;
  }

  /**
   * Get network name by chain ID.
   * Returns null if not found.
   */
  getNetworkByChainId(chainId: number): string | null {
    const deployment = this.getEvmDeployment(chainId);
    return deployment?.chain ?? null;
  }

  /**
   * Export supported chains as markdown table.
   * @param filter - Optional filter: "all" | "prod" | "testnet" | "enabled"
   */
  exportAsMarkdown(filter?: "all" | "prod" | "testnet" | "enabled"): string {
    const networks = this.getNetworkList(filter);
    if (networks.length === 0) {
      return "No networks found.";
    }

    const header = "| Chain ID | Network | Status | Settlement | Testnet |\n|----------|---------|--------|------------|---------|";
    const rows = networks.map(
      (n) =>
        `| ${n.chainId} | ${n.name} | ${n.status} | ${n.settlementEnabled ? "✅" : "❌"} | ${n.testnet ? "Yes" : "No"} |`,
    );
    return [header, ...rows].join("\n");
  }

  /**
   * Export supported chains as JSON.
   * @param filter - Optional filter: "all" | "prod" | "testnet" | "enabled"
   */
  exportAsJson(filter?: "all" | "prod" | "testnet" | "enabled"): string {
    const networks = this.getNetworkList(filter);
    return JSON.stringify(networks, null, 2);
  }

  /**
   * Export supported chains as CSV.
   * @param filter - Optional filter: "all" | "prod" | "testnet" | "enabled"
   */
  exportAsCsv(filter?: "all" | "prod" | "testnet" | "enabled"): string {
    const networks = this.getNetworkList(filter);
    if (networks.length === 0) {
      return "chainId,name,status,settlementEnabled,testnet\n";
    }

    const header = "chainId,name,status,settlementEnabled,testnet";
    const rows = networks.map((n) => `${n.chainId},${n.name},${n.status},${n.settlementEnabled},${n.testnet}`);
    return [header, ...rows].join("\n");
  }
}
