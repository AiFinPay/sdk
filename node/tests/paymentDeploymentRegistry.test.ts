import { describe, expect, it } from "vitest";
import {
  SOLANA_V14_DEPLOYMENTS,
  SOLANA_V14_DEPLOYMENTS_SOURCE,
  V14_DEPLOYMENTS,
  V14_DEPLOYMENTS_SOURCE,
  V14_DEV_NETWORKS,
} from "../src/index.js";

describe("payment deployment registry provenance", () => {
  it("pins the CTO-provided EVM and Solana commits", () => {
    expect(V14_DEPLOYMENTS_SOURCE.commit).toBe("470b328494492dcb8567fc80ed1f5cad54ada9e7");
    expect(SOLANA_V14_DEPLOYMENTS_SOURCE.commit).toBe("e5df8f5436cf646ab495381eee04e0d1a10b4e2f");
  });

  it("preserves the selected network cohort and imports Robinhood with assets", () => {
    // BOT Chain joined in agent 2.11.0 (owner decision 2026-10-29), USDT only.
    expect(V14_DEPLOYMENTS.botchain.chainId).toBe(677);
    expect(V14_DEPLOYMENTS.botchain.splitter.assets.map((a) => a.symbol)).toEqual(["USDT"]);
    expect(Object.keys(V14_DEPLOYMENTS).sort()).toEqual([
      "amoy",
      "arbitrum",
      "arc",
      "arctestnet",
      "avalanche",
      "base",
      "bnb",
      "botchain",
      "optimism",
      "polygon",
      "robinhood",
      "unichain",
      "xrplevm",
    ]);
    const robinhood = V14_DEPLOYMENTS.robinhood;
    expect(robinhood.chainId).toBe(4663);
    expect(robinhood.status).toBe("enabled");
    expect(robinhood.settlementEnabled).toBe(true);
    expect(robinhood.splitter.assets.length).toBeGreaterThan(0);
  });

  it("Base deployment is enabled", () => {
    const base = V14_DEPLOYMENTS.base;
    expect(base.status).toBe("enabled");
    expect(base.settlementEnabled).toBe(true);
  });

  it("identifies Polygon 0x2791… as bridged USDC, never USDT", () => {
    const asset = V14_DEPLOYMENTS.polygon.splitter.assets.find(
      ({ address }) => address.toLowerCase() === "0x2791bca1f2de4661ed88a30c99a7a9449aa84174"
    );
    expect(asset?.symbol).toBe("USDC.e");
    expect(V14_DEPLOYMENTS.polygon.splitter.usdt).toBe("0x0000000000000000000000000000000000000000");
  });

  it("contains the redeployed Solana program IDs, enabled from @aifinpay/deployments 2.1.0", () => {
    expect(SOLANA_V14_DEPLOYMENTS.devnet.programId).toBe("8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y");
    expect(SOLANA_V14_DEPLOYMENTS.mainnet.programId).toBe("724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD");
    for (const d of [SOLANA_V14_DEPLOYMENTS.devnet, SOLANA_V14_DEPLOYMENTS.mainnet]) {
      expect(d.settlementEnabled).toBe(true);
      expect(d.status).toBe("enabled");
    }
  });

  it("imports Arc and Arc Testnet as USDC-only, keeping the testnet dev-only", () => {
    const usdc = "0x3600000000000000000000000000000000000000";
    expect(V14_DEPLOYMENTS.arc).toMatchObject({ chainId: 5042, environment: "prod", status: "enabled" });
    expect(V14_DEPLOYMENTS.arctestnet).toMatchObject({ chainId: 5042002, environment: "dev", status: "enabled" });
    for (const d of [V14_DEPLOYMENTS.arc, V14_DEPLOYMENTS.arctestnet]) {
      expect(d.splitter.address).toBe("0x78bed24B8D3A5eB2cf8D9A0D6A9Da6Bc5d7f32eB");
      expect(d.splitter.signer).toBe("0x0000e81aEf36D89373FBF0012550B10B63dAa873");
      // EURC is in the registry but never offered: quotes price tokens 1:1 with USD.
      expect(d.splitter.assets).toEqual([{ symbol: "USDC", name: "USDC", address: usdc }]);
    }
    expect(V14_DEV_NETWORKS).toEqual(["amoy", "arctestnet"]);
  });
});
