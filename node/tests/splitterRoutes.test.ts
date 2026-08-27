// v1.3 route selection. Static-shape tests only, no network calls — every
// value here was read from chain by verify-registry.mjs in evm-contract when
// the registry was authored (2026-08-27).
import { describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  SPLITTER_ROUTES,
  resolveSplitterRoute,
  resolveSettlingSplitterRoute,
  UnknownSplitterRouteError,
  SplitterRouteNotSettlingError,
  type SplitterRouteDeployment,
} from "../src/index.js";

const CHAIN_IDS: Record<string, number> = {
  polygon: 137, optimism: 10, bnb: 56, unichain: 130, botchain: 677,
  base: 8453, arbitrum: 42161, avalanche: 43114, xrplevm: 1440000,
};
const BPS: Record<string, number> = { "merchant-aifp1": 100, "agent-x402": 0 };
const entries = Object.entries(SPLITTER_ROUTES);

describe("SPLITTER_ROUTES", () => {
  it("has both routes on all nine chains", () => {
    expect(entries).toHaveLength(18);
    for (const chain of Object.keys(CHAIN_IDS)) {
      for (const route of Object.keys(BPS)) {
        expect(SPLITTER_ROUTES[`${chain}:${route}` as keyof typeof SPLITTER_ROUTES], `${chain}:${route}`).toBeDefined();
      }
    }
  });

  it("every key agrees with the chain and route inside it", () => {
    for (const [key, d] of entries) expect(`${d.chain}:${d.route}`, key).toBe(key);
  });

  it("chainId and viem chain agree", () => {
    for (const [key, d] of entries) {
      expect(d.chainId, key).toBe(CHAIN_IDS[d.chain]);
      expect(d.viemChain.id, key).toBe(d.chainId);
    }
  });

  it("fee split matches the route, and no route carries a creator leg", () => {
    for (const [key, d] of entries) {
      expect(d.treasuryBps, key).toBe(BPS[d.route]);
      expect(d.ipCreatorBps, key).toBe(0);
    }
  });

  it("addresses are checksummed and the treasury is the same Safe everywhere", () => {
    const treasuries = new Set(entries.map(([, d]) => d.treasury));
    expect(treasuries.size).toBe(1);
    for (const [key, d] of entries) {
      expect(getAddress(d.splitter), key).toBe(d.splitter);
      expect(getAddress(d.treasury), key).toBe(d.treasury);
    }
  });

  it("there are exactly two runtime code hashes, one per route", () => {
    // The bps are immutable and baked into runtime code, so a route with the
    // wrong profile would hash differently. Two hashes across eighteen
    // contracts is the evidence that the right profile reached every chain.
    const byRoute = new Map<string, Set<string>>();
    for (const [, d] of entries) {
      if (!byRoute.has(d.route)) byRoute.set(d.route, new Set());
      byRoute.get(d.route)!.add(d.runtimeCodeHash);
    }
    expect([...byRoute.keys()].sort()).toEqual(["agent-x402", "merchant-aifp1"]);
    for (const [route, hashes] of byRoute) expect(hashes.size, route).toBe(1);
    expect(new Set(entries.map(([, d]) => d.runtimeCodeHash)).size).toBe(2);
  });

  it("ships with settlement disabled on every route", () => {
    // Deployed and verified is not payable. Flipping these on is a deliberate
    // per-route act after a paid mainnet E2E, never a side effect of a release.
    for (const [key, d] of entries) expect(d.settlementEnabled, key).toBe(false);
  });
});

describe("address reuse across chains", () => {
  // The splitters were deployed with CREATE, so the same address recurs on
  // other chains for the OTHER route. This is the reason selection is keyed on
  // chain AND route, and the reason an address must never be used as a key.
  it("the same address really does appear under more than one route", () => {
    const byAddress = new Map<string, string[]>();
    for (const [key, d] of entries) {
      const k = d.splitter.toLowerCase();
      byAddress.set(k, [...(byAddress.get(k) ?? []), key]);
    }
    const shared = [...byAddress.values()].filter((keys) => keys.length > 1);
    expect(shared.length, "expected CREATE address reuse across chains").toBeGreaterThan(0);
    // and every reuse spans different chains, never the same chain twice
    for (const keys of shared) {
      const chains = keys.map((k) => k.split(":")[0]);
      expect(new Set(chains).size, keys.join(" / ")).toBe(chains.length);
    }
  });

  it("a shared address still resolves to the right economics per chain", () => {
    const op = resolveSplitterRoute("optimism", "merchant-aifp1");
    const base = resolveSplitterRoute("base", "agent-x402");
    expect(op.splitter).toBe(base.splitter); // same address, different chains
    expect(op.treasuryBps).toBe(100);
    expect(base.treasuryBps).toBe(0);
  });
});

describe("resolveSplitterRoute", () => {
  it("returns the entry for a known pair", () => {
    const d: SplitterRouteDeployment = resolveSplitterRoute("polygon", "merchant-aifp1");
    expect(d.chainId).toBe(137);
    expect(d.treasuryBps).toBe(100);
  });

  it("throws rather than falling back to the other route", () => {
    expect(() => resolveSplitterRoute("polygon", "not-a-route")).toThrow(UnknownSplitterRouteError);
    expect(() => resolveSplitterRoute("ethereum", "agent-x402")).toThrow(UnknownSplitterRouteError);
  });

  it("refuses a chain-only lookup", () => {
    expect(() => resolveSplitterRoute("polygon", "")).toThrow(UnknownSplitterRouteError);
  });
});

describe("resolveSettlingSplitterRoute", () => {
  it("refuses a route that is not enabled for settlement", () => {
    expect(() => resolveSettlingSplitterRoute("polygon", "merchant-aifp1"))
      .toThrow(SplitterRouteNotSettlingError);
  });

  it("still refuses an unknown pair", () => {
    expect(() => resolveSettlingSplitterRoute("polygon", "nope")).toThrow(UnknownSplitterRouteError);
  });

  it("refuses once the policy window has expired", () => {
    const d = SPLITTER_ROUTES["polygon:merchant-aifp1"];
    const after = new Date(Date.parse(d.validUntil) + 86_400_000);
    // enabled or not, an expired window must never settle
    expect(() => resolveSettlingSplitterRoute("polygon", "merchant-aifp1", after))
      .toThrow(SplitterRouteNotSettlingError);
  });
});
