import type { ToolContext } from "../server.js";

const RETIRED_MESSAGE =
  "The legacy /api/b2b split-invoice tools are retired. " +
  "Use the canonical AIFP-1 settlement client: payer total equals the quoted gross amount, " +
  "merchant receives 99%, AiFinPay receives 1%, creator/referral receives 0%. " +
  "AIFP-2/x402 currently charges 0% at the protocol layer. " +
  "Settlement remains fail-closed until the selected chain profile, runtime hash, " +
  "merchant target, asset and paid E2E evidence are verified.";

export function payWithSplitTool() {
  return {
    name: "pay_with_split",
    description:
      "Retired compatibility tool. It never creates an invoice or moves funds. " +
      "Use the canonical AIFP-1 settlement client instead.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", description: "Ignored compatibility field." },
        merchant_wallet: { type: "string", description: "Ignored compatibility field." },
        merchant_amount: { type: "string", description: "Ignored compatibility field." },
        order_id: { type: "string", description: "Ignored compatibility field." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    outputSchema: { type: "object" },
  };
}

export async function runPayWithSplit(
  _ctx: ToolContext,
  _args: Record<string, unknown>,
) {
  return retiredResult();
}

export function quoteSplitTool() {
  return {
    name: "quote_split",
    description:
      "Retired compatibility tool. It does not quote the removed legacy split route. " +
      "Use a canonical AIFP-1 quote.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", description: "Ignored compatibility field." },
        merchant_amount: { type: "string", description: "Ignored compatibility field." },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    outputSchema: { type: "object" },
  };
}

export async function runQuoteSplit(
  _ctx: ToolContext,
  _args: Record<string, unknown>,
) {
  return retiredResult();
}

function retiredResult() {
  return {
    isError: true,
    content: [{ type: "text", text: RETIRED_MESSAGE }],
    structuredContent: {
      error: "legacy_split_route_retired",
      protocol: "AIFP-1",
      economics: {
        fee_mode: "gross-inclusive",
        payer_total_bps: 10_000,
        merchant_bps: 9_900,
        protocol_bps: 100,
        creator_bps: 0,
      },
      aifp2_protocol_fee_bps: 0,
    },
  };
}
