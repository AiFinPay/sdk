import { describe, expect, it } from "vitest";
import { APTOS_V14_DEPLOYMENTS, NEAR_V14_DEPLOYMENTS, SOLANA_V14_DEPLOYMENTS, TRON_V14_DEPLOYMENTS } from "@aifinpay/agent";
import { runDeploymentInfo } from "../src/tools/supported-chains.js";
import type { ToolContext } from "../src/server.js";

type Row = { network: string; environment: string };
const run = async (args: Record<string, unknown>) =>
  (await runDeploymentInfo({} as ToolContext, args)).structuredContent as Record<string, Row[]>;

const devOf = (table: Record<string, Row | undefined>) =>
  Object.values(table)
    .filter((d): d is Row => d?.environment === "dev")
    .map((d) => d.network)
    .sort();

describe("deployment_info", () => {
  it("lists every ecosystem the installed registry carries", async () => {
    const result = await run({});
    expect(Object.keys(result).sort()).toEqual(["aptos", "casper", "evm", "near", "solana", "tron"]);
    expect(result.aptos.length).toBe(Object.values(APTOS_V14_DEPLOYMENTS).filter(Boolean).length);
    expect(result.near.length).toBe(Object.values(NEAR_V14_DEPLOYMENTS).filter(Boolean).length);
    expect(result.tron.length).toBe(Object.values(TRON_V14_DEPLOYMENTS).length);
  });

  it("returns the test networks of every non-EVM ecosystem under environment=dev", async () => {
    const result = await run({ environment: "dev" });
    expect(result.solana.map((d) => d.network).sort()).toEqual(devOf(SOLANA_V14_DEPLOYMENTS));
    expect(result.aptos.map((d) => d.network)).toEqual(devOf(APTOS_V14_DEPLOYMENTS));
    expect(result.near.map((d) => d.network)).toEqual(devOf(NEAR_V14_DEPLOYMENTS));
    expect(result.tron.map((d) => d.network)).toEqual(devOf(TRON_V14_DEPLOYMENTS));
    expect(result.aptos.length && result.near.length && result.tron.length).toBeGreaterThan(0);
    for (const list of Object.values(result)) for (const d of list) expect(d.environment).not.toBe("prod");
  });

  it("filters by ecosystem and network", async () => {
    const result = await run({ ecosystem: "near", network: "testnet" });
    expect(Object.keys(result)).toEqual(["near"]);
    expect(result.near).toEqual([expect.objectContaining({ network: "testnet", environment: "dev" })]);
  });
});
