// AIFINP-223 — environment & protocol-version resolver. Static-shape tests,
// no network calls. Every address the resolver returns was read from chain by
// the v1.4 deploy scripts / verify-registry.mjs in evm-contract; here we only
// assert the SELECTION logic (which version, which environment, which errors).
import { describe, expect, it } from "vitest";
import {
  resolveDeployment,
  isV14Available,
  UnsupportedDevNetworkError,
  VersionUnavailableError,
  DeploymentDisabledError,
  NoDeploymentError,
  DeploymentResolverError,
  SPLITTER_DEPLOYMENTS,
  resolveSplitterRoute,
  type ResolvedDeployment,
} from "../src/index.js";

describe("resolveDeployment — environment switch", () => {
  it("dev supports amoy", () => {
    const r = resolveDeployment({ environment: "dev", network: "amoy" });
    expect(r.environment).toBe("dev");
    expect(r.chainId).toBe(80002);
  });

  it("dev rejects a non-amoy network with a typed error", () => {
    expect(() => resolveDeployment({ environment: "dev", network: "polygon" })).toThrow(UnsupportedDevNetworkError);
    expect(() => resolveDeployment({ environment: "dev", network: "base" })).toThrow(UnsupportedDevNetworkError);
  });

  it("prod resolves an explicitly requested legacy production network", () => {
    const r = resolveDeployment({
      environment: "prod",
      network: "polygon",
      version: "v1.2",
    });
    expect(r.environment).toBe("prod");
    expect(r.chainId).toBe(137);
  });

  it("rejects an unknown environment", () => {
    expect(() =>
      // @ts-expect-error deliberately invalid
      resolveDeployment({ environment: "staging", network: "polygon" })
    ).toThrow(DeploymentResolverError);
  });

  it("does not leak the dev-only amoy deployment into prod", () => {
    // amoy is a dev deployment; asking for it under prod must not resolve it.
    expect(() =>
      resolveDeployment({
        environment: "prod",
        network: "amoy",
        version: "v1.4",
      })
    ).toThrow(VersionUnavailableError);
  });
});

describe("resolveDeployment — explicit version selection", () => {
  it("explicit v1.4 returns v1.4 on all prod networks (all enabled)", () => {
    const prodNetworks = ["optimism", "bnb", "unichain", "polygon", "robinhood", "base", "arbitrum", "avalanche", "xrplevm"];
    for (const network of prodNetworks) {
      const r = resolveDeployment({ environment: "prod", network, version: "v1.4" });
      expect(r.version).toBe("v1.4");
      if (r.version === "v1.4") {
        expect(r.deployment.splitterVersion).toBe("1.4");
        expect(r.deployment.settlementEnabled).toBe(true);
        expect(r.deployment.status).toBe("enabled");
      }
    }
  });

  it("explicit v1.2 returns the legacy deployment (polygon)", () => {
    const r = resolveDeployment({
      environment: "prod",
      network: "polygon",
      version: "v1.2",
    });
    expect(r.version).toBe("v1.2");
    if (r.version === "v1.2") {
      expect(r.deployment.splitter).toBe(SPLITTER_DEPLOYMENTS.polygon.splitter);
    }
  });

  it("explicit v1.2 always uses v1.2 even where v1.4 exists", () => {
    const r = resolveDeployment({
      environment: "prod",
      network: "polygon",
      version: "v1.2",
    });
    expect(r.version).toBe("v1.2");
  });

  it("explicit v1.4 returns v1.4 on dev network (amoy)", () => {
    const r = resolveDeployment({ environment: "dev", network: "amoy", version: "v1.4" });
    expect(r.version).toBe("v1.4");
    if (r.version === "v1.4") {
      expect(r.deployment.splitterVersion).toBe("1.4");
    }
  });

  it("explicit v1.4 throws when no v1.4 deployment exists (botchain)", () => {
    expect(() =>
      resolveDeployment({ environment: "prod", network: "botchain", version: "v1.4" })
    ).toThrow(VersionUnavailableError);
  });

  it("explicit v1.4 does NOT silently downgrade — it throws when unavailable", () => {
    // botchain has a v1.2 deployment but no v1.4 (no production deployment
    // in evm-contract).
    expect(() =>
      resolveDeployment({
        environment: "prod",
        network: "botchain",
        version: "v1.4",
      })
    ).toThrow(VersionUnavailableError);
  });

  it("explicit v1.2 on amoy throws (no legacy deployment on the dev network)", () => {
    expect(() =>
      resolveDeployment({
        environment: "dev",
        network: "amoy",
        version: "v1.2",
      })
    ).toThrow(VersionUnavailableError);
  });
});

describe("resolveDeployment — automatic version selection", () => {
  it("auto uses v1.4 on all prod networks (all enabled)", () => {
    const prodNetworks = ["optimism", "bnb", "unichain", "polygon", "robinhood", "base", "arbitrum", "avalanche", "xrplevm"];
    for (const network of prodNetworks) {
      const r = resolveDeployment({ environment: "prod", network });
      expect(r.version).toBe("v1.4");
      if (r.version === "v1.4") {
        expect(r.deployment.settlementEnabled).toBe(true);
      }
    }
  });

  it("auto falls back to v1.2 when v1.4 is unavailable (botchain)", () => {
    const r = resolveDeployment({ environment: "prod", network: "botchain" });
    expect(r.version).toBe("v1.2");
    if (r.version === "v1.2") {
      expect(r.deployment.splitter).toBe(SPLITTER_DEPLOYMENTS.botchain.splitter);
    }
  });

  it("auto uses v1.4 on the dev network (amoy)", () => {
    const r = resolveDeployment({ environment: "dev", network: "amoy" });
    expect(r.version).toBe("v1.4");
  });

  it("auto is the default when no version is given", () => {
    const withAuto = resolveDeployment({
      environment: "prod",
      network: "botchain",
      version: "auto",
    });
    const noVersion = resolveDeployment({ environment: "prod", network: "botchain" });
    expect(noVersion.version).toBe("v1.2");
    expect(noVersion.version).toBe(withAuto.version);
  });

  it("auto throws when neither version exists for the network", () => {
    expect(() => resolveDeployment({ environment: "prod", network: "does-not-exist" })).toThrow(NoDeploymentError);
  });
});

describe("isV14Available", () => {
  it("means settlement-enabled, not merely present in the registry", () => {
    for (const network of ["arbitrum", "avalanche", "base", "bnb", "unichain", "xrplevm", "robinhood", "polygon", "optimism"]) {
      expect(isV14Available("prod", network)).toBe(true); // all prod networks are enabled
    }
    expect(isV14Available("dev", "amoy")).toBe(true); // dev is enabled
    expect(isV14Available("prod", "botchain")).toBe(false); // no v1.4 deployment
    expect(isV14Available("prod", "amoy")).toBe(false); // amoy is dev-only
    expect(isV14Available("dev", "polygon")).toBe(false);
  });
});

describe("resolveDeployment — input handling", () => {
  it("is case-insensitive on the network name", () => {
    const r = resolveDeployment({
      environment: "prod",
      network: "PoLyGoN",
      version: "v1.2",
    });
    expect(r.chainId).toBe(137);
    expect(r.network).toBe("polygon");
  });

  it("returns a discriminated union whose payload matches its version", () => {
    const results: ResolvedDeployment[] = [
      resolveDeployment({
        environment: "dev",
        network: "amoy",
        version: "v1.4",
      }),
      resolveDeployment({
        environment: "prod",
        network: "base",
        version: "v1.2",
      }),
    ];
    for (const r of results) {
      if (r.version === "v1.4") expect(r.deployment.splitterVersion).toBe("1.4");
      else expect(["1.1", "1.2"]).toContain(r.deployment.version);
    }
  });
});

describe("backward compatibility", () => {
  it("existing legacy exports are untouched", () => {
    // The resolver is additive: the old direct table and route resolver must
    // keep working for existing integrations.
    expect(SPLITTER_DEPLOYMENTS.polygon.chainId).toBe(137);
    const route = resolveSplitterRoute("polygon", "merchant-aifp1");
    expect(route.chainId).toBe(137);
    expect(route.treasuryBps).toBe(100);
  });
});
