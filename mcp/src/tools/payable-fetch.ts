import type { ToolContext } from "../server.js";

export function payableFetchTool() {
  return {
    name: "payable_fetch",
    description:
      "Fetch a public HTTPS URL that may return HTTP 402 and pay it using the " +
      "agent wallet. AIFINPAY_MAX_USD is a mandatory operator ceiling; optional " +
      "max_amount_usd can only reduce that ceiling, never increase it. Prefer " +
      "agent_call for AiFinPay-registered providers.",
    inputSchema: {
      type: "object",
      properties: {
        url: { type: "string", description: "Target public HTTPS URL." },
        method: {
          type: "string",
          enum: ["GET", "POST", "PUT", "PATCH", "DELETE"],
          default: "GET",
        },
        body: {
          type: "string",
          description: "Request body (string). Set Content-Type via headers if non-JSON.",
        },
        headers: {
          type: "object",
          additionalProperties: { type: "string" },
          description: "Extra request headers.",
        },
        max_amount_usd: {
          type: "number",
          description:
            "Optional per-call ceiling. It may only reduce the operator's mandatory AIFINPAY_MAX_USD cap; it can never raise it.",
        },
        facilitator: {
          type: "string",
          description: "Force a supported facilitator. Default 'auto'.",
        },
      },
      required: ["url"],
    },
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

  const configuredCap = ctx.config.maxAmountUsd;
  if (
    typeof configuredCap !== "number" ||
    !Number.isFinite(configuredCap) ||
    configuredCap <= 0
  ) {
    return errorResult(
      "payable_fetch is disabled because no positive operator spend cap is configured",
      "Set AIFINPAY_MAX_USD to a conservative positive value before enabling autonomous payments.",
    );
  }
  const operatorCapUsd: number = configuredCap;

  let requestedCapUsd: number = operatorCapUsd;
  if (args.max_amount_usd !== undefined) {
    if (
      typeof args.max_amount_usd !== "number" ||
      !Number.isFinite(args.max_amount_usd) ||
      args.max_amount_usd <= 0
    ) {
      return errorResult("max_amount_usd must be a positive finite number when provided");
    }
    requestedCapUsd = args.max_amount_usd;
  }

  const maxAmountUsd: number = Math.min(requestedCapUsd, operatorCapUsd);

  try {
    const resp = await ctx.agent.inner.pay(url, {
      method,
      body,
      headers,
      options: {
        maxAmountUsd,
        facilitator: typeof args.facilitator === "string"
          ? args.facilitator
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
            { status: resp.status, ok: resp.ok, headers: respHeaders, body: text },
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
      `Tip: ensure agent ${ctx.agent.solanaAddress} has enough funds, or use agent_call for a registered provider.`,
    );
  }
}

function errorResult(...lines: string[]) {
  return {
    isError: true,
    content: lines.map((line) => ({ type: "text", text: line })),
  };
}
