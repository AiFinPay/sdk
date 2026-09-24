import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const here = path.dirname(fileURLToPath(import.meta.url));
const nodeRoot = path.resolve(here, "..");
const evmOutput = path.join(nodeRoot, "src/generated/v14Deployments.generated.ts");
const solanaOutput = path.join(nodeRoot, "src/generated/solanaV14Deployments.generated.ts");
// The Python SDK reads the same pins; generated here so one check covers both.
const pythonOutput = path.resolve(nodeRoot, "../python/aifinpay/_v14_deployments.py");
const checkOnly = process.argv.includes("--check");
const zeroAddress = "0x0000000000000000000000000000000000000000";

// Source of truth: @aifinpay/deployments ships the canonical per-ecosystem
// split registries. It is installed as a local file: dependency (the package is
// private/unpublished) so the SDK resolves it through node_modules.
const deploymentsPkg = require.resolve("@aifinpay/deployments/package.json");
const deploymentsRoot = path.dirname(deploymentsPkg);
const evmRegistryPath = path.join(deploymentsRoot, "registry/splitter/evm/v1.4/deployments.json");
const solanaRegistryPath = path.join(deploymentsRoot, "registry/splitter/solana/deployments.json");

const evmRegistry = JSON.parse(fs.readFileSync(evmRegistryPath, "utf8"));
const solanaRegistry = JSON.parse(fs.readFileSync(solanaRegistryPath, "utf8"));

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
    if (deployment.chain === "botchain") fail("BOT Chain must not be registered for v1.4");
    if (!Number.isInteger(deployment.chainId)) fail(`${key} has invalid chainId`);

    const addresses = [
      deployment.contracts?.splitter,
      deployment.contracts?.tokenList,
      deployment.contracts?.profiles,
    ];
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
    evmRegistry.deployments.map((deployment) => {
      const findAsset = (symbol) => deployment.assets.find((asset) => asset.symbol === symbol)?.address ?? zeroAddress;
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
          sourceArtifact: deployment.sourceArtifact || `deployments/${deployment.chain}-v14-${deployment.chain}-latest.json`,
          splitter: {
            address: deployment.contracts.splitter,
            admin: deployment.contracts.admin,
            signer: deployment.contracts.signer,
            pauser: deployment.contracts.pauser,
            treasury: deployment.contracts.treasury,
            tokenList: deployment.contracts.tokenList,
            profiles: deployment.contracts.profiles,
            assets: deployment.assets,
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

export const V14_DEV_NETWORKS = ["amoy"] as const;
`;
}

function renderSolana() {
  const deployments = Object.fromEntries(
    solanaRegistry.deployments.map((deployment) => [
      deployment.cluster,
      {
        network: deployment.cluster,
        environment: deployment.environment,
        splitterVersion: "1.4",
        status: deployment.status,
        settlementEnabled: deployment.settlementEnabled,
        disabledReason: deployment.disabledReason,
        programId: deployment.programId,
        idl: { ...deployment.idl, artifact: deployment.sourceArtifact },
      },
    ])
  );
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
  idl: { name: string; version: string; artifact: string };
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

function writeOrCheck(outputPath, content) {
  if (checkOnly) {
    if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, "utf8") !== content) {
      throw new Error(`${path.relative(nodeRoot, outputPath)} is stale; run registry:payment:sync`);
    }
  } else {
    fs.writeFileSync(outputPath, content);
  }
}

validateEvm(evmRegistry.deployments);
validateSolana(solanaRegistry.deployments);
writeOrCheck(evmOutput, renderEvm());
writeOrCheck(solanaOutput, renderSolana());
writeOrCheck(pythonOutput, renderPython());
console.log(checkOnly ? "Payment deployment registry is current." : "Generated payment deployment tables.");
