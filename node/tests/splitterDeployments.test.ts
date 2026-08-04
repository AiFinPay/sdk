// Sanity checks for the B2BSplitter multi-chain deployment registry.
// These are static-shape tests only — actual bytecode presence at each
// splitter address was verified on-chain (eth_getCode) when the registry
// was authored (2026-07-15). No network calls here.
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import { SPLITTER_DEPLOYMENTS } from "../src/index.js";

const EXPECTED_CHAIN_IDS: Record<string, number> = {
  polygon:  137,
  base:     8453,
  optimism: 10,
  unichain: 130,
  botchain: 677,
  xrplevm:  1440000,
};

describe("SPLITTER_DEPLOYMENTS registry", () => {
  it("contains exactly the verified chains", () => {
    expect(Object.keys(SPLITTER_DEPLOYMENTS).sort()).toEqual(
      Object.keys(EXPECTED_CHAIN_IDS).sort(),
    );
  });

  it("chainId matches the viem chain object on every entry", () => {
    for (const [name, d] of Object.entries(SPLITTER_DEPLOYMENTS)) {
      expect(d.chainId, name).toBe(EXPECTED_CHAIN_IDS[name]);
      expect(d.chain.id, name).toBe(d.chainId);
    }
  });

  it("splitter + usdc addresses are checksum-valid", () => {
    for (const [name, d] of Object.entries(SPLITTER_DEPLOYMENTS)) {
      expect(getAddress(d.splitter), name).toBe(d.splitter);
      if (d.usdc) expect(getAddress(d.usdc), name).toBe(d.usdc);
    }
  });

  it("has a default RPC and explorer on every entry", () => {
    for (const d of Object.values(SPLITTER_DEPLOYMENTS)) {
      expect(d.defaultRpc).toMatch(/^https:\/\//);
      expect(d.explorer).toMatch(/^https:\/\//);
      expect(d.nativeUsdEnv).toMatch(/^AIFINPAY_/);
      expect(d.nativeUsdDefault).toBeGreaterThan(0);
      expect(typeof d.enabled).toBe("boolean");
    }
  });

  it("native-only chains (botchain, xrplevm) carry no usdc entry", () => {
    expect(SPLITTER_DEPLOYMENTS.botchain.usdc).toBeUndefined();
    expect(SPLITTER_DEPLOYMENTS.xrplevm.usdc).toBeUndefined();
    expect(SPLITTER_DEPLOYMENTS.polygon.usdc).toBeDefined();
    expect(SPLITTER_DEPLOYMENTS.base.usdc).toBeDefined();
    expect(SPLITTER_DEPLOYMENTS.optimism.usdc).toBeDefined();
    expect(SPLITTER_DEPLOYMENTS.unichain.usdc).toBeDefined();
  });
});
