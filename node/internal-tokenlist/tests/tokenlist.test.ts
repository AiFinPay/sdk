import { describe, expect, it } from "vitest";
import { ERC20_ABI, findToken, INTERNAL_TOKENLIST } from "../src/index.js";

// Offline guards. The live-chain verification is `npm run generate:check`
// (the generator fails on any disagreement with the chain); these tests pin
// the shape and the known traps so a bad edit fails without network access.

describe("internal token list", () => {
  it("has a valid shape", () => {
    expect(INTERNAL_TOKENLIST.tokens.length).toBeGreaterThan(0);
    for (const t of INTERNAL_TOKENLIST.tokens) {
      expect(typeof t.chainId).toBe("number");
      expect(t.address.length).toBeGreaterThan(20);
      expect(typeof t.symbol).toBe("string");
      expect(Number.isInteger(t.decimals)).toBe(true);
      expect(t.network.length).toBeGreaterThan(0);
    }
  });

  it("has no duplicate (network, address) entries", () => {
    const keys = INTERNAL_TOKENLIST.tokens.map((t) => `${t.network}:${t.address.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("pins the BSC 18-decimals trap (AIFINP-120)", () => {
    // BSC USDT/USDC are 18 decimals. If either ever reads 6 here, someone
    // hand-edited the generated file — the exact 10^12 error this package
    // exists to prevent.
    const usdt = findToken("BSC", "0x55d398326f99059fF775485246999027B3197955");
    const usdc = findToken("BSC", "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d");
    expect(usdt?.decimals).toBe(18);
    expect(usdc?.decimals).toBe(18);
  });

  it("uses native Circle USDC on Polygon, not bridged USDC.e", () => {
    expect(findToken("Polygon", "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359")).toBeDefined();
    expect(findToken("Polygon", "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174")).toBeUndefined();
  });

  it("keys Polygon USDT by address, tolerating the USDT0 symbol rename", () => {
    const t = findToken("Polygon", "0xc2132D05D31c914a87C6611C10748AEb04B58e8F");
    expect(t?.decimals).toBe(6);
    expect(t?.symbol).toBe("USDT0");
  });

  it("carries the canonical Solana mints", () => {
    expect(findToken("Solana", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v")?.decimals).toBe(6);
    expect(findToken("Solana", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB")?.decimals).toBe(6);
  });
});

describe("ERC20 ABI", () => {
  it("carries the required functions", () => {
    const names = ERC20_ABI.filter((f) => f.type === "function").map((f) => f.name);
    for (const required of ["balanceOf", "transfer", "transferFrom", "allowance", "approve", "decimals", "symbol"]) {
      expect(names).toContain(required);
    }
  });
});
