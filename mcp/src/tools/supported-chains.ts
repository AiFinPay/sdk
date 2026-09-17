import { V14_DEPLOYMENTS, SOLANA_V14_DEPLOYMENTS } from "@aifinpay/agent";
import type { ToolContext } from "../server.js";

/** Casper deployments — static from @aifinpay/deployments registry (not re-exported by agent). */
const CASPER_DEPLOYMENTS = [
  {
    network: "casper-test",
    environment: "testnet",
    status: "live",
    settlementEnabled: true,
    contractPackageHash: "hash-47df409829ddf0612617460293ba591a19b26fa0c06918878204088d3eb9b78a",
    rpcEndpoint: "https://node.testnet.casper.network/rpc",
    explorer: "https://testnet.cspr.live/contract/47df409829ddf0612617460293ba591a19b26fa0c06918878204088d3eb9b78a",
    version: "v2",
  },
  {
    network: "casper",
    environment: "mainnet",
    status: "historical",
    settlementEnabled: false,
    contractHash: "contract-9903a5e3948e799196df54b17270bc6769338ac1cc36c9eb47e113f88d23f019",
    contractPackageHash: "hash-7ad34a204952eef63d5dcf5159fb7d009e85dea4f49cbdf73dde190652dfa375",
    rpcEndpoint: "https://node.casper.network/rpc",
    explorer: "https://cspr.live/contract/9903a5e3948e799196df54b17270bc6769338ac1cc36c9eb47e113f88d23f019",
    version: "v1",
    disabledReason: "v1: pay_agent recorded receipt but did NOT transfer value; separate native transfer required",
  },
] as const;

export function deploymentInfoTool() {
  return {
    name: "deployment_info",
    description:
      "Get AiFinPay deployment details across EVM, Solana, and Casper — addresses, stablecoins, program IDs, and settlement status. " +
      "Filter by ecosystem (evm/solana/casper), environment (prod/dev), or network name.",
    inputSchema: {
      type: "object",
      properties: {
        ecosystem: {
          type: "string",
          enum: ["evm", "solana", "casper"],
          description: "Filter by ecosystem. Omit for all.",
        },
        environment: {
          type: "string",
          enum: ["prod", "dev", "testnet", "mainnet"],
          description: "Filter by environment. Omit for all.",
        },
        network: {
          type: "string",
          description: "Filter by exact network name (e.g. 'optimism', 'mainnet', 'casper-test').",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  };
}

export async function runDeploymentInfo(_ctx: ToolContext, args: Record<string, unknown>) {
  const ecosystem = args.ecosystem as string | undefined;
  const environment = args.environment as string | undefined;
  const network = args.network as string | undefined;

  const result: Record<string, unknown[]> = {};

  // ── EVM ──────────────────────────────────────────────────────────────────
  if (!ecosystem || ecosystem === "evm") {
    let evm = Object.values(V14_DEPLOYMENTS);
    if (environment) evm = evm.filter((d) => d.environment === environment);
    if (network) evm = evm.filter((d) => d.network === network);
    result.evm = evm.map((d) => ({
      network: d.network,
      chainId: d.chainId,
      environment: d.environment,
      status: d.status,
      settlementEnabled: d.settlementEnabled,
      contracts: {
        splitter: d.splitter.address,
        tokenList: d.splitter.tokenList,
        profiles: d.splitter.profiles,
        admin: d.splitter.admin,
        signer: d.splitter.signer,
        pauser: d.splitter.pauser,
        treasury: d.splitter.treasury,
      },
      stablecoins: d.splitter.assets.map((a) => ({
        symbol: a.symbol,
        name: a.name ?? a.symbol,
        address: a.address,
      })),
      safe: { address: d.safe.address, version: d.safe.version, threshold: d.safe.threshold },
    }));
  }

  // ── Solana ───────────────────────────────────────────────────────────────
  if (!ecosystem || ecosystem === "solana") {
    let solana = Object.values(SOLANA_V14_DEPLOYMENTS);
    if (environment) solana = solana.filter((d) => d.environment === environment);
    if (network) solana = solana.filter((d) => d.network === network);
    result.solana = solana.map((d) => ({
      network: d.network,
      environment: d.environment,
      status: d.status,
      settlementEnabled: d.settlementEnabled,
      disabledReason: d.disabledReason,
      programId: d.programId,
      idl: d.idl,
    }));
  }

  // ── Casper ───────────────────────────────────────────────────────────────
  if (!ecosystem || ecosystem === "casper") {
    let casper = [...CASPER_DEPLOYMENTS];
    if (environment) casper = casper.filter((d) => d.environment === environment);
    if (network) casper = casper.filter((d) => d.network === network);
    result.casper = casper.map((d) => ({
      network: d.network,
      environment: d.environment,
      status: d.status,
      settlementEnabled: d.settlementEnabled,
      contractPackageHash: d.contractPackageHash,
      contractHash: "contractHash" in d ? d.contractHash : undefined,
      rpcEndpoint: d.rpcEndpoint,
      explorer: d.explorer,
      version: d.version,
      disabledReason: "disabledReason" in d ? d.disabledReason : undefined,
    }));
  }

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: result,
  };
}
