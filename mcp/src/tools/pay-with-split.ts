import type { ToolContext } from "../server.js";

// NOTE on the chain enum below: pay_with_split and quote_split are
// BACKEND-INVOICE-DRIVEN — they call the operator API
// (POST /api/b2b/pay-with-split, GET /api/b2b/quote-split), which only
// supports "solana" and "polygon" today. Do NOT widen the enum here
// without backend support: the request would just be rejected server-side.
// Direct multi-EVM splitter settlement (Base, Optimism, Unichain,
// BOT Chain, XRPL EVM — native-token path) lives in the SDK's
// AiFinPayAgent.call() (@aifinpay/agent >= 1.3.0) and is not exposed
// through these two tools.

export function payWithSplitTool() {
  return {
    name: "pay_with_split",
    description:
      "Get on-chain instructions for a fee-on-top atomic 3-way payment. " +
      "The merchant receives the FULL quoted price; AiFinPay protocol fee " +
      "(1%) and creator/referral fee (0.01%) are added ON TOP. The agent " +
      "executes the returned instructions with their chain SDK of choice. " +
      "Returns 503 with onboarding message if the splitter is not yet " +
      "deployed on the requested chain.",
    inputSchema: {
      type: "object",
      properties: {
        chain: {
          type: "string",
          enum: ["solana", "polygon"],
          description: "Chain to settle on.",
        },
        merchant_wallet: {
          type: "string",
          description:
            "Recipient — Solana base58 pubkey or Polygon 0x address.",
        },
        merchant_amount: {
          type: "string",
          description:
            "Merchant's quoted price in chain units (lamports for Solana, " +
            "wei for Polygon). Use a string to preserve precision.",
        },
        order_id: {
          type: "string",
          description: "Off-chain reference (max 64 chars).",
        },
        fee_recipient: {
          type: "string",
          description:
            "Optional — receives the IP-creator fee. Omit to route the " +
            "creator slot to AiFinPay treasury.",
        },
      },
      required: ["chain", "merchant_wallet", "merchant_amount", "order_id"],
    },
  };
}

export async function runPayWithSplit(
  ctx: ToolContext,
  args: Record<string, unknown>,
) {
  const chain = args.chain as "solana" | "polygon" | undefined;
  if (chain !== "solana" && chain !== "polygon") {
    return errorResult("chain must be 'solana' or 'polygon'");
  }
  const merchantWallet = String(args.merchant_wallet ?? "");
  const merchantAmount = String(args.merchant_amount ?? "");
  const orderId = String(args.order_id ?? "");
  if (!merchantWallet || !merchantAmount || !orderId) {
    return errorResult(
      "merchant_wallet, merchant_amount, and order_id are all required",
    );
  }
  const feeRecipient =
    typeof args.fee_recipient === "string" && args.fee_recipient
      ? (args.fee_recipient as string)
      : undefined;

  try {
    const invoice = await ctx.agent.inner.payWithSplitInvoice({
      chain,
      merchantWallet,
      merchantAmount,
      orderId,
      feeRecipient,
    });
    return {
      content: [{ type: "text", text: JSON.stringify(invoice, null, 2) }],
    };
  } catch (e) {
    const err = e as Error;
    return errorResult(`${err.constructor.name}: ${err.message}`);
  }
}

export function quoteSplitTool() {
  return {
    name: "quote_split",
    description:
      "Pure-view: compute the fee-on-top breakdown (merchant + treasury + " +
      "creator + total) for a given merchant amount. No payment, no auth. " +
      "Use this BEFORE pay_with_split to decide whether the cost is " +
      "acceptable.",
    inputSchema: {
      type: "object",
      properties: {
        chain: { type: "string", enum: ["solana", "polygon"] },
        merchant_amount: {
          type: "string",
          description:
            "Merchant's quoted price (lamports for Solana, wei for Polygon).",
        },
      },
      required: ["chain", "merchant_amount"],
    },
  };
}

export async function runQuoteSplit(
  ctx: ToolContext,
  args: Record<string, unknown>,
) {
  const chain = args.chain as "solana" | "polygon" | undefined;
  if (chain !== "solana" && chain !== "polygon") {
    return errorResult("chain must be 'solana' or 'polygon'");
  }
  const merchantAmount = String(args.merchant_amount ?? "");
  if (!merchantAmount) return errorResult("merchant_amount required");

  try {
    const quote = await ctx.agent.inner.quoteSplit({ chain, merchantAmount });
    return {
      content: [{ type: "text", text: JSON.stringify(quote, null, 2) }],
    };
  } catch (e) {
    const err = e as Error;
    return errorResult(`${err.constructor.name}: ${err.message}`);
  }
}

function errorResult(...lines: string[]) {
  return {
    isError: true,
    content: lines.map((line) => ({ type: "text", text: line })),
  };
}
