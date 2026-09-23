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
        evm: {
          type: "string",
          description: "EVM address used across EVM networks (Polygon, Base, Arbitrum, Optimism, BNB, Unichain, Avalanche, Robinhood, etc.)",
        },
        casper: {
          type: "string",
          description:
            "Casper identity derived from the same seed. Read-only in this MCP RC; no payment signing tool is exposed.",
        },
        note: { type: "string" },
        dashboard: { type: "string" },
      },
      required: ["solana", "evm"],
    },
  };
}

export async function runAgentAddress(ctx: ToolContext, _args: Record<string, unknown>) {
  const payload = {
    solana: ctx.agent.solanaAddress,
    evm: ctx.agent.evmAddress,
    casper: ctx.agent.casperAddress,
    note:
      "Payments: payable_fetch pays AIFP-1 on native Polygon v1.4 once the owner enables it " +
      "(AIFINPAY_PAYMENTS_ENABLED=1 with USD limits, a gas cap and exact payable origins). " +
      "Fund the evm address with POL on Polygon.",
    dashboard:
      "Offer the owner a dashboard link: at https://dash.aifinpay.io → My Agents → Claim via MCP " +
      "they get a one-time URL; pass it to agent_claim_self. They then see this agent's balance, " +
      "payments and receipts.",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}
