import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const registryFiles = [
  "registry/splitter/evm/v1.1/deployments.json",
  "registry/splitter/evm/v1.2/deployments.json",
  "registry/splitter/evm/v1.3/deployments.json",
  "registry/splitter/evm/v1.4/deployments.json",
  "registry/splitter/solana/deployments.json",
  "registry/splitter/casper/deployments.json",
  "registry/splitter/aptos/deployments.json",
  "registry/splitter/near/deployments.json",
];
const aptosMultisigFiles = [
  "registry/splitter/aptos/multisig-deployments.json",
];

describe("payment deployment schema references", () => {
  it("resolves each registry's $schema reference to the packaged schema", () => {
    const expectedSchemaPath = resolve(packageRoot, "src/reference/payment-deployments.schema.json");

    for (const file of registryFiles) {
      const registryPath = resolve(packageRoot, file);
      const registry = JSON.parse(readFileSync(registryPath, "utf8"));
      const schemaPath = resolve(dirname(registryPath), registry.$schema);

      expect(schemaPath, file).toBe(expectedSchemaPath);
      expect(existsSync(schemaPath), file).toBe(true);
    }
  });

  it("declares the JSON Schema 2020-12 dialect", () => {
    const schema = JSON.parse(
      readFileSync(resolve(packageRoot, "src/reference/payment-deployments.schema.json"), "utf8"),
    );

    expect(schema.$schema).toBe("https://json-schema.org/draft/2020-12/schema");
  });

  it("packages Aptos schemas and referenced ABI artifacts", () => {
    for (const file of registryFiles.filter((path) => path.startsWith("registry/splitter/aptos/"))) {
      const registryPath = resolve(packageRoot, file);
      const registry = JSON.parse(readFileSync(registryPath, "utf8"));
      const schemaPath = resolve(dirname(registryPath), registry.$schema);

      expect(schemaPath).toBe(
        resolve(packageRoot, "src/reference/payment-deployments.schema.json"),
      );
      expect(existsSync(schemaPath), file).toBe(true);

      for (const deployment of registry.deployments) {
        expect(deployment).not.toHaveProperty("status");
        for (const artifactPath of [deployment.abi, deployment.sourceArtifact]) {
          expect(existsSync(resolve(dirname(registryPath), artifactPath)), artifactPath).toBe(true);
        }
      }

      if (registry.sourceArtifact.path) {
        expect(
          existsSync(resolve(dirname(registryPath), registry.sourceArtifact.path)),
          registry.sourceArtifact.path,
        ).toBe(true);
      }
    }

    for (const file of aptosMultisigFiles) {
      const registryPath = resolve(packageRoot, file);
      const registry = JSON.parse(readFileSync(registryPath, "utf8"));
      const schemaPath = resolve(dirname(registryPath), registry.$schema);

      expect(schemaPath).toBe(
        resolve(packageRoot, "src/reference/aptos-multisig-deployment.schema.json"),
      );
      expect(existsSync(schemaPath), file).toBe(true);
      expect(registry.deployments.map(({ network }: { network: string }) => network)).toEqual([
        "mainnet",
        "testnet",
      ]);
      for (const deployment of registry.deployments) {
        expect(deployment.source).toMatchObject({
          repo: "AiFinPay/aptos-contract",
          commit: expect.stringMatching(/^[0-9a-f]{40}$/),
          path: expect.any(String),
        });
      }
    }
  });

  it("defines ecosystem-specific Aptos and NEAR deployment records", () => {
    const schema = JSON.parse(
      readFileSync(resolve(packageRoot, "src/reference/payment-deployments.schema.json"), "utf8"),
    );
    const expectedFields: Record<string, string[]> = {
      aptosDeployment: [
        "network",
        "chainId",
        "packageAddress",
        "packageName",
        "modules",
        "sourceArtifact",
      ],
      nearDeployment: [
        "network",
        "contractAccountId",
        "wasmCodeHash",
        "sourceArtifact",
      ],
    };

    for (const [definition, fields] of Object.entries(expectedFields)) {
      expect(schema.$defs[definition]).toBeDefined();
      expect(schema.$defs[definition].required).toEqual(expect.arrayContaining(fields));
    }

    for (const ecosystem of ["aptos", "near"]) {
      const rule = schema.allOf.find(
        (condition: { if: { properties: { ecosystem: { const: string } } } }) =>
          condition.if.properties.ecosystem.const === ecosystem,
      );
      expect(rule?.then.properties.deployments.items.$ref).toBe(
        `#/$defs/${ecosystem}Deployment`,
      );
      expect(rule?.then.properties.source.required).toEqual(["commit", "path"]);
    }
  });

  it("packages NEAR account/WASM snapshots with immutable provenance", () => {
    const registry = JSON.parse(
      readFileSync(resolve(packageRoot, "registry/splitter/near/deployments.json"), "utf8"),
    );
    expect(registry.ecosystem).toBe("near");
    expect(registry.source).toMatchObject({
      repo: "AiFinPay/near-contract",
      commit: expect.stringMatching(/^[0-9a-f]{40}$/),
      path: "deployments/",
    });
    expect(registry.deployments.map(({ network }: { network: string }) => network)).toEqual([
      "mainnet",
      "testnet",
    ]);

    const artifactPrefix =
      `https://github.com/${registry.source.repo}/blob/${registry.source.commit}/deployments/`;
    for (const deployment of registry.deployments) {
      const isTestnet = deployment.network === "testnet";
      expect(deployment.environment).toBe(isTestnet ? "dev" : "prod");
      expect(deployment.testnet).toBe(isTestnet);
      expect(deployment.contractAccountId).toMatch(
        new RegExp(`^[a-z0-9._-]+\\.${isTestnet ? "testnet" : "near"}$`),
      );
      expect(deployment.wasmCodeHash).toMatch(/^[0-9a-f]{64}$/);
      expect(deployment.wasmCodeHash).toBe(deployment.runtimeCodeHash);
      expect(deployment.treasuryAccountId).toBe(deployment.splitter.treasury);
      expect(Number.isNaN(Date.parse(deployment.timestamp))).toBe(false);
      expect(deployment.sourceArtifact.startsWith(artifactPrefix + deployment.network + "-")).toBe(true);
      expect(deployment.sourceArtifact).not.toContain("latest");
      expect(deployment.settlementEnabled).toBe(!isTestnet);
      expect(deployment.splitter.paused).toBe(isTestnet);
      expect(deployment.splitter.routes).toEqual([
        { route_id: "ROUTE_AGENT_X402", treasury_bps: 0, ip_creator_bps: 0 },
        { route_id: "ROUTE_MERCHANT_AIFP1", treasury_bps: 100, ip_creator_bps: 0 },
      ]);
    }

    const membership = registry.governanceMembership;
    expect(membership.network).toBe("mainnet");
    expect(membership.sourceArtifact).toBe(artifactPrefix + "multisig-members.mainnet.json");
    expect(membership.members.length).toBeGreaterThan(0);
    expect(new Set(membership.members).size).toBe(membership.members.length);
    expect(membership).not.toHaveProperty("threshold");
  });

  it("omits status and disabledReason from generated deployment shapes and registry records", () => {
    const schema = JSON.parse(
      readFileSync(resolve(packageRoot, "src/reference/payment-deployments.schema.json"), "utf8"),
    );

    for (const definition of [
      "evmDeployment",
      "solanaDeployment",
      "casperDeployment",
      "aptosDeployment",
      "nearDeployment",
    ]) {
      expect(schema.$defs[definition].properties).not.toHaveProperty("status");
      expect(schema.$defs[definition].properties).not.toHaveProperty("disabledReason");
    }

    for (const file of registryFiles) {
      const registry = JSON.parse(readFileSync(resolve(packageRoot, file), "utf8"));
      for (const deployment of registry.deployments) {
        expect(deployment, `${file} deployment`).not.toHaveProperty("status");
        expect(deployment, `${file} deployment`).not.toHaveProperty("disabledReason");
      }
    }

    const casperIdl = JSON.parse(
      readFileSync(resolve(packageRoot, "registry/idl/casper/aifinpay-casper-schema.json"), "utf8"),
    );
    for (const deployment of Object.values(casperIdl.deployments)) {
      expect(deployment).not.toHaveProperty("status");
      expect(deployment).not.toHaveProperty("disabledReason");
    }
  });
});
