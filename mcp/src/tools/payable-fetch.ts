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
      "The agent automatically detects the protocol — the AIFP-1 gateway " +
      "(gateway.aifinpay.io) or an x402 facilitator (AiFinPay or Coinbase " +
      "x402) — pays from the agent's wallet, retries, and returns the response " +
      "status, headers, and body. For known " +
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
            "Capped by AIFINPAY_MAX_USD when the operator set one — this value can only lower it, never raise it.",
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

  // The model may NARROW the operator's cap, never widen it.
  //
  // This read `args.max_amount_usd ?? config.maxAmountUsd`, so a tool argument
  // replaced the operator's limit outright: AIFINPAY_MAX_USD=0.10 and a model
  // that asked for max_amount_usd: 1000 got 1000. The cap an operator sets is
  // the one thing in this server they cannot express any other way, and it was
  // the one a prompt could overwrite.
  //
  // Latent rather than exploited — payable_fetch is not registered on the
  // current server — but the file is what SDK 2.0 re-registers, and a spend cap
  // that a caller can raise is not a cap.
  //
  // Math.min in one direction only: unset operator cap means no policy to
  // violate, so a model-supplied value stands on its own.
  const requestedMax =
    typeof args.max_amount_usd === "number" && Number.isFinite(args.max_amount_usd)
      ? args.max_amount_usd
      : undefined;
  const operatorMax = ctx.config.maxAmountUsd;
  const maxAmountUsd =
    operatorMax === undefined ? requestedMax
    : requestedMax === undefined ? operatorMax
    : Math.min(operatorMax, requestedMax);

  const forcedFacilitator =
    typeof args.facilitator === "string" ? (args.facilitator as string) : undefined;

  try {
    // Two payment protocols answer a 402 here, and this tool used to speak only
    // one of them.
    //
    //   AIFP-1 gateway (gateway.aifinpay.io/{slug}/…): quote → settle on-chain →
    //     receipt → retry. Lives on the unified agent as fetchPaid().
    //   x402 facilitators (AiFinPay / Coinbase): the X-PAYMENT header flow, on
    //     the wrapped Solana-side agent as inner.pay().
    //
    // Before this, payable_fetch called inner.pay() only, so an MCP agent
    // pointed at a gateway URL got stuck on the 402 it could not read — the
    // single most common paid surface we run (AIFINP-118 neighbour).
    //
    // Routing, safe by construction: fetchPaid() is documented to return a
    // non-AIFP-1 402 UNTOUCHED and cost nothing, so trying it first can pay an
    // AIFP-1 URL but can never mis-pay an x402 one. Anything it hands back still
    // 402 falls through to the x402 path. A caller who forces a facilitator has
    // stated x402 intent, so skip AIFP-1 entirely for them.
    let resp: Response | null = null;

    if (!forcedFacilitator) {
      resp = await ctx.agent.fetchPaid(url, { method, body, headers });
      if (resp === null) {
        // Budget cap hit with on_limit_exceeded="skip" — do NOT then try to pay
        // the same call via x402; that would defeat the cap the caller set.
        return errorResult(
          "payment skipped: the per-call or daily budget cap was reached " +
            "(on_limit_exceeded is set to skip).",
        );
      }
      if (resp.status === 402) {
        // Not an AIFP-1 gateway 402 — fetchPaid passed it through. Try x402.
        resp = null;
      }
    }

    if (resp === null) {
      resp = await ctx.agent.inner.pay(url, {
        method,
        body,
        headers,
        options: { maxAmountUsd, facilitator: forcedFacilitator },
      });
    }

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
