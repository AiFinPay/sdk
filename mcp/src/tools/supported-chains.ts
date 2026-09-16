import { V14_DEPLOYMENTS } from "@aifinpay/agent";
import type { ToolContext } from "../server.js";

export function supportedChainsTool() {
  return {
    name: "supported_chains",
    description:
      "List all AiFinPay-supported EVM chains with deployment status, settlement availability, and stablecoin info. " +
      "Optionally filter by environment (prod/dev) or status (enabled/disabled).",
    inputSchema: {
      type: "object",
      properties: {
        environment: {
          type: "string",
          enum: ["prod", "dev"],
          description: "Filter by environment. Omit for all.",
        },
        status: {
          type: "string",
          enum: ["enabled", "disabled"],
          description: "Filter by deployment status. Omit for all.",
        },
        settlementEnabled: {
          type: "boolean",
          description: "Filter by settlement availability. Omit for all.",
        },
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
  };
}

export async function runSupportedChains(_ctx: ToolContext, args: Record<string, unknown>) {
  const environment = args.environment as string | undefined;
  const status = args.status as string | undefined;
  const settlementEnabled = args.settlementEnabled as boolean | undefined;

  let chains = Object.values(V14_DEPLOYMENTS);

  if (environment) {
    chains = chains.filter((d) => d.environment === environment);
  }
  if (status) {
    chains = chains.filter((d) => d.status === status);
  }
  if (settlementEnabled !== undefined) {
    chains = chains.filter((d) => d.settlementEnabled === settlementEnabled);
  }

  const result = chains.map((d) => ({
    network: d.network,
    chainId: d.chainId,
    environment: d.environment,
    status: d.status,
    settlementEnabled: d.settlementEnabled,
    splitterAddress: d.splitter.address,
    assets: d.splitter.assets.map((a) => ({ symbol: a.symbol, address: a.address })),
  }));

  return {
    content: [{ type: "text", text: JSON.stringify(result, null, 2) }],
    structuredContent: { chains: result, count: result.length },
  };
}
