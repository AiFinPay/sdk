import type { ToolContext } from "../server.js";

export function agentAddressTool() {
  return {
    name: "agent_address",
    description:
      "Return the agent's on-chain identity on both Solana and Polygon. " +
      "Fund EITHER address to enable payments via payable_fetch / agent_call. " +
      "Polygon (EVM) address — for io.net, Exa, Venice and other bridges " +
      "advertising Polygon settlement. Solana (base58) address — for the " +
      "leaderboard / Seat PDA and Solana-native bridges. One agent, two chains.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    // OpenAI Apps SDK requires impact hints on every tool (omitting = validation error).
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    outputSchema: {
      type: "object",
      properties: {
        solana: { type: "string", description: "Solana base58 address" },
        evm:    { type: "string", description: "Polygon/EVM address" },
        note:   { type: "string" },
      },
      required: ["solana", "evm"],
    },
  };
}

export async function runAgentAddress(
  ctx: ToolContext,
  _args: Record<string, unknown>,
) {
  const payload = {
    solana: ctx.agent.solanaAddress,
    evm:    ctx.agent.evmAddress,
    note:
      "Polygon (EVM) is the default settlement chain for live bridges " +
      "(io.net, Exa, Venice). Solana is supported via Seat PDA payments. " +
      "Same seed derives both — funding either enables the corresponding chain.",
  };
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}
