import { detectFacilitator } from "@aifinpay/agent";
import type { ToolContext } from "../server.js";

export function agentQuoteTool() {
  return {
    name: "agent_quote",
    description:
      "Inspect a 402 challenge for a URL WITHOUT paying. Returns the detected " +
      "facilitator flavor and the merchant's quoted amount + fee preview. " +
      "Use before payable_fetch to decide whether the cost is acceptable.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL (https)." },
        method: {
          type: "string",
          enum: ["GET", "POST"],
          default: "GET",
        },
      },
      required: ["url"],
    },
    // Read-only probe, but reaches arbitrary external URLs → openWorldHint true.
    annotations: { readOnlyHint: true, openWorldHint: true, destructiveHint: false },
    outputSchema: { type: "object" },
  };
}

export async function runAgentQuote(
  ctx: ToolContext,
  args: Record<string, unknown>,
) {
  const url = String(args.url ?? "");
  if (!url) return errorResult("missing required arg: url");
  const method = String(args.method ?? "GET").toUpperCase();

  const resp = await ctx.agent.inner.fetchImpl(url, { method });
  if (resp.status !== 402) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: resp.status,
              note:
                resp.status === 200
                  ? "no payment required — you can hit this without paying"
                  : `unexpected status ${resp.status} on initial probe`,
            },
            null,
            2,
          ),
        },
      ],
    };
  }

  try {
    const facilitator = await detectFacilitator(resp);
    let bodyPreview: unknown = null;
    try {
      bodyPreview = await resp.clone().json();
    } catch {
      bodyPreview = (await resp.clone().text()).slice(0, 500);
    }
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              facilitator: facilitator.name,
              status: 402,
              note:
                "fee-on-top engine not yet wired — quote shows merchant terms only. " +
                "AiFinPay fee will be added on top at payment time.",
              merchant_terms: bodyPreview,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (e) {
    const err = e as Error;
    return errorResult(`could not detect facilitator: ${err.message}`);
  }
}

function errorResult(...lines: string[]) {
  return {
    isError: true,
    content: lines.map((line) => ({ type: "text", text: line })),
  };
}
