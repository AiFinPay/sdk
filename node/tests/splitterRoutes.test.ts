// v1.3 route selection. Static-shape tests only, no network calls — every
// value here was read from chain by verify-registry.mjs in evm-contract when
// the registry was authored (2026-08-27).
import { afterEach, describe, expect, it } from "vitest";
import { getAddress } from "viem";
import {
  SPLITTER_ROUTES,
  SPLITTER_GOVERNANCE,
  SPLITTER_REGISTRY_SOURCE,
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
      .toThrow(/settlement is not enabled/);
  });

  it("still refuses an unknown pair", () => {
    expect(() => resolveSettlingSplitterRoute("polygon", "nope")).toThrow(UnknownSplitterRouteError);
  });
});

/**
 * The policy window, tested against a route that is actually enabled.
 *
 * Every shipped route has settlementEnabled false, so resolveSettlingSplitterRoute
 * rejects on that before it ever looks at validFrom/validUntil. A window test
 * written against a shipped route therefore passes without exercising the window
 * at all — it proves the settlement flag works, twice. These install a synthetic
 * enabled route instead, and assert on the REASON rather than just the throw, so
 * a test cannot pass for the wrong reason again.
 */
describe("policy window (enabled route)", () => {
  const KEY = "testchain:merchant-aifp1";
  const FROM = "2026-08-27T00:00:00.000Z";
  const UNTIL = "2026-11-25T00:00:00.000Z";

  const install = (overrides: Partial<SplitterRouteDeployment> = {}) => {
    const table = SPLITTER_ROUTES as unknown as Record<string, SplitterRouteDeployment>;
    table[KEY] = {
      ...SPLITTER_ROUTES["polygon:merchant-aifp1"],
      settlementEnabled: true,
      validFrom: FROM,
      validUntil: UNTIL,
      ...overrides,
    };
  };

  afterEach(() => {
    delete (SPLITTER_ROUTES as unknown as Record<string, SplitterRouteDeployment>)[KEY];
  });

  const resolve = (now: Date) => resolveSettlingSplitterRoute("testchain", "merchant-aifp1", now);

  it("the synthetic route is genuinely enabled, so these tests exercise the window", () => {
    install();
    expect(SPLITTER_ROUTES[KEY as keyof typeof SPLITTER_ROUTES].settlementEnabled).toBe(true);
    expect(() => resolve(new Date(FROM))).not.toThrow();
  });

  it("rejects before validFrom", () => {
    install();
    const before = new Date(Date.parse(FROM) - 1);
    expect(() => resolve(before)).toThrow(SplitterRouteNotSettlingError);
    expect(() => resolve(before)).toThrow(/policy window opens/);
  });

  it("allows exactly at validFrom — the window is inclusive at its start", () => {
    install();
    expect(resolve(new Date(FROM)).chain).toBe("polygon");
  });

  it("allows inside the window", () => {
    install();
    const middle = new Date((Date.parse(FROM) + Date.parse(UNTIL)) / 2);
    expect(resolve(middle).settlementEnabled).toBe(true);
  });

  it("allows one millisecond before validUntil", () => {
    install();
    expect(() => resolve(new Date(Date.parse(UNTIL) - 1))).not.toThrow();
  });

  it("rejects exactly at validUntil — the window is exclusive at its end", () => {
    install();
    expect(() => resolve(new Date(UNTIL))).toThrow(/policy window expired/);
  });

  it("rejects after validUntil", () => {
    install();
    const after = new Date(Date.parse(UNTIL) + 86_400_000);
    expect(() => resolve(after)).toThrow(/policy window expired/);
  });

  // The reason the comparisons are written as "prove it is inside the window".
  // Date.parse("nonsense") is NaN, and NaN fails every comparison — so with
  // `t < from` / `t >= until` both gates are false and the route settles with no
  // time check at all. Fail-open, on precisely the input you cannot trust.
  it.each([
    ["validFrom", { validFrom: "not a date" }],
    ["validUntil", { validUntil: "2026-13-45T99:99:99Z" }],
    ["both", { validFrom: "", validUntil: "" }],
  ])("fails closed when %s is malformed", (_label, overrides) => {
    install(overrides as Partial<SplitterRouteDeployment>);
    const middle = new Date((Date.parse(FROM) + Date.parse(UNTIL)) / 2);
    expect(() => resolve(middle)).toThrow(SplitterRouteNotSettlingError);
    expect(() => resolve(middle)).toThrow(/policy window is unreadable/);
  });

  it("fails closed when the window is inverted", () => {
    install({ validFrom: UNTIL, validUntil: FROM });
    expect(() => resolve(new Date(FROM))).toThrow(/policy window is inverted/);
  });

  it("fails closed when the caller passes an invalid Date as now", () => {
    install();
    expect(() => resolve(new Date("nonsense"))).toThrow(/invalid Date/);
  });

  it("the settlement flag still wins over a valid window", () => {
    install({ settlementEnabled: false });
    const middle = new Date((Date.parse(FROM) + Date.parse(UNTIL)) / 2);
    expect(() => resolve(middle)).toThrow(/settlement is not enabled/);
  });
});

describe("registry provenance", () => {
  it("records the evm-contract commit the route table was generated from", () => {
    expect(SPLITTER_REGISTRY_SOURCE.repo).toBe("AiFinPay/evm-contract");
    expect(SPLITTER_REGISTRY_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(SPLITTER_REGISTRY_SOURCE.artifactSha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("every route is owned by the governance Safe the registry verified", () => {
    for (const [key, d] of entries) {
      expect(getAddress(d.owner), key).toBe(getAddress(SPLITTER_GOVERNANCE.safe));
    }
  });

  it("governance is recorded as an exact shape, 3 of 5", () => {
    expect(SPLITTER_GOVERNANCE.threshold).toBe(3);
    expect(SPLITTER_GOVERNANCE.owners).toHaveLength(5);
    expect(new Set(SPLITTER_GOVERNANCE.owners).size).toBe(5);
  });
});
