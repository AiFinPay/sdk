/**
 * AIFINP-224 — SDK Environment & Protocol Version resolver (Solana).
 *
 * The Solana sibling of deploymentResolver.ts (AIFINP-223). Same idea — one
 * place that answers "which deployment does the SDK use?" given an environment,
 * a network and a requested version — shaped for Solana, where a deployment is
 * a base58 program id + IDL rather than an EVM address record.
 *
 * Two axes, mirroring the EVM resolver:
 *   environment — "dev" | "prod". Development supports devnet only; production
 *     uses mainnet-beta. Both read their v1.4 artifacts from solana-contract's
 *     dev branch (bundled in solanaV14Deployments.generated.ts).
 *   version     — "v1.4" | "auto" (and "v1.2" is accepted at the type level for
 *     parity with EVM). An explicit "v1.4" never silently downgrades.
 *
 * FALLBACK DIFFERS FROM EVM — READ THIS. The EVM resolver falls back v1.4 -> v1.2.
 * Solana has NO v1.2-equivalent splitter: the old program was closed and removed
 * from mainnet, and the SDK never bundled it (it reads the Solana program id at
 * runtime from the bridge's pay_solana challenge). So there is nothing to fall
 * back to. Therefore:
 *   - "auto" resolves v1.4 where deployed, and otherwise throws
 *     NoSolanaDeploymentError (no invented downgrade).
 *   - an explicit "v1.2" always throws SolanaV12UnavailableError, because no
 *     Solana v1.2 deployment exists.
 * This is an open product question for Paul: whether the EVM v1.2/v1.4 fallback
 * model should map onto Solana at all. Until a real Solana fallback exists, this
 * resolver refuses to pretend one does.
 *
 * Program ids live in solanaV14Deployments.generated.ts, never inline here —
 * this module is selection logic only.
 */
import { DeploymentResolverError, type SdkEnvironment } from "./deploymentResolver.js";
import {
  SOLANA_DEV_NETWORKS,
  SOLANA_V14_DEPLOYMENTS,
  type SolanaV14Deployment,
} from "./solanaV14Deployments.generated.js";

/** Selectable protocol versions on the request side. "v1.2" exists for parity
 *  with the EVM selector but has no Solana deployment behind it. */
export type SolanaProtocolVersion = "v1.2" | "v1.4";

/** What a caller may ask for. "auto" (the default) resolves v1.4, or throws if
 *  it is not deployed for the environment+network — Solana has no fallback. */
export type SolanaRequestedVersion = SolanaProtocolVersion | "auto";

export interface ResolveSolanaDeploymentOptions {
  environment: SdkEnvironment;
  /** Cluster name: "devnet", or "mainnet"/"mainnet-beta". Case-insensitive. */
  network: string;
  /** Defaults to "auto". */
  version?: SolanaRequestedVersion;
}

/** The resolved Solana deployment. Only v1.4 is ever returned; the field is
 *  kept for symmetry with the EVM resolver's discriminated union. */
export interface ResolvedSolanaDeployment {
  version: "v1.4";
  environment: SdkEnvironment;
  network: "devnet" | "mainnet";
  programId: string;
  deployment: SolanaV14Deployment;
}

// ── Errors (parallel to the EVM resolver, Solana-worded) ─────────────────────

/** The development environment was asked for a cluster other than devnet. */
export class UnsupportedSolanaDevNetworkError extends DeploymentResolverError {
  readonly network: string;
  constructor(network: string) {
    super(
      `Development environment supports ${SOLANA_DEV_NETWORKS.join(", ")} only; ` +
        `"${network}" is not a supported Solana development cluster. Use ` +
        `environment "prod" for mainnet.`,
    );
    this.name = "UnsupportedSolanaDevNetworkError";
    this.network = network;
  }
}

/** Explicit "v1.4" requested but not deployed for this environment+network.
 *  Thrown rather than downgrading. */
export class SolanaVersionUnavailableError extends DeploymentResolverError {
  readonly requested: SolanaProtocolVersion;
  constructor(
    requested: SolanaProtocolVersion,
    environment: SdkEnvironment,
    network: string,
  ) {
    super(
      `Solana ${requested} is not deployed for ${environment}/${network}. It ` +
        `was requested explicitly, so the SDK will not substitute another ` +
        `version.`,
    );
    this.name = "SolanaVersionUnavailableError";
    this.requested = requested;
  }
}

/** Explicit "v1.2" requested — no Solana v1.2 splitter exists at all. Distinct
 *  from SolanaVersionUnavailableError so callers can tell "not on this network"
 *  from "does not exist on Solana". */
export class SolanaV12UnavailableError extends DeploymentResolverError {
  constructor() {
    super(
      `Solana has no v1.2 deployment. The previous Solana program was closed ` +
        `and there is no v1.2-equivalent to fall back to; only v1.4 is available. ` +
        `Use version "v1.4" or "auto".`,
    );
    this.name = "SolanaV12UnavailableError";
  }
}

/** No Solana v1.4 deployment exists for this environment+network, and Solana
 *  has no fallback version. */
export class NoSolanaDeploymentError extends DeploymentResolverError {
  constructor(environment: SdkEnvironment, network: string) {
    super(
      `No Solana v1.4 deployment is known for ${environment}/${network}, and ` +
        `Solana has no fallback version.`,
    );
    this.name = "NoSolanaDeploymentError";
  }
}

// ── Lookups ──────────────────────────────────────────────────────────────────

/** Normalise a cluster name: lower-cased, and "mainnet-beta" -> "mainnet". */
function normalizeNetwork(network: string): string {
  const n = network.trim().toLowerCase();
  return n === "mainnet-beta" ? "mainnet" : n;
}

/** The v1.4 deployment for this environment+network, or undefined. A record is
 *  only valid for the environment it was deployed under: devnet is dev-only and
 *  must never resolve under "prod", and vice versa. */
function findSolanaV14(
  environment: SdkEnvironment,
  network: string,
): SolanaV14Deployment | undefined {
  const entry = SOLANA_V14_DEPLOYMENTS[network];
  if (!entry) return undefined;
  return entry.environment === environment ? entry : undefined;
}

/** Is a Solana v1.4 deployment available for this environment+network? */
export function isSolanaV14Available(
  environment: SdkEnvironment,
  network: string,
): boolean {
  return findSolanaV14(environment, normalizeNetwork(network)) !== undefined;
}

// ── The resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve the Solana deployment the SDK should use. The single source of truth
 * for Solana environment + protocol-version selection.
 *
 * @throws UnsupportedSolanaDevNetworkError  dev asked for a non-devnet cluster
 * @throws SolanaV12UnavailableError         explicit v1.2 (none exists on Solana)
 * @throws SolanaVersionUnavailableError     explicit v1.4 not deployed here
 * @throws NoSolanaDeploymentError           auto, but no v1.4 for this env+network
 */
export function resolveSolanaDeployment(
  options: ResolveSolanaDeploymentOptions,
): ResolvedSolanaDeployment {
  const { environment } = options;
  if (environment !== "dev" && environment !== "prod") {
    throw new DeploymentResolverError(
      `Unknown environment "${String(environment)}"; use "dev" or "prod".`,
    );
  }

  const network = normalizeNetwork(options.network);
  const requested: SolanaRequestedVersion = options.version ?? "auto";

  // Development is restricted to devnet, whatever version is asked for. Reject
  // any other development cluster rather than silently resolving mainnet.
  if (environment === "dev" && !SOLANA_DEV_NETWORKS.includes(network as never)) {
    throw new UnsupportedSolanaDevNetworkError(options.network);
  }

  const v14 = findSolanaV14(environment, network);
  const asV14 = (d: SolanaV14Deployment): ResolvedSolanaDeployment => ({
    version: "v1.4",
    environment,
    network: d.network,
    programId: d.programId,
    deployment: d,
  });

  switch (requested) {
    case "v1.4":
      if (v14) return asV14(v14);
      throw new SolanaVersionUnavailableError("v1.4", environment, options.network);
    case "v1.2":
      // No Solana v1.2 deployment exists — there is nothing to return.
      throw new SolanaV12UnavailableError();
    case "auto":
      if (v14) return asV14(v14);
      throw new NoSolanaDeploymentError(environment, options.network);
    default:
      throw new DeploymentResolverError(
        `Unknown version "${String(requested)}"; use "v1.2", "v1.4" or "auto".`,
      );
  }
}
