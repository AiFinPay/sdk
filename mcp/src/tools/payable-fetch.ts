import type { ToolContext } from "../server.js";

export function payableFetchTool() {
  return {
    name: "payable_fetch",
    description:
      "USE THIS TOOL to fetch any URL that may require payment (HTTP 402). " +
      "DO NOT use WebFetch for URLs that might be paid endpoints — WebFetch " +
      "cannot sign x402 payment headers and will only see the 402 challenge " +
      "without being able to settle it. " +
      "Natural-language triggers: 'fetch <paid URL>', 'pay for <url>', " +
      "'try this URL — it might be paid', 'pay the 402 and get the response'. " +
      "The agent automatically detects the x402 facilitator flavor (AiFinPay " +
      "or Coinbase x402), signs a payment from the agent's wallet, retries, " +
      "and returns the response status, headers, and body. For known " +
      "AiFinPay-registered providers (exa, io-net, venice, ...), prefer " +
      "`agent_call` instead — it's higher-level and resolves the bridge URL " +
      "from the registry.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target URL (https)." },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          default: "GET",
        },
        body: {
          type: "string",
          description:
            "Request body (string). Set Content-Type via headers if non-JSON.",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Extra request headers.",
        },
        max_amount_usd: {
          type: "number",
          description:
            "Refuse to pay if the facilitator wants more than this. " +
            "Defaults to AIFINPAY_MAX_USD env or no cap.",
        },
        facilitator: {
          type: "string",
          description:
            "Force a facilitator: 'aifinpay' | 'coinbase-x402'. Default 'auto'.",
        },
      },
      required: ["url"],
    },
    // Auto-pays a 402 challenge for an arbitrary URL → write + open-world + irreversible.
    annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: true },
    outputSchema: { type: "object" },
  };
}

export async function runPayableFetch(
  ctx: ToolContext,
  args: Record<string, unknown>,
) {
  const url = String(args.url ?? "");
  if (!url) return errorResult("missing required arg: url");
  const method = String(args.method ?? "GET").toUpperCase();
  const body = args.body ? String(args.body) : undefined;
  const headers =
    typeof args.headers === "object" && args.headers !== null
      ? (args.headers as Record<string, string>)
      : undefined;

  const maxAmountUsd =
    typeof args.max_amount_usd === "number"
      ? args.max_amount_usd
      : ctx.config.maxAmountUsd;

  try {
    // Legacy URL-keyed path lives on the wrapped Solana-side Agent. For
    // registry-resolved Polygon-native calls prefer the `agent_call` tool.
    const resp = await ctx.agent.inner.pay(url, {
      method,
      body,
      headers,
      options: {
        maxAmountUsd,
        facilitator: typeof args.facilitator === "string"
          ? (args.facilitator as string)
          : undefined,
      },
    });

    const respHeaders: Record<string, string> = {};
    resp.headers.forEach((v, k) => (respHeaders[k] = v));
    const text = await resp.text();

    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(
            {
              status: resp.status,
              ok: resp.ok,
              headers: respHeaders,
              body: text,
            },
            null,
            2,
          ),
        },
      ],
    };
  } catch (e) {
    const err = e as Error;
    return errorResult(
      `${err.constructor.name}: ${err.message}`,
      `Tip: ensure agent ${ctx.agent.solanaAddress} has a funded Seat PDA, ` +
        `or use the unified \`agent_call\` tool (Polygon settlement). ` +
        `Docs: https://aifinpay.io/docs`,
    );
  }
}

function errorResult(...lines: string[]) {
  return {
    isError: true,
    content: lines.map((line) => ({ type: "text", text: line })),
  };
}
