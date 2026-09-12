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
  NoDeploymentError,
  DeploymentResolverError,
  SPLITTER_DEPLOYMENTS,
  resolveSplitterRoute,
  V14_DEPLOYMENTS,
  type ResolvedDeployment,
} from "../src/index.js";

describe("resolveDeployment — environment switch", () => {
  it("dev supports amoy", () => {
    const r = resolveDeployment({ environment: "dev", network: "amoy" });
    expect(r.environment).toBe("dev");
    expect(r.chainId).toBe(80002);
  });

  it("dev rejects a non-amoy network with a typed error", () => {
    expect(() =>
      resolveDeployment({ environment: "dev", network: "polygon" }),
    ).toThrow(UnsupportedDevNetworkError);
    expect(() =>
      resolveDeployment({ environment: "dev", network: "base" }),
    ).toThrow(UnsupportedDevNetworkError);
  });

  it("prod resolves a production network", () => {
    const r = resolveDeployment({ environment: "prod", network: "polygon" });
    expect(r.environment).toBe("prod");
    expect(r.chainId).toBe(137);
  });

  it("rejects an unknown environment", () => {
    expect(() =>
      // @ts-expect-error deliberately invalid
      resolveDeployment({ environment: "staging", network: "polygon" }),
    ).toThrow(DeploymentResolverError);
  });

  it("does not leak the dev-only amoy deployment into prod", () => {
    // amoy is a dev deployment; asking for it under prod must not resolve it.
    expect(() =>
      resolveDeployment({ environment: "prod", network: "amoy", version: "v1.4" }),
    ).toThrow(VersionUnavailableError);
  });
});

describe("resolveDeployment — explicit version selection", () => {
  it("explicit v1.4 returns v1.4 where deployed (polygon)", () => {
    const r = resolveDeployment({
      environment: "prod",
      network: "polygon",
      version: "v1.4",
    });
    expect(r.version).toBe("v1.4");
    if (r.version === "v1.4") {
      expect(r.deployment.splitter.address).toBe(
        V14_DEPLOYMENTS.polygon.splitter.address,
      );
      expect(r.deployment.splitterVersion).toBe("1.4");
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

  it("explicit v1.4 does NOT silently downgrade — it throws when unavailable", () => {
    // base has a v1.2 deployment but no v1.4.
    expect(() =>
      resolveDeployment({
        environment: "prod",
        network: "base",
        version: "v1.4",
      }),
    ).toThrow(VersionUnavailableError);
  });

  it("explicit v1.2 on amoy throws (no legacy deployment on the dev network)", () => {
    expect(() =>
      resolveDeployment({ environment: "dev", network: "amoy", version: "v1.2" }),
    ).toThrow(VersionUnavailableError);
  });
});

describe("resolveDeployment — automatic version selection", () => {
  it("auto uses v1.4 when available (polygon)", () => {
    const r = resolveDeployment({ environment: "prod", network: "polygon" });
    expect(r.version).toBe("v1.4");
  });

  it("auto falls back to v1.2 when v1.4 is unavailable (base)", () => {
    const r = resolveDeployment({ environment: "prod", network: "base" });
    expect(r.version).toBe("v1.2");
  });

  it("auto uses v1.4 on the dev network (amoy)", () => {
    const r = resolveDeployment({ environment: "dev", network: "amoy" });
    expect(r.version).toBe("v1.4");
  });

  it("auto is the default when no version is given", () => {
    const withAuto = resolveDeployment({
      environment: "prod",
      network: "base",
      version: "auto",
    });
    const noVersion = resolveDeployment({ environment: "prod", network: "base" });
    expect(noVersion.version).toBe(withAuto.version);
  });

  it("auto throws when neither version exists for the network", () => {
    expect(() =>
      resolveDeployment({ environment: "prod", network: "does-not-exist" }),
    ).toThrow(NoDeploymentError);
  });

  it("every legacy network without v1.4 falls back to v1.2 under auto", () => {
    for (const network of ["base", "optimism", "unichain", "botchain", "xrplevm"]) {
      const r = resolveDeployment({ environment: "prod", network });
      expect(r.version).toBe("v1.2");
    }
  });
});

describe("isV14Available", () => {
  it("is true for polygon prod and amoy dev, false where undeployed", () => {
    expect(isV14Available("prod", "polygon")).toBe(true);
    expect(isV14Available("dev", "amoy")).toBe(true);
    expect(isV14Available("prod", "base")).toBe(false);
    expect(isV14Available("prod", "amoy")).toBe(false); // amoy is dev-only
    expect(isV14Available("dev", "polygon")).toBe(false);
  });
});

describe("resolveDeployment — input handling", () => {
  it("is case-insensitive on the network name", () => {
    const r = resolveDeployment({ environment: "prod", network: "PoLyGoN" });
    expect(r.chainId).toBe(137);
    expect(r.network).toBe("polygon");
  });

  it("returns a discriminated union whose payload matches its version", () => {
    const results: ResolvedDeployment[] = [
      resolveDeployment({ environment: "prod", network: "polygon", version: "v1.4" }),
      resolveDeployment({ environment: "prod", network: "base", version: "v1.2" }),
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
