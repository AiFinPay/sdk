import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const nodeRoot = path.resolve(here, "..");
const registryPath = path.join(nodeRoot, "registry/payment-deployments.json");
const evmOutput = path.join(nodeRoot, "src/v14Deployments.generated.ts");
const solanaOutput = path.join(
  nodeRoot,
  "src/solanaV14Deployments.generated.ts",
);
const checkOnly = process.argv.includes("--check");
const zeroAddress = "0x0000000000000000000000000000000000000000";

const registry = JSON.parse(fs.readFileSync(registryPath, "utf8"));

function fail(message) {
  throw new Error(`Invalid payment deployment registry: ${message}`);
}

function validate() {
  if (registry.schemaVersion !== 1) fail("schemaVersion must equal 1");
  if (!Array.isArray(registry.deployments))
    fail("deployments must be an array");

  const keys = new Set();
  for (const deployment of registry.deployments) {
    const key = `${deployment.ecosystem}:${deployment.environment}:${deployment.network}:${deployment.protocolVersion}`;
    if (keys.has(key)) fail(`duplicate deployment ${key}`);
    keys.add(key);

    if (deployment.protocolVersion !== "v1.4")
      fail(`${key} has unsupported version`);
    if (deployment.settlementEnabled && deployment.status !== "enabled") {
      fail(`${key} enables settlement without status=enabled`);
    }
    if (!deployment.settlementEnabled && !deployment.disabledReason) {
      fail(`${key} is disabled without disabledReason`);
    }
    if (deployment.network === "botchain")
      fail("BOT Chain must not be registered for v1.4");

    if (deployment.ecosystem === "evm") {
      if (!Number.isInteger(deployment.chainId))
        fail(`${key} has invalid chainId`);
      const addresses = [
        deployment.contracts?.splitter,
        deployment.contracts?.tokenList,
        deployment.contracts?.profiles,
      ];
      if (
        addresses.some((address) => !/^0x[0-9a-fA-F]{40}$/.test(address ?? ""))
      ) {
        fail(`${key} has an invalid component address`);
      }
      if (
        deployment.status !== "invalid" &&
        new Set(addresses.map((a) => a.toLowerCase())).size !== 3
      ) {
        fail(`${key} reuses a component address`);
      }
      for (const asset of deployment.assets ?? []) {
        if (!asset.symbol || !/^0x[0-9a-fA-F]{40}$/.test(asset.address ?? "")) {
          fail(`${key} has an invalid asset`);
        }
        if (asset.address.toLowerCase() === zeroAddress)
          fail(`${key} contains a zero-address asset`);
      }
    }
  }

  const polygon = registry.deployments.find(
    (d) => d.ecosystem === "evm" && d.network === "polygon",
  );
  const bridgedUsdc = polygon?.assets?.find(
    (asset) =>
      asset.address.toLowerCase() ===
      "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
  );
  if (bridgedUsdc?.symbol !== "USDC.e")
    fail("Polygon 0x2791… must be identified as USDC.e");

  const expectedSolana = {
    devnet: "8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y",
    mainnet: "724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD",
  };
  for (const [network, programId] of Object.entries(expectedSolana)) {
    const deployment = registry.deployments.find(
      (d) => d.ecosystem === "solana" && d.network === network,
    );
    if (deployment?.programId !== programId)
      fail(`unexpected Solana ${network} program id`);
  }
}

function json(value) {
  return JSON.stringify(value, null, 2);
}

function renderEvm() {
  const deployments = Object.fromEntries(
    registry.deployments
      .filter((deployment) => deployment.ecosystem === "evm")
      .map((deployment) => {
        const findAsset = (symbol) =>
          deployment.assets.find((asset) => asset.symbol === symbol)?.address ??
          zeroAddress;
        return [
          deployment.network,
          {
            network: deployment.network,
            chainId: deployment.chainId,
            environment: deployment.environment,
            splitterVersion: "1.4",
            status: deployment.status,
            settlementEnabled: deployment.settlementEnabled,
            ...(deployment.disabledReason
              ? { disabledReason: deployment.disabledReason }
              : {}),
            sourceArtifact: deployment.sourceArtifact,
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
            safe: deployment.safe,
          },
        ];
      }),
  );
  const source = registry.sources.evm;
  return `// DO NOT EDIT. Generated by scripts/generate-payment-deployments.mjs.\n\nimport type { SdkEnvironment } from "./deploymentResolver.js";\n\nexport interface V14Asset {\n  symbol: string;\n  address: \`0x\${string}\`;\n  name?: string;\n  source?: string | null;\n}\n\nexport interface V14Splitter {\n  address: \`0x\${string}\`;\n  admin: \`0x\${string}\`;\n  signer: \`0x\${string}\`;\n  pauser: \`0x\${string}\`;\n  treasury: \`0x\${string}\`;\n  tokenList: \`0x\${string}\`;\n  profiles: \`0x\${string}\`;\n  assets: readonly V14Asset[];\n  /** @deprecated Use assets; retained for one compatibility release. */\n  usdc: \`0x\${string}\`;\n  /** @deprecated Use assets; retained for one compatibility release. */\n  usdt: \`0x\${string}\`;\n}\n\nexport interface V14Safe {\n  address: \`0x\${string}\`;\n  version: string;\n  threshold: number;\n  owners: readonly \`0x\${string}\`[];\n}\n\nexport interface V14Deployment {\n  network: string;\n  chainId: number;\n  environment: SdkEnvironment;\n  splitterVersion: "1.4";\n  status: "enabled" | "disabled" | "invalid" | "retired";\n  settlementEnabled: boolean;\n  disabledReason?: string;\n  sourceArtifact: string;\n  splitter: V14Splitter;\n  runtimeCodeHash: \`0x\${string}\`;\n  safe: V14Safe;\n}\n\nexport const V14_DEPLOYMENTS_SOURCE = ${json({ ...source, branch: "dev" })} as const;\n\nexport const V14_DEPLOYMENTS: Record<string, V14Deployment> = ${json(deployments)};\n\nexport const V14_DEV_NETWORKS = ["amoy"] as const;\n`;
}

function renderSolana() {
  const deployments = Object.fromEntries(
    registry.deployments
      .filter((deployment) => deployment.ecosystem === "solana")
      .map((deployment) => [
        deployment.network,
        {
          network: deployment.network,
          environment: deployment.environment,
          splitterVersion: "1.4",
          status: deployment.status,
          settlementEnabled: deployment.settlementEnabled,
          disabledReason: deployment.disabledReason,
          programId: deployment.programId,
          idl: { ...deployment.idl, artifact: deployment.sourceArtifact },
        },
      ]),
  );
  const source = registry.sources.solana;
  return `// DO NOT EDIT. Generated by scripts/generate-payment-deployments.mjs.\n\nimport type { SdkEnvironment } from "./deploymentResolver.js";\n\nexport type SolanaNetwork = "devnet" | "mainnet";\n\nexport interface SolanaV14Deployment {\n  network: SolanaNetwork;\n  environment: SdkEnvironment;\n  splitterVersion: "1.4";\n  status: "enabled" | "disabled" | "invalid" | "retired";\n  settlementEnabled: boolean;\n  disabledReason?: string;\n  programId: string;\n  idl: { name: string; version: string; artifact: string };\n}\n\nexport const SOLANA_V14_DEPLOYMENTS_SOURCE = ${json({ ...source, branch: "dev" })} as const;\n\nexport const SOLANA_V14_DEPLOYMENTS: Record<string, SolanaV14Deployment> = ${json(deployments)};\n\nexport const SOLANA_DEV_NETWORKS = ["devnet"] as const;\n`;
}

function writeOrCheck(outputPath, content) {
  if (checkOnly) {
    if (
      !fs.existsSync(outputPath) ||
      fs.readFileSync(outputPath, "utf8") !== content
    ) {
      throw new Error(
        `${path.relative(nodeRoot, outputPath)} is stale; run registry:payment:sync`,
      );
    }
  } else {
    fs.writeFileSync(outputPath, content);
  }
}

validate();
writeOrCheck(evmOutput, renderEvm());
writeOrCheck(solanaOutput, renderSolana());
console.log(
  checkOnly
    ? "Payment deployment registry is current."
    : "Generated payment deployment tables.",
);
