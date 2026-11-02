import type { SdkEnvironment } from "./deploymentResolver.js";
import { DeploymentResolverError } from "./deploymentErrors.js";
import { APTOS_V14_DEPLOYMENTS, type AptosV14Deployment } from "./generated/aptosV14Deployments.generated.js";
import { NEAR_V14_DEPLOYMENTS, type NearV14Deployment } from "./generated/nearV14Deployments.generated.js";

export type AccountChainFamily = "aptos" | "near";
export type AccountRequestedVersion = "v1.4" | "auto";

export interface ResolveAccountDeploymentOptions {
  environment: SdkEnvironment;
  /** Explicit mainnet/testnet selection. Case-insensitive; no network default. */
  network: string;
  version?: AccountRequestedVersion;
}

export class AccountDeploymentResolverError extends DeploymentResolverError {
  constructor(
    public readonly family: AccountChainFamily,
    public readonly code:
      "invalid_selection" | "version_unavailable" | "deployment_unavailable" | "deployment_disabled",
    message: string
  ) {
    super(`${family}: ${message}`);
    this.name = "AccountDeploymentResolverError";
  }
}

function inventory<T extends AptosV14Deployment | NearV14Deployment>(
  family: AccountChainFamily,
  table: Readonly<Record<"mainnet" | "testnet", T | undefined>>,
  options: ResolveAccountDeploymentOptions
): T {
  if (options.environment !== "dev" && options.environment !== "prod") {
    throw new AccountDeploymentResolverError(family, "invalid_selection", 'Use environment "dev" or "prod".');
  }
  if (typeof options.network !== "string") {
    throw new AccountDeploymentResolverError(family, "invalid_selection", "An explicit network is required.");
  }
  const network = options.network.trim().toLowerCase();
  if (options.version !== undefined && options.version !== "auto" && options.version !== "v1.4") {
    throw new AccountDeploymentResolverError(family, "version_unavailable", "Only v1.4 is known; no fallback exists.");
  }
  if (network !== "mainnet" && network !== "testnet") {
    throw new AccountDeploymentResolverError(family, "invalid_selection", `Unknown network "${options.network}".`);
  }
  const deployment = table[network];
  if (!deployment || deployment.environment !== options.environment) {
    throw new AccountDeploymentResolverError(
      family,
      "deployment_unavailable",
      `No v1.4 deployment for ${options.environment}/${network}.`
    );
  }
  return deployment;
}

function enabled<T extends AptosV14Deployment | NearV14Deployment>(family: AccountChainFamily, deployment: T): T {
  if (deployment.settlementEnabled !== true) {
    throw new AccountDeploymentResolverError(
      family,
      "deployment_disabled",
      `Settlement is disabled in the installed registry for ${deployment.environment}/${deployment.network}.`
    );
  }
  return deployment;
}

/** Read packaged Aptos metadata, including disabled records. Does not verify chain state. */
export function getAptosDeployment(options: ResolveAccountDeploymentOptions): AptosV14Deployment {
  return inventory("aptos", APTOS_V14_DEPLOYMENTS, options);
}

/** Read packaged NEAR metadata, including disabled records. Does not verify chain state. */
export function getNearDeployment(options: ResolveAccountDeploymentOptions): NearV14Deployment {
  return inventory("near", NEAR_V14_DEPLOYMENTS, options);
}

/** Select an enabled Aptos registry record. Not payment authorization or an executor. */
export function resolveAptosDeployment(options: ResolveAccountDeploymentOptions): AptosV14Deployment {
  return enabled("aptos", getAptosDeployment(options));
}

/** Select an enabled NEAR registry record. Not payment authorization or an executor. */
export function resolveNearDeployment(options: ResolveAccountDeploymentOptions): NearV14Deployment {
  return enabled("near", getNearDeployment(options));
}
