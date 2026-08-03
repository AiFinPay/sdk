import type { ToolContext } from "../server.js";

export function agentAddressTool() {
  return {
    name: "agent_address",
    description:
      "Return the agent's on-chain identity. " +
      "Fund the Polygon or Solana address to enable payments via " +
      "payable_fetch / agent_call. Polygon (EVM) — for io.net, Exa, Venice " +
      "and other bridges advertising Polygon settlement. Solana (base58) — " +
      "for the leaderboard / Seat PDA and Solana-native bridges. Casper — " +
      "identity only for now: the address is derived from the same seed and " +
      "can be funded, but this SDK cannot yet sign Casper deploys, so it is " +
      "not a settlement rail here. One seed, three addresses.",
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
        // Declared because the handler returns it. A field present in the
        // payload but absent from the schema is how a client silently drops
        // it — the address would be derived, returned, and never shown.
        casper: {
          type: "string",
          description:
            "Casper account hash. Identity only: derived from the same seed " +
            "and fundable, but this SDK cannot sign Casper deploys yet.",
        },
        note:   { type: "string" },
      },
      // `casper` is deliberately not required: an agent built from a raw EVM
      // key has no seed to derive it from, and claiming it always exists
      // would make that case look like a bug rather than a limitation.
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
    // Casper was absent here while the project counted it among its live
    // networks, so an agent could not be told its own address on a chain we
    // advertise. Same seed as the other two; the account hash is what a Casper
    // explorer expects.
    casper: ctx.agent.casperAddress,
    note:
      "Polygon (EVM) is the default settlement chain for live bridges " +
      "(io.net, Exa, Venice). Solana is supported via Seat PDA payments. " +
      "Casper has a deployed settlement contract and the SDK derives the " +
      "address, but does not yet sign Casper deploys. " +
      "One seed derives all three — funding any enables that chain.",
  };
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}
