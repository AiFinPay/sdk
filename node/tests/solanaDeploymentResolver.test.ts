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
  SolanaDeploymentDisabledError,
  NoSolanaDeploymentError,
  DeploymentResolverError,
  SOLANA_V14_DEPLOYMENTS,
  SOLANA_DEV_NETWORKS,
} from "../src/index.js";

const DEVNET_PROGRAM = "8dty5bD738Z9TzEkDu8vLSnhpJNWtEGMUEcYaKCUTY6y";
const MAINNET_PROGRAM = "724Ut31i4ecY4dJ25z8HuZetu3A43xtNkPdk4JdbsfdD";

// @aifinpay/deployments 2.1.0 enables both records (founder decision ADR-007).
// A record the registry disables must still refuse; withDisabled() proves it.
function withDisabled(network: "devnet" | "mainnet", run: () => void) {
  const original = SOLANA_V14_DEPLOYMENTS[network];
  SOLANA_V14_DEPLOYMENTS[network] = {
    ...original,
    status: "disabled",
    settlementEnabled: false,
    disabledReason: "test quarantine",
  };
  try {
    run();
  } finally {
    SOLANA_V14_DEPLOYMENTS[network] = original;
  }
}

describe("resolveSolanaDeployment — environment switch", () => {
  it("resolves the enabled devnet program under dev", () => {
    expect(resolveSolanaDeployment({ environment: "dev", network: "devnet" })).toMatchObject({
      version: "v1.4",
      environment: "dev",
      network: "devnet",
      programId: DEVNET_PROGRAM,
    });
  });

  it("resolves the enabled mainnet program under prod", () => {
    expect(resolveSolanaDeployment({ environment: "prod", network: "mainnet" })).toMatchObject({
      version: "v1.4",
      environment: "prod",
      network: "mainnet",
      programId: MAINNET_PROGRAM,
    });
  });

  it("accepts mainnet-beta as an alias for mainnet", () => {
    expect(resolveSolanaDeployment({ environment: "prod", network: "mainnet-beta" }).programId).toBe(MAINNET_PROGRAM);
  });

  it("still refuses a record the registry quarantines", () => {
    withDisabled("mainnet", () =>
      expect(() => resolveSolanaDeployment({ environment: "prod", network: "mainnet" })).toThrow(
        SolanaDeploymentDisabledError
      )
    );
    withDisabled("devnet", () =>
      expect(() => resolveSolanaDeployment({ environment: "dev", network: "devnet" })).toThrow(
        SolanaDeploymentDisabledError
      )
    );
  });

  it("dev rejects a non-devnet cluster with a typed error", () => {
    expect(() => resolveSolanaDeployment({ environment: "dev", network: "mainnet" })).toThrow(
      UnsupportedSolanaDevNetworkError
    );
  });

  it("rejects an unknown environment", () => {
    expect(() =>
      // @ts-expect-error — deliberately invalid environment
      resolveSolanaDeployment({ environment: "staging", network: "devnet" })
    ).toThrow(DeploymentResolverError);
  });

  it("does not leak the dev-only devnet deployment into prod", () => {
    // devnet is a dev deployment; asking for it under prod must not resolve it.
    expect(() => resolveSolanaDeployment({ environment: "prod", network: "devnet" })).toThrow(NoSolanaDeploymentError);
  });

  it("does not leak the prod-only mainnet deployment into dev", () => {
    // mainnet under dev is rejected as an unsupported dev cluster.
    expect(() => resolveSolanaDeployment({ environment: "dev", network: "mainnet" })).toThrow(
      UnsupportedSolanaDevNetworkError
    );
  });
});

describe("resolveSolanaDeployment — explicit version selection", () => {
  it("explicit v1.4 resolves mainnet and refuses it once quarantined", () => {
    expect(resolveSolanaDeployment({ environment: "prod", network: "mainnet", version: "v1.4" }).programId).toBe(
      MAINNET_PROGRAM
    );
    withDisabled("mainnet", () =>
      expect(() => resolveSolanaDeployment({ environment: "prod", network: "mainnet", version: "v1.4" })).toThrow(
        SolanaDeploymentDisabledError
      )
    );
  });

  it("explicit v1.4 does NOT silently downgrade — it throws when unavailable", () => {
    // prod/devnet has no v1.4 (devnet is a dev deployment), so explicit v1.4 throws.
    expect(() =>
      resolveSolanaDeployment({
        environment: "prod",
        network: "devnet",
        version: "v1.4",
      })
    ).toThrow(SolanaVersionUnavailableError);
  });

  it("explicit v1.2 always throws — Solana has no v1.2 deployment", () => {
    expect(() =>
      resolveSolanaDeployment({
        environment: "prod",
        network: "mainnet",
        version: "v1.2",
      })
    ).toThrow(SolanaV12UnavailableError);
    expect(() =>
      resolveSolanaDeployment({
        environment: "dev",
        network: "devnet",
        version: "v1.2",
      })
    ).toThrow(SolanaV12UnavailableError);
  });
});

describe("resolveSolanaDeployment — automatic version selection", () => {
  it("auto refuses quarantined mainnet", () => {
    withDisabled("mainnet", () =>
      expect(() => resolveSolanaDeployment({ environment: "prod", network: "mainnet", version: "auto" })).toThrow(
        SolanaDeploymentDisabledError
      )
    );
  });

  it("auto refuses quarantined devnet", () => {
    withDisabled("devnet", () =>
      expect(() => resolveSolanaDeployment({ environment: "dev", network: "devnet", version: "auto" })).toThrow(
        SolanaDeploymentDisabledError
      )
    );
  });

  it("auto is the default when no version is given", () => {
    expect(resolveSolanaDeployment({ environment: "prod", network: "mainnet" }).version).toBe("v1.4");
    withDisabled("mainnet", () =>
      expect(() => resolveSolanaDeployment({ environment: "prod", network: "mainnet" })).toThrow(
        SolanaDeploymentDisabledError
      )
    );
  });

  it("auto throws (no fallback) when v1.4 is not deployed for the network", () => {
    // Solana has no v1.2 to fall back to, so auto with no v1.4 is a hard error.
    expect(() => resolveSolanaDeployment({ environment: "prod", network: "devnet" })).toThrow(NoSolanaDeploymentError);
  });
});

describe("isSolanaV14Available", () => {
  it("is true only for the enabled record in its own environment", () => {
    expect(isSolanaV14Available("prod", "mainnet")).toBe(true);
    expect(isSolanaV14Available("prod", "mainnet-beta")).toBe(true);
    expect(isSolanaV14Available("dev", "devnet")).toBe(true);
    expect(isSolanaV14Available("prod", "devnet")).toBe(false);
    expect(isSolanaV14Available("dev", "mainnet")).toBe(false);
    withDisabled("mainnet", () => expect(isSolanaV14Available("prod", "mainnet")).toBe(false));
  });
});

describe("resolveSolanaDeployment — input handling", () => {
  it("is case-insensitive on the cluster name", () => {
    expect(resolveSolanaDeployment({ environment: "prod", network: "MAINNET" }).programId).toBe(MAINNET_PROGRAM);
  });

  it("exposes program IDs as metadata", () => {
    expect(SOLANA_V14_DEPLOYMENTS.devnet.programId).toBe(DEVNET_PROGRAM);
    expect(SOLANA_V14_DEPLOYMENTS.mainnet.programId).toBe(MAINNET_PROGRAM);
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
