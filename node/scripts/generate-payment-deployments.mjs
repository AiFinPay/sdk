import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const nodeRoot = path.resolve(here, "..");
const evmOutput = path.join(nodeRoot, "src/generated/v14Deployments.generated.ts");
const solanaOutput = path.join(nodeRoot, "src/generated/solanaV14Deployments.generated.ts");
const aptosOutput = path.join(nodeRoot, "src/generated/aptosV14Deployments.generated.ts");
const nearOutput = path.join(nodeRoot, "src/generated/nearV14Deployments.generated.ts");
// The Python SDK reads the same pins; generated here so one check covers both.
const pythonOutput = path.resolve(nodeRoot, "../python/aifinpay/_v14_deployments.py");
const pythonSolanaOutput = path.resolve(nodeRoot, "../python/aifinpay/_solana_v14_deployments.py");
const checkOnly = process.argv.includes("--check");
const zeroAddress = "0x0000000000000000000000000000000000000000";
// New registry entries are not implicit owner authorization to add SDK networks.
const supportedEvmChains = new Set([
  "optimism",
  "bnb",
  "unichain",
  "polygon",
  "robinhood",
  "base",
  "arbitrum",
  "avalanche",
  "xrplevm",
  "amoy",
  "arc",
  "arcTestnet",
  "botchain",
]);

// Source of truth: the installed @aifinpay/deployments package ships the
// canonical per-ecosystem registries.
const deploymentsPkg = require.resolve("@aifinpay/deployments/package.json");
const deploymentsRoot = path.dirname(deploymentsPkg);
const evmRegistryPath = path.join(deploymentsRoot, "registry/splitter/evm/v1.4/deployments.json");
const solanaRegistryPath = path.join(deploymentsRoot, "registry/splitter/solana/deployments.json");
const aptosRegistryPath = path.join(deploymentsRoot, "registry/splitter/aptos/deployments.json");
const nearRegistryPath = path.join(deploymentsRoot, "registry/splitter/near/deployments.json");

// @aifinpay/deployments 2.x dropped `status`/`disabledReason` (its ADR 0007):
// `settlementEnabled` is the only flag. The SDK still checks status=enabled at
// settlement, so derive it from that flag and never from anything looser.
function withStatus(deployment) {
  if (typeof deployment.settlementEnabled !== "boolean") {
    fail(`${deployment.chain ?? deployment.cluster} has no boolean settlementEnabled`);
  }
  return {
    ...deployment,
    status: deployment.status ?? (deployment.settlementEnabled ? "enabled" : "disabled"),
    disabledReason:
      deployment.disabledReason ??
      (deployment.settlementEnabled ? undefined : "settlementEnabled is false in @aifinpay/deployments"),
  };
}

const evmRegistry = JSON.parse(fs.readFileSync(evmRegistryPath, "utf8"));
const solanaRegistry = JSON.parse(fs.readFileSync(solanaRegistryPath, "utf8"));
const aptosRegistry = JSON.parse(fs.readFileSync(aptosRegistryPath, "utf8"));
const nearRegistry = JSON.parse(fs.readFileSync(nearRegistryPath, "utf8"));
// SDK network names are lowercase (resolvers lowercase their input, and the
// backend slug is "arctestnet"); the registry spells the testnet "arcTestnet".
const sdkEvmDeployments = evmRegistry.deployments
  .filter((deployment) => supportedEvmChains.has(deployment.chain))
  .map((deployment) => ({
    ...withStatus(deployment),
    chain: deployment.chain.toLowerCase(),
    sourceArtifact: deployment.sourceArtifact || `deployments/${deployment.chain}-v14-${deployment.chain}-latest.json`,
  }));
const solanaDeployments = solanaRegistry.deployments.map(withStatus);

function fail(message) {
  throw new Error(`Invalid payment deployment registry: ${message}`);
}

function validateEvm(deployments) {
  const keys = new Set();
  for (const deployment of deployments) {
    const key = `evm:${deployment.environment}:${deployment.chain}:v1.4`;
    if (keys.has(key)) fail(`duplicate deployment ${key}`);
    keys.add(key);

    if (deployment.settlementEnabled && deployment.status !== "enabled") {
      fail(`${key} enables settlement without status=enabled`);
    }
    if (!deployment.settlementEnabled && !deployment.disabledReason) {
      fail(`${key} is disabled without disabledReason`);
    }
    if (!Number.isInteger(deployment.chainId)) fail(`${key} has invalid chainId`);

    const addresses = [deployment.contracts?.splitter, deployment.contracts?.tokenList, deployment.contracts?.profiles];
    if (addresses.some((address) => !/^0x[0-9a-fA-F]{40}$/.test(address ?? ""))) {
      fail(`${key} has an invalid component address`);
    }
    if (deployment.status !== "invalid" && new Set(addresses.map((a) => a.toLowerCase())).size !== 3) {
      fail(`${key} reuses a component address`);
    }
    for (const asset of deployment.assets ?? []) {
      if (!asset.symbol || !/^0x[0-9a-fA-F]{40}$/.test(asset.address ?? "")) {
        fail(`${key} has an invalid asset`);
      }
      if (asset.address.toLowerCase() === zeroAddress) fail(`${key} contains a zero-address asset`);
    }
  }

  const polygon = deployments.find((d) => d.chain === "polygon");
  const bridgedUsdc = polygon?.assets?.find(
    (asset) => asset.address.toLowerCase() === "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"
  );
  if (bridgedUsdc?.symbol !== "USDC.e") fail("Polygon 0x2791… must be identified as USDC.e");
}

function validateSolana(deployments) {
  const keys = new Set();
  for (const deployment of deployments) {
    const key = `solana:${deployment.environment}:${deployment.cluster}:v1.4`;
    if (keys.has(key)) fail(`duplicate deployment ${key}`);
    keys.add(key);

    if (deployment.settlementEnabled && deployment.status !== "enabled") {
      fail(`${key} enables settlement without status=enabled`);
    }
    if (!deployment.settlementEnabled && !deployment.disabledReason) {
      fail(`${key} is disabled without disabledReason`);
    }
  }

  const expectedSolana = {
    devnet: "8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y",
    mainnet: "724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD",
  };
  for (const [cluster, programId] of Object.entries(expectedSolana)) {
    const deployment = deployments.find((d) => d.cluster === cluster);
    if (deployment?.programId !== programId) fail(`unexpected Solana ${cluster} program id`);
  }
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function evmTable() {
  return Object.fromEntries(
    sdkEvmDeployments.map((deployment) => {
      // The registry's new Polygon USDT entry is not part of the SDK token allowlist.
      // Arc EURC is not either: quotes are in USD and a token is priced 1:1 with it.
      const assets = deployment.assets.filter(
        (asset) =>
          !(deployment.chain === "polygon" && asset.symbol === "USDT") &&
          !(deployment.chain.startsWith("arc") && asset.symbol === "EURC")
      );
      const findAsset = (symbol) => assets.find((asset) => asset.symbol === symbol)?.address ?? zeroAddress;
      return [
        deployment.chain,
        {
          network: deployment.chain,
          chainId: deployment.chainId,
          environment: deployment.environment,
          splitterVersion: "1.4",
          status: deployment.status,
          settlementEnabled: deployment.settlementEnabled,
          ...(deployment.disabledReason ? { disabledReason: deployment.disabledReason } : {}),
          sourceArtifact: deployment.sourceArtifact,
          splitter: {
            address: deployment.contracts.splitter,
            admin: deployment.contracts.admin,
            signer: deployment.contracts.signer,
            pauser: deployment.contracts.pauser,
            treasury: deployment.contracts.treasury,
            tokenList: deployment.contracts.tokenList,
            profiles: deployment.contracts.profiles,
            assets,
            usdc: findAsset("USDC"),
            usdt: findAsset("USDT"),
          },
          runtimeCodeHash: deployment.runtimeCodeHash,
          safe: {
            address: deployment.safe.address,
            version: deployment.safe.version,
            threshold: deployment.safe.threshold,
            owners: evmRegistry.governance?.[deployment.environment === "dev" ? "testnet" : "prod"].owners ?? [],
          },
        },
      ];
    })
  );
}

function renderEvm() {
  const deployments = evmTable();
  const source = evmRegistry.source;
  return `// DO NOT EDIT. Generated by scripts/generate-payment-deployments.mjs from @aifinpay/deployments.

import type { SdkEnvironment } from "../deploymentResolver.js";

export interface V14Asset {
  symbol: string;
  address: \`0x\${string}\`;
  name?: string;
  source?: string | null;
}

export interface V14Splitter {
  address: \`0x\${string}\`;
  admin: \`0x\${string}\`;
  signer: \`0x\${string}\`;
  pauser: \`0x\${string}\`;
  treasury: \`0x\${string}\`;
  tokenList: \`0x\${string}\`;
  profiles: \`0x\${string}\`;
  assets: readonly V14Asset[];
  /** @deprecated Use assets; retained for one compatibility release. */
  usdc: \`0x\${string}\`;
  /** @deprecated Use assets; retained for one compatibility release. */
  usdt: \`0x\${string}\`;
}

export interface V14Safe {
  address: \`0x\${string}\`;
  version: string;
  threshold: number;
  owners: readonly \`0x\${string}\`[];
}

export interface V14Deployment {
  network: string;
  chainId: number;
  environment: SdkEnvironment;
  splitterVersion: "1.4";
  status: "enabled" | "disabled" | "invalid" | "retired";
  settlementEnabled: boolean;
  disabledReason?: string;
  sourceArtifact: string;
  splitter: V14Splitter;
  runtimeCodeHash: \`0x\${string}\`;
  safe: V14Safe;
}

export const V14_DEPLOYMENTS_SOURCE = ${json({ ...source, branch: "dev" })} as const;

export const V14_DEPLOYMENTS: Record<string, V14Deployment> = ${json(deployments)};

export const V14_DEV_NETWORKS = ${JSON.stringify(
    Object.values(deployments)
      .filter((d) => d.environment === "dev")
      .map((d) => d.network)
  )} as const;
`;
}

function solanaTable() {
  const deployments = Object.fromEntries(
    solanaDeployments.map((deployment) => [
      deployment.cluster,
      {
        network: deployment.cluster,
        environment: deployment.environment,
        splitterVersion: "1.4",
        status: deployment.status,
        settlementEnabled: deployment.settlementEnabled,
        disabledReason: deployment.disabledReason,
        programId: deployment.programId,
        idl: {
          ...deployment.idl,
          artifact: deployment.sourceArtifact,
          sha256: createHash("sha256")
            .update(
              fs.readFileSync(
                path.join(deploymentsRoot, `registry/idl/solana/splitter-v14/splitter.${deployment.cluster}.json`)
              )
            )
            .digest("hex"),
        },
      },
    ])
  );
  return deployments;
}
function renderSolana() {
  const deployments = solanaTable();
  const source = solanaRegistry.source;
  return `// DO NOT EDIT. Generated by scripts/generate-payment-deployments.mjs from @aifinpay/deployments.

import type { SdkEnvironment } from "../deploymentResolver.js";

export type SolanaNetwork = "devnet" | "mainnet";

export interface SolanaV14Deployment {
  network: SolanaNetwork;
  environment: SdkEnvironment;
  splitterVersion: "1.4";
  status: "enabled" | "disabled" | "invalid" | "retired";
  settlementEnabled: boolean;
  disabledReason?: string;
  programId: string;
  idl: { name: string; version: string; artifact: string; sha256: string };
}

export const SOLANA_V14_DEPLOYMENTS_SOURCE = ${json({ ...source, branch: "dev" })} as const;

export const SOLANA_V14_DEPLOYMENTS: Record<string, SolanaV14Deployment> = ${json(deployments)};

export const SOLANA_DEV_NETWORKS = ["devnet"] as const;
`;
}

function renderPython() {
  // JSON inside a raw string: the table is data, and json.loads gives Python
  // exactly the values the Node SDK pins, with no hand-written translation.
  const table = JSON.stringify({ source: { ...evmRegistry.source, branch: "dev" }, deployments: evmTable() }, null, 2);
  if (table.includes("\'\'\'")) fail("registry text cannot be embedded in a Python raw string");
  return `# DO NOT EDIT. Generated by node/scripts/generate-payment-deployments.mjs
# from @aifinpay/deployments — the same pins the Node SDK uses.
"""Independently pinned AIFP-1 v1.4 deployments (EVM)."""
import json

_TABLE = json.loads(
    r\'\'\'${table}\'\'\'
)

V14_DEPLOYMENTS_SOURCE = _TABLE["source"]
V14_DEPLOYMENTS = _TABLE["deployments"]
`;
}

function validateAccountRegistry(registry, ecosystem) {
  if (
    registry.ecosystem !== ecosystem ||
    !["1.4", "v1.4", "1.4.0"].includes(registry.protocolVersion) ||
    !Array.isArray(registry.deployments) ||
    registry.deployments.length === 0
  ) fail(`invalid ${ecosystem} v1.4 registry`);
  const keys = new Set();
  for (const deployment of registry.deployments) {
    const key = `${ecosystem}:${deployment.environment}:${deployment.network}:v1.4`;
    if (!["mainnet", "testnet"].includes(deployment.network)) fail(`${key} has unsupported network`);
    const testnet = deployment.network === "testnet";
    if (deployment.environment !== (testnet ? "dev" : "prod") || deployment.testnet !== testnet) {
      fail(`${key} has inconsistent environment/testnet`);
    }
    if (keys.has(deployment.network)) fail(`duplicate deployment ${key}`);
    keys.add(deployment.network);
    if (typeof deployment.settlementEnabled !== "boolean") fail(`${key} has no boolean settlementEnabled`);
    const source = deployment.source ?? registry.source;
    if (
      source?.repo !== `AiFinPay/${ecosystem}-contract` ||
      !/^[0-9a-f]{40}$/.test(source.commit ?? "") ||
      typeof source.path !== "string" || !source.path.trim() ||
      typeof deployment.sourceArtifact !== "string" || !deployment.sourceArtifact.trim()
    ) fail(`${key} has missing immutable provenance`);
    if (ecosystem === "aptos") {
      if (!Number.isSafeInteger(deployment.chainId) || deployment.chainId !== (testnet ? 2 : 1)) {
        fail(`${key} has invalid chainId`);
      }
      if (!/^0x[0-9a-fA-F]{1,64}$/.test(deployment.packageAddress ?? "") ||
        /^0x0+$/.test(deployment.packageAddress) ||
        typeof deployment.packageName !== "string" || !deployment.packageName.trim()) {
        fail(`${key} has invalid package identity`);
      }
      const modules = deployment.modules;
      if (!Array.isArray(modules) || !modules.length ||
        new Set(modules.map((module) => module.name)).size !== modules.length ||
        !modules.some((module) => module.name === "splitter") ||
        modules.some((module) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(module.name ?? "") ||
          !/^0x[0-9a-fA-F]{64}$/.test(module.bytecodeHash ?? ""))) {
        fail(`${key} has invalid module pins`);
      }
      const artifact = path.resolve(path.dirname(aptosRegistryPath), deployment.sourceArtifact);
      if (!artifact.startsWith(deploymentsRoot + path.sep)) fail(`${key} artifact escapes deployments package`);
      const abi = JSON.parse(fs.readFileSync(artifact, "utf8"));
      if (abi.address?.toLowerCase() !== deployment.packageAddress.toLowerCase() || abi.name !== "splitter") {
        fail(`${key} ABI does not match package/splitter identity`);
      }
    } else {
      if (
        !/^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(deployment.contractAccountId ?? "") ||
        deployment.contractAccountId.length < 2 || deployment.contractAccountId.length > 64 ||
        !deployment.contractAccountId.endsWith(testnet ? ".testnet" : ".near") ||
        !/^[0-9a-fA-F]{64}$/.test(deployment.wasmCodeHash ?? "") ||
        (deployment.runtimeCodeHash !== undefined && deployment.runtimeCodeHash !== deployment.wasmCodeHash)
      ) fail(`${key} has invalid account/WASM pins`);
      const prefix = `https://github.com/${source.repo}/blob/${source.commit}/`;
      if (!deployment.sourceArtifact.startsWith(prefix) ||
        deployment.sourceArtifact.includes("latest") ||
        !deployment.sourceArtifact.endsWith(".json")) {
        fail(`${key} source artifact is not immutable`);
      }
    }
  }
}

function renderAccountRegistry(registry, ecosystem) {
  const aptos = ecosystem === "aptos";
  const name = aptos ? "Aptos" : "Near";
  const constant = ecosystem.toUpperCase();
  const table = Object.fromEntries(registry.deployments.map((deployment) => [
    deployment.network,
    {
      network: deployment.network,
      environment: deployment.environment,
      testnet: deployment.testnet,
      splitterVersion: "1.4",
      settlementEnabled: deployment.settlementEnabled,
      source: deployment.source ?? registry.source,
      sourceArtifact: deployment.sourceArtifact,
      ...(aptos ? {
        chainId: deployment.chainId,
        packageAddress: deployment.packageAddress,
        packageName: deployment.packageName,
        modules: deployment.modules,
        abiSha256: createHash("sha256").update(fs.readFileSync(
          path.resolve(path.dirname(aptosRegistryPath), deployment.sourceArtifact)
        )).digest("hex"),
      } : {
        contractAccountId: deployment.contractAccountId,
        wasmCodeHash: deployment.wasmCodeHash,
        treasuryAccountId: deployment.treasuryAccountId,
      }),
    },
  ]));
  return `// DO NOT EDIT. Generated by scripts/generate-payment-deployments.mjs from @aifinpay/deployments.

import type { SdkEnvironment } from "../deploymentResolver.js";

export type ${name}Network = "mainnet" | "testnet";

/** Packaged deployment metadata, not authorization or runtime verification. */
export interface ${name}V14Deployment {
  network: ${name}Network;
  environment: SdkEnvironment;
  testnet: boolean;
  splitterVersion: "1.4";
  settlementEnabled: boolean;
  source: { repo: string; commit: string; path: string; url?: string; localPath?: string };
  sourceArtifact: string;
${aptos ? `  chainId: number;
  packageAddress: \`0x\${string}\`;
  packageName: string;
  modules: readonly { name: string; bytecodeHash: \`0x\${string}\` }[];
  abiSha256: string;` : `  contractAccountId: string;
  wasmCodeHash: string;
  treasuryAccountId?: string;`}
}

export const ${constant}_V14_DEPLOYMENTS_SOURCE = ${json(registry.source)} as const;

export const ${constant}_V14_DEPLOYMENTS: Readonly<Record<${name}Network, ${name}V14Deployment | undefined>> = ${json(table)};
`;
}

function writeOrCheck(outputPath, content) {
  if (checkOnly) {
    if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== content) {
      throw new Error(`${path.relative(nodeRoot, outputPath)} is stale; run registry:payment:sync`);
    }
  } else {
    fs.writeFileSync(outputPath, content);
  }
}

validateEvm(sdkEvmDeployments);
validateSolana(solanaDeployments);
validateAccountRegistry(aptosRegistry, "aptos");
validateAccountRegistry(nearRegistry, "near");
writeOrCheck(evmOutput, renderEvm());
writeOrCheck(solanaOutput, renderSolana());
writeOrCheck(aptosOutput, renderAccountRegistry(aptosRegistry, "aptos"));
writeOrCheck(nearOutput, renderAccountRegistry(nearRegistry, "near"));
writeOrCheck(pythonOutput, renderPython());
writeOrCheck(
  pythonSolanaOutput,
  `# DO NOT EDIT. Generated by node/scripts/generate-payment-deployments.mjs\nimport json\nSOLANA_V14_DEPLOYMENTS = json.loads(r'''${json(solanaTable())}''')\n`
);
console.log(checkOnly ? "Payment deployment registry is current." : "Generated payment deployment tables.");
