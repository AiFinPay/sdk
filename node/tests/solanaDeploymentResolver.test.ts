// AIFINP-224 — Solana environment & protocol-version resolver. Static-shape
// tests, no network calls. Every program id the resolver returns was read from
// the solana-contract deploy logs/IDL; here we only assert the SELECTION logic
// (which version, which environment, which errors), and the Solana-specific
// "no v1.2 fallback" behaviour that distinguishes it from the EVM resolver.
import { describe, expect, it } from "vitest";
import {
  resolveSolanaDeployment,
  isSolanaV14Available,
  UnsupportedSolanaDevNetworkError,
  SolanaVersionUnavailableError,
  SolanaV12UnavailableError,
  NoSolanaDeploymentError,
  DeploymentResolverError,
  SOLANA_V14_DEPLOYMENTS,
  SOLANA_DEV_NETWORKS,
  type ResolvedSolanaDeployment,
} from "../src/index.js";

const DEVNET_PROGRAM = "Dg9v95m6ofTwaU9V69PNAyRaKeELwxrne4THUYuUTeon";
const MAINNET_PROGRAM = "8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y";

describe("resolveSolanaDeployment — environment switch", () => {
  it("dev supports devnet", () => {
    const r = resolveSolanaDeployment({ environment: "dev", network: "devnet" });
    expect(r.environment).toBe("dev");
    expect(r.network).toBe("devnet");
    expect(r.programId).toBe(DEVNET_PROGRAM);
  });

  it("prod resolves mainnet", () => {
    const r = resolveSolanaDeployment({ environment: "prod", network: "mainnet" });
    expect(r.environment).toBe("prod");
    expect(r.network).toBe("mainnet");
    expect(r.programId).toBe(MAINNET_PROGRAM);
  });

  it("accepts mainnet-beta as an alias for mainnet", () => {
    const r = resolveSolanaDeployment({ environment: "prod", network: "mainnet-beta" });
    expect(r.network).toBe("mainnet");
    expect(r.programId).toBe(MAINNET_PROGRAM);
  });

  it("dev rejects a non-devnet cluster with a typed error", () => {
    expect(() =>
      resolveSolanaDeployment({ environment: "dev", network: "mainnet" }),
    ).toThrow(UnsupportedSolanaDevNetworkError);
  });

  it("rejects an unknown environment", () => {
    expect(() =>
      // @ts-expect-error — deliberately invalid environment
      resolveSolanaDeployment({ environment: "staging", network: "devnet" }),
    ).toThrow(DeploymentResolverError);
  });

  it("does not leak the dev-only devnet deployment into prod", () => {
    // devnet is a dev deployment; asking for it under prod must not resolve it.
    expect(() =>
      resolveSolanaDeployment({ environment: "prod", network: "devnet" }),
    ).toThrow(NoSolanaDeploymentError);
  });

  it("does not leak the prod-only mainnet deployment into dev", () => {
    // mainnet under dev is rejected as an unsupported dev cluster.
    expect(() =>
      resolveSolanaDeployment({ environment: "dev", network: "mainnet" }),
    ).toThrow(UnsupportedSolanaDevNetworkError);
  });
});

describe("resolveSolanaDeployment — explicit version selection", () => {
  it("explicit v1.4 returns v1.4 where deployed (mainnet)", () => {
    const r = resolveSolanaDeployment({
      environment: "prod",
      network: "mainnet",
      version: "v1.4",
    });
    expect(r.version).toBe("v1.4");
    expect(r.programId).toBe(MAINNET_PROGRAM);
    expect(r.deployment.idl.version).toBe("1.4.1");
  });

  it("explicit v1.4 does NOT silently downgrade — it throws when unavailable", () => {
    // prod/devnet has no v1.4 (devnet is a dev deployment), so explicit v1.4 throws.
    expect(() =>
      resolveSolanaDeployment({ environment: "prod", network: "devnet", version: "v1.4" }),
    ).toThrow(SolanaVersionUnavailableError);
  });

  it("explicit v1.2 always throws — Solana has no v1.2 deployment", () => {
    expect(() =>
      resolveSolanaDeployment({ environment: "prod", network: "mainnet", version: "v1.2" }),
    ).toThrow(SolanaV12UnavailableError);
    expect(() =>
      resolveSolanaDeployment({ environment: "dev", network: "devnet", version: "v1.2" }),
    ).toThrow(SolanaV12UnavailableError);
  });
});

describe("resolveSolanaDeployment — automatic version selection", () => {
  it("auto uses v1.4 on mainnet", () => {
    const r = resolveSolanaDeployment({ environment: "prod", network: "mainnet", version: "auto" });
    expect(r.version).toBe("v1.4");
    expect(r.programId).toBe(MAINNET_PROGRAM);
  });

  it("auto uses v1.4 on the dev cluster (devnet)", () => {
    const r = resolveSolanaDeployment({ environment: "dev", network: "devnet", version: "auto" });
    expect(r.version).toBe("v1.4");
    expect(r.programId).toBe(DEVNET_PROGRAM);
  });

  it("auto is the default when no version is given", () => {
    const r = resolveSolanaDeployment({ environment: "prod", network: "mainnet" });
    expect(r.version).toBe("v1.4");
  });

  it("auto throws (no fallback) when v1.4 is not deployed for the network", () => {
    // Solana has no v1.2 to fall back to, so auto with no v1.4 is a hard error.
    expect(() =>
      resolveSolanaDeployment({ environment: "prod", network: "devnet" }),
    ).toThrow(NoSolanaDeploymentError);
  });
});

describe("isSolanaV14Available", () => {
  it("is true for mainnet prod and devnet dev, false otherwise", () => {
    expect(isSolanaV14Available("prod", "mainnet")).toBe(true);
    expect(isSolanaV14Available("prod", "mainnet-beta")).toBe(true);
    expect(isSolanaV14Available("dev", "devnet")).toBe(true);
    expect(isSolanaV14Available("prod", "devnet")).toBe(false);
    expect(isSolanaV14Available("dev", "mainnet")).toBe(false);
  });
});

describe("resolveSolanaDeployment — input handling", () => {
  it("is case-insensitive on the cluster name", () => {
    const r = resolveSolanaDeployment({ environment: "prod", network: "MAINNET" });
    expect(r.programId).toBe(MAINNET_PROGRAM);
  });

  it("returns a payload whose program id matches the bundled data", () => {
    const r: ResolvedSolanaDeployment = resolveSolanaDeployment({
      environment: "prod",
      network: "mainnet",
    });
    expect(r.deployment).toBe(SOLANA_V14_DEPLOYMENTS.mainnet);
    expect(r.programId).toBe(SOLANA_V14_DEPLOYMENTS.mainnet!.programId);
  });
});

describe("bundled Solana v1.4 data", () => {
  it("has exactly devnet (dev) and mainnet (prod) entries with 1.4 programs", () => {
    expect(Object.keys(SOLANA_V14_DEPLOYMENTS).sort()).toEqual(["devnet", "mainnet"]);
    for (const [key, d] of Object.entries(SOLANA_V14_DEPLOYMENTS)) {
      expect(d.network).toBe(key);
      expect(d.splitterVersion).toBe("1.4");
      expect(d.programId.length).toBeGreaterThan(30);
    }
    expect(SOLANA_DEV_NETWORKS).toEqual(["devnet"]);
  });
});
