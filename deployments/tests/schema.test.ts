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
