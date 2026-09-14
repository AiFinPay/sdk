import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { DeploymentRegistry, EvmDeployment, SolanaDeployment } from "./types.js";

const ROOT = dirname(fileURLToPath(import.meta.url));
export const ABI_DIR = join(ROOT, "../registry/abi");
export const IDL_DIR = join(ROOT, "../registry/idl");

const EVM_VERSIONS = new Set(["1.2", "1.4"]);
const SOLANA_VERSIONS = new Set(["1.4", "1.4.1"]);

/** Ensure an output directory exists. */
export function ensureDir(dir: string): void {
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/**
 * Fetch the directory listing of raw JSON files from a GitHub repository.
 * Uses the public GitHub API (no auth required for public repos).
 */
export async function listGitHubFiles(
  owner: string,
  repo: string,
  path: string,
  ref: string,
): Promise<string[]> {
  const url = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${ref}`;
  const res = await fetch(url, {
    headers: { Accept: "application/vnd.github+json", "User-Agent": "aifinpay-sdk-grabber" },
  });
  if (!res.ok) {
    throw new Error(`GitHub listing failed: ${res.status} ${res.statusText} (${url})`);
  }
  const items = (await res.json()) as Array<{ type: string; name: string; download_url: string | null }>;
  return items
    .filter((i) => i.type === "file" && i.name.endsWith(".json") && i.download_url)
    .map((i) => i.download_url as string);
}

/** Fetch a single raw JSON document. */
export async function fetchJson<T = unknown>(url: string): Promise<T> {
  const res = await fetch(url, { headers: { "User-Agent": "aifinpay-sdk-grabber" } });
  if (!res.ok) {
    throw new Error(`Fetch failed: ${res.status} ${res.statusText} (${url})`);
  }
  return res.json() as Promise<T>;
}

/**
 * Parse an EVM deployment filename and return its network + timestamp.
 * Supports:
 *   {network}-{iso}.json
 *   {network}-v14-{network}-latest.json
 *   {network}-v13-latest.json (ignored because not 1.2/1.4)
 *   {network}-safe-multisig-{iso}.json (ignored, Safe metadata, not splitter)
 */
function parseEvmFilename(url: string): { network: string; timestamp: string; version: string } | null {
  const name = url.split("/").pop() ?? "";
  const base = name.replace(/\.json$/, "");

  // Skip multisig metadata files and v1.3-only files
  if (base.includes("safe-multisig")) return null;
  if (base.includes("-v13-") && !base.includes("-v14-")) return null;

  // E.g. amoy-2026-09-02T00-42-08-319Z
  const datedMatch = /^(?<network>[a-z]+)-(?<year>\d{4})-(?<month>\d{2})-(?<day>\d{2})T(?<hh>\d{2})-(?<mm>\d{2})-(?<ss>\d{2})-(?<ms>\d+)Z$/.exec(base);
  if (datedMatch?.groups) {
    const { network, year, month, day, hh, mm, ss, ms } = datedMatch.groups;
    return {
      network,
      timestamp: `${year}-${month}-${day}T${hh}:${mm}:${ss}.${ms}Z`,
      version: inferVersion(base),
    };
  }

  // E.g. polygon-v14-polygon-latest -> treated as latest known for that network
  const latestMatch = /^(?<network>[a-z]+)-v14-(?<network2>[a-z]+)-latest$/.exec(base);
  if (latestMatch?.groups) {
    return {
      network: latestMatch.groups.network,
      timestamp: new Date().toISOString(),
      version: "1.4",
    };
  }

  return null;
}

function inferVersion(base: string): string {
  if (base.includes("-v14-") || base.endsWith("-v14")) return "1.4";
  if (base.includes("-v13-")) return "1.3";
  return "1.2";
}

interface RawEvmDeployment {
  network: string;
  chainId: number;
  timestamp: string;
  splitterVersion?: string;
  splitter: {
    address: string;
    admin: string;
    signer: string;
    pauser: string;
    treasury: string;
    tokenList: string;
    profiles: string;
    stablecoins?: Array<{ symbol: string; name: string; address: string }>;
    usdc?: string;
    usdt?: string;
  };
  runtimeCodeHash: string;
  status: string;
  settlementEnabled: boolean;
}

function normalizeStablecoins(raw: RawEvmDeployment["splitter"]): Array<{ symbol: string; name: string; address: string }> {
  if (raw.stablecoins && raw.stablecoins.length > 0) {
    return raw.stablecoins.map((s) => ({ symbol: s.symbol, name: s.name, address: s.address }));
  }
  const out: Array<{ symbol: string; name: string; address: string }> = [];
  if (raw.usdc && raw.usdc !== "0x0000000000000000000000000000000000000000") {
    out.push({ symbol: "USDC", name: "USDC", address: raw.usdc });
  }
  if (raw.usdt && raw.usdt !== "0x0000000000000000000000000000000000000000") {
    out.push({ symbol: "USDT", name: "Tether USD", address: raw.usdt });
  }
  return out;
}

/**
 * List and fetch EVM deployments. For each chainId keep only the latest record
 * by (version desc, timestamp desc), restricted to v1.2 and v1.4.
 */
export async function grabEvmDeployments(): Promise<Record<string, EvmDeployment>> {
  const urls = await listGitHubFiles("AiFinPay", "evm-contract", "deployments", "dev");
  const parsed = urls
    .map((url) => ({ url, meta: parseEvmFilename(url) }))
    .filter((x): x is { url: string; meta: NonNullable<ReturnType<typeof parseEvmFilename>> } => x.meta !== null)
    .filter((x) => EVM_VERSIONS.has(x.meta.version));

  const byChain = new Map<number, { ts: number; version: string; url: string; data: RawEvmDeployment }>();

  for (const { url, meta } of parsed) {
    const data = await fetchJson<RawEvmDeployment>(url);
    const version = meta.version;
    const ts = Date.parse(data.timestamp || meta.timestamp);
    if (Number.isNaN(ts)) continue;

    const chainId = data.chainId;
    const existing = byChain.get(chainId);
    if (!existing || compareVersionTime(version, ts, existing.version, existing.ts) > 0) {
      byChain.set(chainId, { ts, version, url, data });
    }
  }

  const registry: Record<string, EvmDeployment> = {};
  for (const [chainId, { version, url, data }] of byChain) {
    registry[String(chainId)] = {
      kind: "evm",
      chainId,
      network: data.network,
      version,
      splitterAddress: data.splitter.address,
      tokenListAddress: data.splitter.tokenList,
      profilesAddress: data.splitter.profiles,
      admin: data.splitter.admin,
      signer: data.splitter.signer,
      pauser: data.splitter.pauser,
      treasury: data.splitter.treasury,
      runtimeCodeHash: data.runtimeCodeHash,
      stablecoins: normalizeStablecoins(data.splitter),
      settlementEnabled: data.settlementEnabled,
      status: data.status,
      deployedAt: data.timestamp,
      sourceUrl: url,
      abiPath: evmAbiPath(data.network),
    };
  }

  return registry;
}

function evmAbiPath(network: string): string | null {
  const candidate = join(ABI_DIR, "evm", `B2BSplitterV14`, `B2BSplitterV14.json`);
  if (existsSync(candidate)) {
    return candidate.replace(join(ROOT, "../registry/"), "registry/");
  }
  return null;
}

/**
 * Parse Solana deployment filenames:
 *   splitter.devnet.20260911-195503.json
 *   splitter.mainnet.20260911-200222.json
 */
function parseSolanaFilename(url: string): { cluster: "mainnet" | "devnet"; timestamp: string } | null {
  const name = url.split("/").pop() ?? "";
  const match = /^splitter\.(?<cluster>mainnet|devnet)\.(?<year>\d{4})(?<month>\d{2})(?<day>\d{2})-(?<hh>\d{2})(?<mm>\d{2})(?<ss>\d{2})\.json$/.exec(name);
  if (!match?.groups) return null;
  const { cluster, year, month, day, hh, mm, ss } = match.groups;
  return {
    cluster: cluster as "mainnet" | "devnet",
    timestamp: `${year}-${month}-${day}T${hh}:${mm}:${ss}Z`,
  };
}

interface RawSolanaDeployment {
  address: string;
  metadata: { version?: string; name?: string };
}

/**
 * List and fetch Solana splitter_v14 deployments. Keep latest per cluster.
 */
export async function grabSolanaDeployments(): Promise<Record<string, SolanaDeployment>> {
  const urls = await listGitHubFiles("AiFinPay", "solana-contract", "deployments/splitter_v14", "dev");
  const parsed = urls
    .map((url) => ({ url, meta: parseSolanaFilename(url) }))
    .filter((x): x is { url: string; meta: NonNullable<ReturnType<typeof parseSolanaFilename>> } => x.meta !== null);

  const byCluster = new Map<"mainnet" | "devnet", { ts: number; url: string; data: RawSolanaDeployment }>();

  for (const { url, meta } of parsed) {
    const data = await fetchJson<RawSolanaDeployment>(url);
    const version = data.metadata?.version ?? "1.4";
    if (!SOLANA_VERSIONS.has(version)) continue;
    const ts = Date.parse(meta.timestamp);
    if (Number.isNaN(ts)) continue;

    const existing = byCluster.get(meta.cluster);
    if (!existing || ts > existing.ts) {
      byCluster.set(meta.cluster, { ts, url, data });
    }
  }

  const registry: Record<string, SolanaDeployment> = {};
  for (const [cluster, { url, data }] of byCluster) {
    registry[cluster] = {
      kind: "solana",
      cluster,
      version: data.metadata?.version ?? "1.4",
      programAddress: data.address,
      deployedAt: new Date().toISOString(),
      sourceUrl: url,
      idlPath: null,
      idl: null,
    };
  }

  return registry;
}

/**
 * Compare two (version, timestamp) pairs.
 * Higher semantic version wins; if equal, later timestamp wins.
 */
export function compareVersionTime(aVersion: string, aTime: number, bVersion: string, bTime: number): number {
  const va = versionRank(aVersion);
  const vb = versionRank(bVersion);
  if (va !== vb) return va - vb;
  return aTime - bTime;
}

function versionRank(v: string): number {
  return v
    .split(".")
    .map((n) => Number.parseInt(n, 10))
    .reduce((acc, n, i) => acc + n * Math.pow(1000, 2 - i), 0);
}

/**
 * Build the combined registry from upstream repos.
 */
export async function buildRegistry(): Promise<DeploymentRegistry> {
  const [evm, solana] = await Promise.all([grabEvmDeployments(), grabSolanaDeployments()]);
  return {
    evm,
    solana,
    generatedAt: new Date().toISOString(),
    sources: [
      "https://github.com/AiFinPay/evm-contract/tree/dev/deployments",
      "https://github.com/AiFinPay/solana-contract/tree/dev/deployments/splitter_v14",
      "https://github.com/AiFinPay/evm-contract/tree/dev/config",
    ],
  };
}

/**
 * Write per-ecosystem split registry files from the combined registry.
 * Returns the list of file paths written.
 * Uses the same schema as splitter versioned deployments.json for consistency.
 */
export function writeSplitRegistries(registry: DeploymentRegistry, outDir: string): string[] {
  const evmDir = join(outDir, "splitter/evm/v1.4");
  const solanaDir = join(outDir, "splitter/solana");
  ensureDir(evmDir);
  ensureDir(solanaDir);

  const evm14 = {
    $schema: "./reference/payment-deployments.schema.json",
    version: "1.4",
    description: "B2BSplitter v1.4 — Full contract suite deployment",
    schemaVersion: 1,
    generatedAt: registry.generatedAt,
    ecosystem: "evm" as const,
    protocolVersion: "v1.4" as const,
    source: {
      repo: "AiFinPay/evm-contract",
      commit: "a54a4c107de7bb42f54e411e621d3897938bfc31",
      path: "deployments/*-v14-*-latest.json",
    },
    governance: {
      prod: {
        safe: "0x5AFe07483886DFa0B77C6d60212B6E52D78ac11e",
        version: "1.5.0",
        threshold: 3,
        owners: [
          "0x25A834b6fEC79e9ee6ED04Ef5b97440149C6Cc24",
          "0x2118c57dEBD53f614DDfE464Ff2941BE6646cA82",
          "0x3C31dd9daCeC5473cC9B660CD69247A20701cF19",
          "0x588A80e94a762C670711ff77CC60a2e65E64F53A",
        ],
      },
      testnet: {
        safe: "0xc9ab36c2af2888414c7ea9160d9e33b773c2b388",
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
    deployments: Object.values(registry.evm).map((evm) => {
      const isTestnet = evm.network === "amoy";
      const disabledReasonMap: Record<string, string> = {
        disabled: "Backend v1.4 receipt verification and end-to-end settlement gate are incomplete",
        invalid: "INVALID: splitter address equals TokenList; Profiles has no runtime code; redeploy required",
        retired: "Superseded by newer deployment",
      };
      return {
        chain: evm.network,
        chainId: evm.chainId,
        environment: isTestnet ? "dev" : "prod" as "dev" | "prod",
        testnet: isTestnet,
        status: evm.status as "enabled" | "disabled" | "invalid" | "retired",
        settlementEnabled: evm.settlementEnabled,
        disabledReason: evm.status !== "enabled" ? (disabledReasonMap[evm.status] || undefined) : undefined,
        runtimeCodeHash: evm.runtimeCodeHash,
        contracts: {
          splitter: evm.splitterAddress,
          tokenList: evm.tokenListAddress,
          profiles: evm.profilesAddress,
          admin: evm.admin,
          signer: evm.signer,
          pauser: evm.pauser,
          treasury: evm.treasury,
        },
        assets: evm.stablecoins.map((s) => ({
          symbol: s.symbol,
          name: s.name || s.symbol,
          address: s.address,
        })),
        safe: {
          address: isTestnet ? "0xc9ab36c2af2888414c7ea9160d9e33b773c2b388" : "0x5afe07483886dfa0b77c6d60212b6e52d78ac11e",
          version: isTestnet ? "1.4.1" : "1.5.0",
          threshold: 3,
        },
      };
    }),
    sourceArtifact: {
      path: "./splitter/evm/v1.4/deployments.json",
      retrievedAt: new Date().toISOString().split("T")[0],
    },
  };

  const solana14 = {
    $schema: "./reference/payment-deployments.schema.json",
    version: "1.4",
    description: "Solana Splitter v1.4 — Program deployment",
    schemaVersion: 1,
    generatedAt: registry.generatedAt,
    ecosystem: "solana" as const,
    protocolVersion: "v1.4" as const,
    source: {
      repo: "AiFinPay/solana-contract",
      commit: "e5df8f5436cf646ab495381eee04e0d1a10b4e2f",
      path: "deployments/splitter_v14/",
    },
    deployments: Object.values(registry.solana).map((solana) => ({
      cluster: solana.cluster,
      environment: solana.cluster === "devnet" ? "dev" : "prod",
      testnet: solana.cluster === "devnet",
      status: "disabled" as const,
      settlementEnabled: false,
      disabledReason: solana.cluster === "devnet" 
        ? "Backend Solana receipt verification is not implemented"
        : "Backend Solana receipt verification is not implemented and upgrade authority is not multisig",
      programId: solana.programAddress,
      idl: solana.idl ?? {
        name: "splitter",
        version: solana.version || "1.4.1",
      },
      sourceArtifact: `deployments/splitter_v14/splitter.${solana.cluster}.json`,
    })),
    sourceArtifact: {
      path: "./splitter/solana/deployments.json",
      retrievedAt: new Date().toISOString().split("T")[0],
    },
  };

  const evmPath = join(evmDir, "deployments.json");
  const solanaPath = join(solanaDir, "deployments.json");

  writeFileSync(evmPath, JSON.stringify(evm14, null, 2) + "\n");
  writeFileSync(solanaPath, JSON.stringify(solana14, null, 2) + "\n");

  return [evmPath, solanaPath];
}

/**
 * O(1) lookup helpers for generated registry.
 */
export function getEvmDeployment(registry: DeploymentRegistry, chainId: number | string): EvmDeployment | undefined {
  return registry.evm[String(chainId)];
}

export function getSolanaDeployment(registry: DeploymentRegistry, cluster: "mainnet" | "devnet"): SolanaDeployment | undefined {
  return registry.solana[cluster];
}
