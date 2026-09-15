import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const REGISTRY_ROOT = join(__dirname, "../registry");
const ABI_DIR = join(REGISTRY_ROOT, "abi");
const IDL_DIR = join(REGISTRY_ROOT, "idl");

export interface EvmAbiArtifact {
  contractName: string;
  version: string;
  abi: unknown[];
  bytecode?: string;
}

export interface SolanaIdlArtifact {
  programName: string;
  version: string;
  cluster: "mainnet" | "devnet";
  idl: unknown;
}

export interface CasperIdlArtifact {
  contractName: string;
  version: string;
  network: "mainnet" | "testnet";
  idl: unknown;
}

export interface AptosIdlArtifact {
  contractName: string;
  version: string;
  idl: unknown;
}

export interface TronAbiArtifact {
  contractName: string;
  version: string;
  abi: unknown[];
}

/**
 * Programmatic interface to query ABI and IDL artifacts.
 * Provides type-safe access to contract interface definitions.
 */
export class ArtifactRegistry {
  private evmAbiCache: Map<string, EvmAbiArtifact>;
  private solanaIdlCache: Map<"mainnet" | "devnet", SolanaIdlArtifact>;
  private casperIdlCache: Map<"mainnet" | "testnet", CasperIdlArtifact>;
  private aptosIdlCache: Map<string, AptosIdlArtifact>;
  private tronAbiCache: Map<string, TronAbiArtifact>;

  private constructor() {
    this.evmAbiCache = new Map();
    this.solanaIdlCache = new Map();
    this.casperIdlCache = new Map();
    this.aptosIdlCache = new Map();
    this.tronAbiCache = new Map();
  }

  static load(): ArtifactRegistry {
    const registry = new ArtifactRegistry();
    registry.loadEvmAbiArtifacts();
    registry.loadSolanaIdlArtifacts();
    registry.loadCasperIdlArtifacts();
    registry.loadAptosIdlArtifacts();
    registry.loadTronAbiArtifacts();
    return registry;
  }

  private loadEvmAbiArtifacts(): void {
    const evmDir = join(ABI_DIR, "evm");
    if (!existsSync(evmDir)) return;

    const contractDirs = this.readDirectories(evmDir);
    for (const dir of contractDirs) {
      const contractName = dir;
      const jsonFiles = this.readJsonFiles(join(evmDir, dir));
      for (const file of jsonFiles) {
        const content = JSON.parse(readFileSync(file, "utf-8"));
        const version = this.extractVersionFromContractDir(dir, content, file);
        const artifact: EvmAbiArtifact = {
          contractName,
          version,
          abi: content.abi || [],
          bytecode: content.bytecode,
        };
        const key = `${contractName}@${version}`;
        this.evmAbiCache.set(key, artifact);
      }
    }
  }

  private loadSolanaIdlArtifacts(): void {
    const solanaDir = join(IDL_DIR, "solana", "splitter-v14");
    if (!existsSync(solanaDir)) return;

    const clusters: Array<"mainnet" | "devnet"> = ["mainnet", "devnet"];
    for (const cluster of clusters) {
      const file = join(solanaDir, `splitter.${cluster}.json`);
      if (existsSync(file)) {
        const content = JSON.parse(readFileSync(file, "utf-8"));
        const artifact: SolanaIdlArtifact = {
          programName: "splitter",
          version: "1.4",
          cluster,
          idl: content,
        };
        this.solanaIdlCache.set(cluster, artifact);
      }
    }
  }

  private loadCasperIdlArtifacts(): void {
    const casperDir = join(IDL_DIR, "casper");
    if (!existsSync(casperDir)) return;

    const networks: Array<"mainnet" | "testnet"> = ["mainnet", "testnet"];
    for (const network of networks) {
      const file = join(casperDir, `splitter.${network}.json`);
      if (existsSync(file)) {
        const content = JSON.parse(readFileSync(file, "utf-8"));
        const artifact: CasperIdlArtifact = {
          contractName: "splitter",
          version: "1.4",
          network,
          idl: content,
        };
        this.casperIdlCache.set(network, artifact);
      }
    }
  }

  private loadAptosIdlArtifacts(): void {
    const aptosDir = join(IDL_DIR, "aptos");
    if (!existsSync(aptosDir)) return;

    const jsonFiles = this.readJsonFiles(aptosDir);
    for (const file of jsonFiles) {
      const content = JSON.parse(readFileSync(file, "utf-8"));
      const contractName = this.extractContractName(file);
      const version = this.extractVersion(file, contractName);
      const artifact: AptosIdlArtifact = {
        contractName,
        version,
        idl: content,
      };
      const key = `${contractName}@${version}`;
      this.aptosIdlCache.set(key, artifact);
    }
  }

  private loadTronAbiArtifacts(): void {
    const tronDir = join(ABI_DIR, "tron");
    if (!existsSync(tronDir)) return;

    const jsonFiles = this.readJsonFiles(tronDir);
    for (const file of jsonFiles) {
      const content = JSON.parse(readFileSync(file, "utf-8"));
      const contractName = this.extractContractName(file);
      const version = this.extractVersion(file, contractName);
      const artifact: TronAbiArtifact = {
        contractName,
        version,
        abi: content.abi || [],
      };
      const key = `${contractName}@${version}`;
      this.tronAbiCache.set(key, artifact);
    }
  }

  getEvmAbi(contractName: string, version: string = "1.4"): EvmAbiArtifact | null {
    const key = `${contractName}@${version}`;
    return this.evmAbiCache.get(key) ?? null;
  }

  getAllEvmAbis(): EvmAbiArtifact[] {
    return Array.from(this.evmAbiCache.values());
  }

  getSolanaIdl(cluster: "mainnet" | "devnet"): SolanaIdlArtifact | null {
    return this.solanaIdlCache.get(cluster) ?? null;
  }

  getAllSolanaIdls(): SolanaIdlArtifact[] {
    return Array.from(this.solanaIdlCache.values());
  }

  getCasperIdl(network: "mainnet" | "testnet"): CasperIdlArtifact | null {
    return this.casperIdlCache.get(network) ?? null;
  }

  getAllCasperIdls(): CasperIdlArtifact[] {
    return Array.from(this.casperIdlCache.values());
  }

  getAptosIdl(contractName: string, version?: string): AptosIdlArtifact | null {
    if (version) {
      const key = `${contractName}@${version}`;
      return this.aptosIdlCache.get(key) ?? null;
    }
    for (const [key, artifact] of this.aptosIdlCache.entries()) {
      if (key.startsWith(`${contractName}@`)) {
        return artifact;
      }
    }
    return null;
  }

  getAllAptosIdls(): AptosIdlArtifact[] {
    return Array.from(this.aptosIdlCache.values());
  }

  getTronAbi(contractName: string, version?: string): TronAbiArtifact | null {
    if (version) {
      const key = `${contractName}@${version}`;
      return this.tronAbiCache.get(key) ?? null;
    }
    for (const [key, artifact] of this.tronAbiCache.entries()) {
      if (key.startsWith(`${contractName}@`)) {
        return artifact;
      }
    }
    return null;
  }

  getAllTronAbis(): TronAbiArtifact[] {
    return Array.from(this.tronAbiCache.values());
  }

  private readDirectories(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  }

  private readJsonFiles(dir: string): string[] {
    if (!existsSync(dir)) return [];
    const entries = readdirSync(dir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile() && extname(entry.name) === ".json")
      .map((entry) => join(dir, entry.name));
  }

  private extractContractName(filePath: string): string {
    const base = filePath.split("/").pop() ?? "";
    return base.replace(/\.json$/, "");
  }

  private extractVersionFromContractDir(dirName: string, content: unknown, _filePath: string): string {
    if (content && typeof content === "object" && "version" in content) {
      return String(content.version);
    }
    const versionMatch = /v?(\d+\.\d+(?:\.\d+)?)/.exec(dirName);
    return versionMatch ? versionMatch[1] : "1.4";
  }

  private extractVersion(filePath: string, _contractName: string): string {
    const base = filePath.split("/").pop() ?? "";
    const versionMatch = /v?(\d+\.\d+(?:\.\d+)?)/.exec(base);
    return versionMatch ? versionMatch[1] : "1.0";
  }
}
