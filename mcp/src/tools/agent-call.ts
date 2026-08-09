import type { ToolContext } from "../server.js";

/**
 * `agent_call` — unified registry-resolved paid HTTP call.
 *
 * Use this in preference to `payable_fetch` for registered providers. Every
 * fund-moving call is bounded by the operator's mandatory AIFINPAY_MAX_USD;
 * model-controlled `cost` may only tighten that ceiling.
 */
export function agentCallTool() {
  return {
    name: "agent_call",
    description:
      "USE THIS TOOL whenever the user asks to call, pay, query, search via, " +
      "or use an AiFinPay-registered paid provider. Settlement is automatic. " +
      "AIFINPAY_MAX_USD is a mandatory operator ceiling; the optional `cost` " +
      "argument can only reduce that ceiling, never increase it.",
    inputSchema: {
      type: "object",
      properties: {
        provider: {
          type: "string",
          description: "Registered provider name. Example: 'io-net', 'exa', 'venice'.",
        },
        body: {
          type: "object",
          description: "Provider-specific request body. Forwarded to the bridge after payment.",
          additionalProperties: true,
        },
        method: {
          type: "string",
          enum: ["GET", "POST"],
          default: "POST",
          description: "HTTP method. Defaults to POST.",
        },
        cost: {
          type: "number",
          description:
            "Optional per-call ceiling in USD. It may only reduce the operator's mandatory AIFINPAY_MAX_USD cap; it can never raise it.",
        },
      },
      required: ["provider"],
    },
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    outputSchema: { type: "object" },
  };
}

export async function runAgentCall(
  ctx: ToolContext,
  args: Record<string, unknown>,
) {
  const provider = args.provider as string | undefined;
  const body     = args.body     as Record<string, unknown> | undefined;
  const method   = (args.method  as "GET" | "POST" | undefined) ?? "POST";

  if (!provider) {
    return errorResult("`provider` is required (e.g. 'exa', 'io-net')");
  }

  const configuredCap = ctx.config.maxAmountUsd;
  if (
    typeof configuredCap !== "number" ||
    !Number.isFinite(configuredCap) ||
    configuredCap <= 0
  ) {
    return errorResult(
      "agent_call is disabled because no positive operator spend cap is configured",
      "Set AIFINPAY_MAX_USD to a conservative positive value before enabling autonomous payments.",
    );
  }
  const operatorCapUsd: number = configuredCap;

  let requestedCapUsd: number = operatorCapUsd;
  if (args.cost !== undefined) {
    if (typeof args.cost !== "number" || !Number.isFinite(args.cost) || args.cost <= 0) {
      return errorResult("cost must be a positive finite number when provided");
    }
    requestedCapUsd = args.cost;
  }

  const cost: number = Math.min(requestedCapUsd, operatorCapUsd);

  try {
    const resp = await ctx.agent.call({ provider, body, method, cost });
    if (resp === null) {
      return errorResult("Call skipped — budget cap exceeded (on_limit_exceeded='skip').");
    }
    const text = await resp.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep as text */ }

    const meta = resp as unknown as { aifinpayTx?: string; aifinpayChain?: string };
    const txHash = meta.aifinpayTx;
    const txChain = meta.aifinpayChain;
    const txLine = txHash
      ? `Paid on ${txChain ?? "polygon"}. Tx: ${txHash} → https://${txChain === "solana" ? "solscan.io/tx" : "polygonscan.com/tx"}/${txHash}\n\n`
      : "";
    const bodyText = typeof parsed === "string"
      ? parsed
      : JSON.stringify({ status: resp.status, body: parsed }, null, 2);

    return { content: [{ type: "text", text: txLine + bodyText }] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint =
      message.toLowerCase().includes("budget")
        ? "Tip: lower the requested per-call ceiling or increase AIFINPAY_MAX_USD only if the operator explicitly intends to allow larger payments."
        : message.toLowerCase().includes("revert") || message.toLowerCase().includes("insufficient")
          ? `Tip: ensure the EVM address ${ctx.agent.evmAddress} holds enough POL on Polygon for gas + payment.`
          : "Provider may be misconfigured. Check https://aifinpay.io/api/providers.";
    return errorResult(`agent_call failed: ${message}`, hint);
  }
}

function errorResult(...lines: string[]) {
  return {
    isError: true,
    content: lines.map((line) => ({ type: "text", text: line })),
  };
}
