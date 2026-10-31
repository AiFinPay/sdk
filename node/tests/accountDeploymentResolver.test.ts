import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  AccountDeploymentResolverError,
  AiFinPayAgent,
  APTOS_V14_DEPLOYMENTS,
  NEAR_V14_DEPLOYMENTS,
  getAptosDeployment,
  getNearDeployment,
  resolveAptosDeployment,
  resolveNearDeployment,
  type ResolveAccountDeploymentOptions,
} from "../src/index.js";
import { paymentChain } from "../src/paymentChains.js";

const require = createRequire(import.meta.url);
const deploymentsRoot = dirname(require.resolve("@aifinpay/deployments/package.json"));

describe.each([
  { family: "aptos", get: getAptosDeployment, select: resolveAptosDeployment, table: APTOS_V14_DEPLOYMENTS },
  { family: "near", get: getNearDeployment, select: resolveNearDeployment, table: NEAR_V14_DEPLOYMENTS },
])("$family deployment selection", ({ family, get, select, table }) => {
  it("binds normalized mainnet/testnet names to the explicit owner environment", () => {
    expect(get({ environment: "prod", network: " MAINNET " })).toBe(table.mainnet);
    expect(get({ environment: "dev", network: "TESTNET" })).toBe(table.testnet);
    expect(() => get({ environment: "prod", network: "testnet" })).toThrow(AccountDeploymentResolverError);
    expect(() => get({ environment: "dev", network: "mainnet" })).toThrow(AccountDeploymentResolverError);
  });

  it.each(["", "devnet", "localnet", "mainnet-beta", "__proto__", "constructor"])(
    "rejects unknown network %j without a default",
    (network) => {
      expect(() => get({ environment: "prod", network })).toThrow(AccountDeploymentResolverError);
    }
  );

  it("rejects malformed runtime environment, network and version values", () => {
    // @ts-expect-error Deliberately exercising callers outside TypeScript.
    expect(() => get({ environment: "staging", network: "mainnet" })).toThrow(AccountDeploymentResolverError);
    // @ts-expect-error A missing network must not select mainnet.
    expect(() => get({ environment: "prod" })).toThrow(AccountDeploymentResolverError);
    // @ts-expect-error No legacy fallback is known for these chains.
    expect(() => get({ environment: "prod", network: "mainnet", version: "v1.2" })).toThrow(
      AccountDeploymentResolverError
    );
  });

  it.each(["auto", "v1.4"] as const)("selects only registry-enabled deployments for version %s", (version) => {
    for (const network of ["mainnet", "testnet"] as const) {
      const options: ResolveAccountDeploymentOptions = {
        environment: network === "mainnet" ? "prod" : "dev",
        network,
        version,
      };
      const deployment = get(options);
      if (deployment.settlementEnabled) {
        expect(select(options)).toBe(deployment);
      } else {
        expect(() => select(options)).toThrow(expect.objectContaining({ family, code: "deployment_disabled" }));
      }
    }
  });

  it("allows inspection but refuses selection of a quarantined deployment", () => {
    const deployment = get({ environment: "prod", network: "mainnet" });
    const previous = deployment.settlementEnabled;
    Object.assign(deployment, { settlementEnabled: false });
    try {
      expect(get({ environment: "prod", network: "mainnet" }).settlementEnabled).toBe(false);
      expect(() => select({ environment: "prod", network: "mainnet" })).toThrow(
        expect.objectContaining({ family, code: "deployment_disabled" })
      );
    } finally {
      Object.assign(deployment, { settlementEnabled: previous });
    }
  });

  it("does not turn a non-EVM family into an EVM payment chain", () => {
    expect(paymentChain(family)).toBeUndefined();
  });
});

it("keeps Aptos module, ABI and network-specific source pins from the installed package", () => {
  const registryPath = resolve(deploymentsRoot, "registry/splitter/aptos/deployments.json");
  const registry = JSON.parse(readFileSync(registryPath, "utf8"));
  for (const record of registry.deployments) {
    const deployment = getAptosDeployment({ environment: record.environment, network: record.network });
    expect(deployment).toMatchObject({
      chainId: record.chainId,
      packageAddress: record.packageAddress,
      modules: record.modules,
      source: record.source ?? registry.source,
      settlementEnabled: record.settlementEnabled,
    });
    const artifact = readFileSync(resolve(dirname(registryPath), record.sourceArtifact));
    expect(deployment.abiSha256).toBe(createHash("sha256").update(artifact).digest("hex"));
  }
});

it("keeps NEAR account/WASM pins without promoting council membership into governance authority", () => {
  const registry = JSON.parse(
    readFileSync(resolve(deploymentsRoot, "registry/splitter/near/deployments.json"), "utf8")
  );
  for (const record of registry.deployments) {
    const deployment = getNearDeployment({ environment: record.environment, network: record.network });
    expect(deployment).toMatchObject({
      contractAccountId: record.contractAccountId,
      wasmCodeHash: record.wasmCodeHash,
      treasuryAccountId: record.treasuryAccountId,
      settlementEnabled: record.settlementEnabled,
      source: record.source ?? registry.source,
      sourceArtifact: record.sourceArtifact,
    });
    expect(deployment).not.toHaveProperty("governance");
    expect(deployment).not.toHaveProperty("threshold");
  }
});

it.each(["aptos", "near"])("refuses %s as an EVM payment before any request or journal write", async (family) => {
  const fetchImpl = vi.fn(async () => {
    throw new Error("No HTTP request should be sent");
  });
  const onPrepared = vi.fn(async () => {});
  const agent = await AiFinPayAgent.fromSeed("24".repeat(32), { telemetry: false, fetchImpl });
  await expect(
    agent.fetchPaid(
      "https://gateway.aifinpay.io/example/resource",
      {},
      {
        v14: {
          // @ts-expect-error A runtime caller must not coerce a non-EVM family into EVM settlement.
          chain: family,
          maxGasWei: 1n,
          onPrepared,
        },
      }
    )
  ).rejects.toThrow(`unsupported v1.4 chain "${family}"`);
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(onPrepared).not.toHaveBeenCalled();
});
