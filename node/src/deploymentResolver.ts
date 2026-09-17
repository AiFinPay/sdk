/**
 * AIFINP-223 — SDK Environment & Protocol Version resolver (EVM).
 *
 * A single place that answers "which deployment does the SDK use?" so no other
 * module has to reason about environment, protocol version or fallback. Given
 * an environment, a network and a requested version, it returns the concrete
 * deployment to settle against, or throws a typed error explaining why it
 * cannot.
 *
 * Two axes:
 *   environment — "dev" | "prod". Development supports Amoy only and uses the
 *     v1.4 artifacts sourced from evm-contract's dev branch. Production uses the
 *     configured production networks.
 *   version     — "v1.2" | "v1.4" | "auto". "auto" uses an enabled v1.4
 *     deployment for the exact environment+network and otherwise falls back
 *     to a valid legacy v1.2 deployment. An explicit version never changes.
 *
 * Addresses live in data files (v14Deployments.generated.ts and the legacy
 * SPLITTER_DEPLOYMENTS table), never inline here — this module is selection
 * logic only, so a payout address can never be changed by editing control flow.
 */
import { SPLITTER_DEPLOYMENTS, type SplitterChainName, type SplitterDeployment } from "./unifiedAgent.js";
import { V14_DEPLOYMENTS, V14_DEV_NETWORKS, type V14Deployment } from "./generated/v14Deployments.generated.js";

export type SdkEnvironment = "dev" | "prod";

/** Selectable protocol versions. This is the request-side selector; the exact
 *  on-chain contract version of a resolved v1.2 deployment is in its payload
 *  (`SplitterDeployment.version`, which is "1.1" or "1.2" depending on chain). */
export type ProtocolVersion = "v1.2" | "v1.4";

/** What a caller may ask for. "auto" (the default) prefers enabled v1.4 and
 *  falls back to a valid production v1.2 deployment. */
export type RequestedVersion = ProtocolVersion | "auto";

export interface ResolveDeploymentOptions {
  environment: SdkEnvironment;
  /** Network name, e.g. "polygon" or "amoy". Case-insensitive. */
  network: string;
  /** Defaults to "auto". */
  version?: RequestedVersion;
}

/** The resolved deployment. Discriminated by `version` so the caller gets the
 *  correctly-shaped payload: the v1.4 role/tokenList/profiles record, or the
 *  legacy single-splitter record. */
export type ResolvedDeployment =
  | {
      version: "v1.4";
      environment: SdkEnvironment;
      network: string;
      chainId: number;
      deployment: V14Deployment;
    }
  | {
      version: "v1.2";
      environment: SdkEnvironment;
      network: string;
      chainId: number;
      deployment: SplitterDeployment;
    };

// ── Errors ──────────────────────────────────────────────────────────────────

export class DeploymentResolverError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DeploymentResolverError";
  }
}

/** The development environment was asked for a network other than the ones it
 *  supports (Amoy only). */
export class UnsupportedDevNetworkError extends DeploymentResolverError {
  readonly network: string;
  constructor(network: string) {
    super(
      `Development environment supports ${V14_DEV_NETWORKS.join(", ")} only; ` +
        `"${network}" is not a supported development network. Use environment ` +
        `"prod" for production networks.`
    );
    this.name = "UnsupportedDevNetworkError";
    this.network = network;
  }
}

/** An explicit version was requested but no deployment of it exists for this
 *  environment+network. Thrown rather than downgrading, so an explicit choice
 *  is never silently changed. */
export class VersionUnavailableError extends DeploymentResolverError {
  readonly requested: ProtocolVersion;
  constructor(requested: ProtocolVersion, environment: SdkEnvironment, network: string) {
    super(
      `${requested} is not deployed for ${environment}/${network}. It was ` +
        `requested explicitly, so the SDK will not substitute another version.`
    );
    this.name = "VersionUnavailableError";
    this.requested = requested;
  }
}

/** A deployment record exists, but is quarantined and must not receive money. */
export class DeploymentDisabledError extends DeploymentResolverError {
  readonly environment: SdkEnvironment;
  readonly network: string;
  readonly reason: string;

  constructor(environment: SdkEnvironment, network: string, reason: string) {
    super(`v1.4 settlement is disabled for ${environment}/${network}: ${reason}`);
    this.name = "DeploymentDisabledError";
    this.environment = environment;
    this.network = network;
    this.reason = reason;
  }
}

/** No usable deployment of either supported version exists here. */
export class NoDeploymentError extends DeploymentResolverError {
  constructor(environment: SdkEnvironment, network: string) {
    super(`No enabled v1.4 or valid v1.2 deployment is known for ` + `${environment}/${network}.`);
    this.name = "NoDeploymentError";
  }
}

// ── Lookups ──────────────────────────────────────────────────────────────────

function normalize(network: string): string {
  return network.trim().toLowerCase();
}

/** The v1.4 deployment for this environment+network, or undefined. A v1.4
 *  record is only valid for the environment it was deployed under: the Amoy
 *  deployment is dev-only and must never resolve under "prod". */
function findV14(environment: SdkEnvironment, network: string): V14Deployment | undefined {
  const entry = V14_DEPLOYMENTS[network];
  if (!entry) return undefined;
  return entry.environment === environment ? entry : undefined;
}

/** The legacy (v1.1/v1.2) deployment for this network, or undefined. These are
 *  all production mainnet deployments, so they are only offered under "prod". */
function findV12(environment: SdkEnvironment, network: string): SplitterDeployment | undefined {
  if (environment !== "prod") return undefined;
  return (SPLITTER_DEPLOYMENTS as Partial<Record<string, SplitterDeployment>>)[network];
}

/** Is a v1.4 deployment available for this environment+network? */
export function isV14Available(environment: SdkEnvironment, network: string): boolean {
  return findV14(environment, normalize(network))?.settlementEnabled === true;
}

// ── The resolver ─────────────────────────────────────────────────────────────

/**
 * Resolve the deployment the SDK should use. The single source of truth for
 * environment + protocol-version selection.
 *
 * @throws UnsupportedDevNetworkError  dev asked for a non-Amoy network
 * @throws VersionUnavailableError     an explicit version is not deployed here
 * @throws DeploymentDisabledError     explicit v1.4 is quarantined, or auto
 *                                     has no valid v1.2 fallback
 * @throws NoDeploymentError           neither version is known here
 */
export function resolveDeployment(options: ResolveDeploymentOptions): ResolvedDeployment {
  const { environment } = options;
  if (environment !== "dev" && environment !== "prod") {
    throw new DeploymentResolverError(`Unknown environment "${String(environment)}"; use "dev" or "prod".`);
  }

  const network = normalize(options.network);
  const requested: RequestedVersion = options.version ?? "auto";

  // Development is restricted to Amoy, whatever version is asked for. Reject
  // any other development network with a clear error rather than silently
  // resolving a production deployment.
  if (environment === "dev" && !V14_DEV_NETWORKS.includes(network as never)) {
    throw new UnsupportedDevNetworkError(options.network);
  }

  const v14 = findV14(environment, network);
  const v12 = findV12(environment, network);

  const asV14 = (d: V14Deployment): ResolvedDeployment => ({
    version: "v1.4",
    environment,
    network,
    chainId: d.chainId,
    deployment: d,
  });
  const asV12 = (d: SplitterDeployment): ResolvedDeployment => ({
    version: "v1.2",
    environment,
    network,
    chainId: d.chainId,
    deployment: d,
  });
  const enabledV14 = (): V14Deployment => {
    if (!v14) throw new NoDeploymentError(environment, options.network);
    if (!v14.settlementEnabled) {
      throw new DeploymentDisabledError(
        environment,
        network,
        v14.disabledReason ?? "deployment has not passed the settlement gate"
      );
    }
    return v14;
  };

  switch (requested) {
    case "v1.4":
      if (!v14) throw new VersionUnavailableError("v1.4", environment, options.network);
      return asV14(enabledV14());
    case "v1.2":
      if (v12) return asV12(v12);
      throw new VersionUnavailableError("v1.2", environment, options.network);
    case "auto":
      if (v14?.settlementEnabled) return asV14(v14);
      if (v12) return asV12(v12);
      if (v14) {
        throw new DeploymentDisabledError(
          environment,
          network,
          v14.disabledReason ?? "deployment has not passed the settlement gate"
        );
      }
      throw new NoDeploymentError(environment, options.network);
    default:
      throw new DeploymentResolverError(`Unknown version "${String(requested)}"; use "v1.2", "v1.4" or "auto".`);
  }
}
