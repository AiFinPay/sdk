import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const nodeRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(import.meta.url);
const deploymentsRoot = dirname(require.resolve("@aifinpay/deployments/package.json"));
let root: string;
let script: string;
let fixturePackage: string;

interface FixtureRegistry {
  deployments: Record<string, unknown>[];
  source: Record<string, unknown>;
}

beforeEach(() => {
  const temp = resolve(nodeRoot, "tests/tmp");
  mkdirSync(temp, { recursive: true });
  root = mkdtempSync(resolve(temp, "account-generator-"));
  script = resolve(root, "node/scripts/generate-payment-deployments.mjs");
  fixturePackage = resolve(root, "node/node_modules/@aifinpay/deployments");
  mkdirSync(dirname(script), { recursive: true });
  mkdirSync(resolve(root, "node/src/generated"), { recursive: true });
  mkdirSync(resolve(root, "python/aifinpay"), { recursive: true });
  mkdirSync(fixturePackage, { recursive: true });
  cpSync(resolve(nodeRoot, "scripts/generate-payment-deployments.mjs"), script);
  cpSync(resolve(deploymentsRoot, "registry"), resolve(fixturePackage, "registry"), { recursive: true });
  writeFileSync(resolve(fixturePackage, "package.json"), '{"name":"@aifinpay/deployments"}\n');
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("Aptos/NEAR deployment generation", () => {
  it("generates deterministic pins, checks both outputs, and detects stale output", () => {
    execFileSync(process.execPath, [script]);
    execFileSync(process.execPath, [script, "--check"]);
    for (const family of ["aptos", "near"]) {
      const output = resolve(root, `node/src/generated/${family}V14Deployments.generated.ts`);
      const content = readFileSync(output, "utf8");
      writeFileSync(output, content + "\n");
      const result = spawnSync(process.execPath, [script, "--check"], { encoding: "utf8" });
      expect(result.status).not.toBe(0);
      expect(result.stderr).toContain(`${family}V14Deployments.generated.ts is stale`);
      writeFileSync(output, content);
    }
  });

  it.each([
    ["aptos", "missing settlement flag", (r: FixtureRegistry) => delete r.deployments[0].settlementEnabled],
    ["near", "missing settlement flag", (r: FixtureRegistry) => delete r.deployments[0].settlementEnabled],
    ["aptos", "cross-environment record", (r: FixtureRegistry) => (r.deployments[0].environment = "dev")],
    ["near", "cross-environment record", (r: FixtureRegistry) => (r.deployments[0].testnet = true)],
    ["aptos", "duplicate network", (r: FixtureRegistry) => r.deployments.push(r.deployments[0])],
    ["near", "duplicate network", (r: FixtureRegistry) => r.deployments.push(r.deployments[0])],
    ["aptos", "invalid chain ID", (r: FixtureRegistry) => (r.deployments[0].chainId = 137)],
    ["aptos", "zero package", (r: FixtureRegistry) => (r.deployments[0].packageAddress = "0x0")],
    ["aptos", "invalid module pins", (r: FixtureRegistry) => (r.deployments[0].modules = [{ name: "splitter" }])],
    [
      "aptos",
      "ABI path traversal",
      (r: FixtureRegistry) => (r.deployments[0].sourceArtifact = "../../../../outside.json"),
    ],
    ["aptos", "unmatched ABI package", (r: FixtureRegistry) => (r.deployments[0].packageAddress = "0x1")],
    ["aptos", "missing source pin", (r: FixtureRegistry) => (r.deployments[0].source = { ...r.source, commit: "dev" })],
    ["near", "missing source pin", (r: FixtureRegistry) => (r.source.commit = "dev")],
    ["near", "invalid account", (r: FixtureRegistry) => (r.deployments[0].contractAccountId = "bad..near")],
    ["near", "invalid WASM hash", (r: FixtureRegistry) => (r.deployments[0].wasmCodeHash = "unknown")],
    ["near", "cross-network account", (r: FixtureRegistry) => (r.deployments[0].contractAccountId = "example.testnet")],
    [
      "near",
      "mutable provenance",
      (r: FixtureRegistry) => (r.deployments[0].sourceArtifact = "https://example.com/latest.json"),
    ],
  ] as const)("rejects %s %s", (family, _description, mutate) => {
    const path = resolve(fixturePackage, `registry/splitter/${family}/deployments.json`);
    const registry: FixtureRegistry = JSON.parse(readFileSync(path, "utf8"));
    mutate(registry);
    writeFileSync(path, JSON.stringify(registry));
    const result = spawnSync(process.execPath, [script], { encoding: "utf8" });
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid payment deployment registry");
  });
});
