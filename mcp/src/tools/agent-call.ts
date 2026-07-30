import type { ToolContext } from "../server.js";

/**
 * `agent_call` — unified registry-resolved paid HTTP call.
 *
 * The agent picks a provider by name ("exa", "io-net", "venice", …),
 * the SDK looks up the bridge URL + price from the public AiFinPay
 * registry, negotiates the 402 challenge, settles on Polygon via
 * B2BSplitter.payMatic, retries with proof, and returns the upstream
 * response body.
 *
 * Use this in preference to `payable_fetch` when you have a registered
 * provider name — it auto-routes price, chain, and bridge URL.
 *
 * Requires the EVM address (from `agent_address`) to be funded with POL
 * on Polygon mainnet (gas + payment), or USDC if the provider quotes in
 * stablecoin.
 */
export function agentCallTool() {
  return {
    name: "agent_call",
    description:
      "USE THIS TOOL whenever the user asks to call, pay, query, search via, " +
      "or use any of these AiFinPay-registered paid providers: 'exa' (neural " +
      "web search), 'io-net' (LLM inference, Llama-3.3-70B), 'venice' (image " +
      "generation), or any other provider listed at " +
      "https://aifinpay.io/api/providers. " +
      "DO NOT use WebSearch or WebFetch for these providers — they are paid " +
      "APIs accessible only through this MCP, and a plain web search will " +
      "return public marketing pages instead of the actual API. " +
      "Natural-language triggers that should invoke this tool: 'call exa for X', " +
      "'search exa', 'pay venice to generate Y', 'use io-net to run inference', " +
      "'query exa', 'ask io-net'. Provider name maps to the `provider` argument. " +
      "Body is the provider-specific request shape (e.g. {messages:[...]} for " +
      "io-net inference, {query:'...'} for exa search). Returns the upstream " +
      "response with the Polygon tx hash + Polygonscan link prepended. " +
      "Settlement is automatic — Polygon mainnet, atomic 99/1 split via B2BSplitter.",
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
          description: "HTTP method. Defaults to POST (matches all current providers).",
        },
        cost: {
          type: "number",
          description: "Optional override of the registry-quoted price (USD). Use to enforce a stricter budget cap.",
        },
      },
      required: ["provider"],
    },
    // Settles a real on-chain payment to an arbitrary registered provider.
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
  const cost     = args.cost     as number | undefined;

  if (!provider) {
    return {
      isError: true,
      content: [{ type: "text", text: "`provider` is required (e.g. 'exa', 'io-net')" }],
    };
  }

  try {
    const resp = await ctx.agent.call({
      provider,
      body,
      method,
      cost,
    });
    if (resp === null) {
      return {
        isError: true,
        content: [{ type: "text", text: "Call skipped — budget cap exceeded (on_limit_exceeded='skip')." }],
      };
    }
    const text = await resp.text();
    let parsed: unknown = text;
    try { parsed = JSON.parse(text); } catch { /* keep as text */ }

    // Pull the @internal settlement metadata attached by AiFinPayAgent.call
    // (see unifiedAgent.ts). Surfacing the tx hash here lets the agent show
    // a clickable explorer link in chat without re-querying the chain.
    const meta = resp as unknown as { aifinpayTx?: string; aifinpayChain?: string };
    const txHash = meta.aifinpayTx;
    const txChain = meta.aifinpayChain;
    const txLine = txHash
      ? `Paid on ${txChain ?? "polygon"}. Tx: ${txHash} → https://${txChain === "solana" ? "solscan.io/tx" : "polygonscan.com/tx"}/${txHash}\n\n`
      : "";

    const bodyText = typeof parsed === "string"
      ? parsed
      : JSON.stringify({ status: resp.status, body: parsed }, null, 2);

    return {
      content: [
        {
          type: "text",
          text: txLine + bodyText,
        },
      ],
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const hint =
      message.toLowerCase().includes("budget")
        ? "Tip: increase the per-call cost cap or use `agent_quote` to preview before paying."
        : message.toLowerCase().includes("revert") || message.toLowerCase().includes("insufficient")
          ? `Tip: ensure the EVM address ${ctx.agent.evmAddress} holds enough POL on Polygon for gas + payment.`
          : `Provider may be misconfigured. Check https://aifinpay.io/api/providers.`;
    return {
      isError: true,
      content: [{ type: "text", text: `agent_call failed: ${message}\n\n${hint}` }],
    };
  }
}
