import { describe, expect, it } from "vitest";
import {
  SOLANA_V14_DEPLOYMENTS,
  SOLANA_V14_DEPLOYMENTS_SOURCE,
  V14_DEPLOYMENTS,
  V14_DEPLOYMENTS_SOURCE,
} from "../src/index.js";

describe("payment deployment registry provenance", () => {
  it("pins the CTO-provided EVM and Solana commits", () => {
    expect(V14_DEPLOYMENTS_SOURCE.commit).toBe("470b328494492dcb8567fc80ed1f5cad54ada9e7");
    expect(SOLANA_V14_DEPLOYMENTS_SOURCE.commit).toBe("e5df8f5436cf646ab495381eee04e0d1a10b4e2f");
  });

  it("preserves the selected network cohort and imports Robinhood with assets", () => {
    expect(V14_DEPLOYMENTS.botchain).toBeUndefined();
    expect(V14_DEPLOYMENTS.arc).toBeUndefined();
    expect(Object.keys(V14_DEPLOYMENTS).sort()).toEqual([
      "amoy",
      "arbitrum",
      "avalanche",
      "base",
      "bnb",
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

  it("contains the redeployed Solana program IDs but keeps them disabled", () => {
    expect(SOLANA_V14_DEPLOYMENTS.devnet.programId).toBe("8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y");
    expect(SOLANA_V14_DEPLOYMENTS.mainnet.programId).toBe("724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD");
    expect(SOLANA_V14_DEPLOYMENTS.devnet.settlementEnabled).toBe(false);
    expect(SOLANA_V14_DEPLOYMENTS.mainnet.settlementEnabled).toBe(false);
  });
});
