import type { ToolContext } from "../server.js";

export function agentAddressTool() {
  return {
    name: "agent_address",
    description:
      "Return the agent's currently derived on-chain addresses. " +
      "This tool is read-only and never authorizes or signs a payment. " +
      "Production value movement is available only through the verified SDK v2 settlement executor after trusted deployment pins are released.",
    inputSchema: {
      type: "object",
      properties: {},
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    outputSchema: {
      type: "object",
      properties: {
        solana: { type: "string", description: "Solana base58 address" },
        evm:    { type: "string", description: "EVM address used across EVM networks" },
        casper: {
          type: "string",
          description:
            "Casper identity derived from the same seed. Read-only in this MCP RC; no payment signing tool is exposed.",
        },
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
    casper: ctx.agent.casperAddress,
    note:
      "Read-only address discovery. Payment signing is intentionally absent from this MCP production RC until the final SDK v2 release contains independently trusted deployment pins and paid E2E evidence.",
  };
  return {
    content: [
      { type: "text", text: JSON.stringify(payload, null, 2) },
    ],
    structuredContent: payload,
  };
}
