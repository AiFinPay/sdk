import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { TRON_V14_DEPLOYMENTS, TRON_V14_DEPLOYMENTS_SOURCE } from "../src/index.js";

const require = createRequire(import.meta.url);
const registry = JSON.parse(
  readFileSync(
    resolve(dirname(require.resolve("@aifinpay/deployments/package.json")), "registry/splitter/tron/v1.4/deployments.json"),
    "utf8"
  )
);

describe("Tron v1.4 deployment metadata", () => {
  it("mirrors every record of the installed registry", () => {
    expect(TRON_V14_DEPLOYMENTS_SOURCE).toEqual(registry.source);
    expect(Object.keys(TRON_V14_DEPLOYMENTS).sort()).toEqual(
      registry.deployments.map((d: { network: string }) => d.network).sort()
    );
    for (const record of registry.deployments) {
      const table = TRON_V14_DEPLOYMENTS[record.network];
      expect(table).toMatchObject({
        chainId: record.chainId,
        environment: record.environment,
        testnet: record.testnet,
        settlementEnabled: record.settlementEnabled,
        runtimeCodeHash: record.runtimeCodeHash,
        contracts: record.contracts,
        sourceArtifact: record.sourceArtifact,
      });
      expect(table.assets.map((a) => a.address)).toEqual(record.assets.map((a: { address: string }) => a.address));
    }
  });

  it("keeps testnets in the dev environment", () => {
    for (const deployment of Object.values(TRON_V14_DEPLOYMENTS)) {
      expect(deployment.environment).toBe(deployment.testnet ? "dev" : "prod");
    }
  });
});
