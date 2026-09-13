import { describe, expect, it } from "vitest";
import {
  SOLANA_V14_DEPLOYMENTS,
  SOLANA_V14_DEPLOYMENTS_SOURCE,
  V14_DEPLOYMENTS,
  V14_DEPLOYMENTS_SOURCE,
} from "../src/index.js";

describe("payment deployment registry provenance", () => {
  it("pins the CTO-provided EVM and Solana commits", () => {
    expect(V14_DEPLOYMENTS_SOURCE.commit).toBe(
      "a54a4c107de7bb42f54e411e621d3897938bfc31",
    );
    expect(SOLANA_V14_DEPLOYMENTS_SOURCE.commit).toBe(
      "e5df8f5436cf646ab495381eee04e0d1a10b4e2f",
    );
  });

  it("excludes BOT Chain and imports Robinhood in quarantine", () => {
    expect(V14_DEPLOYMENTS.botchain).toBeUndefined();
    expect(V14_DEPLOYMENTS.robinhood.chainId).toBe(4663);
    expect(V14_DEPLOYMENTS.robinhood.settlementEnabled).toBe(false);
    expect(V14_DEPLOYMENTS.robinhood.splitter.assets).toEqual([]);
  });

  it("marks the invalid Base deployment unusable", () => {
    const base = V14_DEPLOYMENTS.base;
    expect(base.status).toBe("invalid");
    expect(base.settlementEnabled).toBe(false);
    expect(base.splitter.address).toBe(base.splitter.tokenList);
  });

  it("identifies Polygon 0x2791… as bridged USDC, never USDT", () => {
    const asset = V14_DEPLOYMENTS.polygon.splitter.assets.find(
      ({ address }) =>
        address.toLowerCase() === "0x2791bca1f2de4661ed88a30c99a7a9449aa84174",
    );
    expect(asset?.symbol).toBe("USDC.e");
    expect(V14_DEPLOYMENTS.polygon.splitter.usdt).toBe(
      "0x0000000000000000000000000000000000000000",
    );
  });

  it("contains the redeployed Solana program IDs but keeps them disabled", () => {
    expect(SOLANA_V14_DEPLOYMENTS.devnet.programId).toBe(
      "8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y",
    );
    expect(SOLANA_V14_DEPLOYMENTS.mainnet.programId).toBe(
      "724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD",
    );
    expect(SOLANA_V14_DEPLOYMENTS.devnet.settlementEnabled).toBe(false);
    expect(SOLANA_V14_DEPLOYMENTS.mainnet.settlementEnabled).toBe(false);
  });
});
