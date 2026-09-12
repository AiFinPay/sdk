/*
 * agent_quota — "how many requests do I have left, and where?"
 *
 * The founder's ask, verbatim: an agent's developer should be able to say
 * "скільки в тебе запитів до такого-то сервісу лишилось" in chat and get a
 * real number that then sits in the conversation. The data has existed all
 * along — GET /v1/agents/:address/receipts returns every retained receipt
 * with its used/remaining counters — this tool is the missing last inch
 * between that endpoint and the agent's context window.
 *
 * Read-only by construction: the endpoint it calls strips the receipt JWT
 * server-side (a bearer credential; only the paying agent holds it), so the
 * worst this tool can leak is metadata about spend — which is exactly what it
 * exists to report.
 *
 * `remaining` is authoritative only for merchants METERED BY AiFinPay (the
 * hosted gateway and gates that report back). A merchant running
 * @aifinpay/gate meters locally on their own server, and our copy of their
 * counter can lag. The tool says so per receipt rather than presenting every
 * number with equal confidence.
 */
import type { ToolContext } from "../server.js";

const DEFAULT_BASE = "https://api.aifinpay.io";

export function agentQuotaTool() {
  return {
    name: "agent_quota",
    description:
      "How many prepaid requests this agent has left, per service. Lists the " +
      "agent's active quota batches (merchant, resource, used, remaining, " +
      "expiry). Read-only; never spends, pays, or signs anything. Ask it " +
      "things like: how many calls do I have left at mrch_x?",
    inputSchema: {
      type: "object",
      properties: {
        merchant_id: {
          type: "string",
          description:
            "Optional mrch_… filter — only batches bought from this service.",
        },
        include_exhausted: {
          type: "boolean",
          default: false,
          description:
            "Also list batches with 0 remaining (still retained, not yet expired).",
        },
      },
    },
    // Talks only to the configured AiFinPay backend, never to arbitrary URLs.
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    outputSchema: { type: "object" },
  };
}

interface WireReceipt {
  receipt_id?: string;
  merchant_id?: string;
  resource?: string;
  scope?: string;
  tier?: string;
  quota?: number;
  used?: number;
  remaining?: number;
  amount?: string;
  currency?: string;
  exp?: number;
  chain?: string;
}

export async function runAgentQuota(
  ctx: ToolContext,
  args: Record<string, unknown>,
) {
  const base = (ctx.config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const address = ctx.agent.evmAddress;
  const merchantFilter =
    typeof args.merchant_id === "string" && args.merchant_id ? args.merchant_id : null;
  const includeExhausted = args.include_exhausted === true;

  let resp: Response;
  try {
    resp = await ctx.agent.inner.fetchImpl(
      `${base}/v1/agents/${address}/receipts`,
      { method: "GET" },
    );
  } catch (e) {
    const err = e as Error;
    return errorResult(`could not reach ${base}: ${err.message}`);
  }
  if (!resp.ok) {
    return errorResult(`quota lookup failed: HTTP ${resp.status}`);
  }

  const body = (await resp.json()) as { receipts?: WireReceipt[] };
  const now = Math.floor(Date.now() / 1000);

  let batches = (body.receipts ?? [])
    .filter((r) => r.exp == null || r.exp > now)
    .filter((r) => (merchantFilter ? r.merchant_id === merchantFilter : true))
    .filter((r) => includeExhausted || (r.remaining ?? 0) > 0)
    .map((r) => ({
      merchant_id: r.merchant_id,
      resource: r.resource,
      scope: r.scope ?? "exact",
      tier: r.tier,
      used: r.used ?? 0,
      remaining: r.remaining ?? 0,
      quota: r.quota ?? 1,
      paid: r.amount != null ? `${r.amount} ${r.currency ?? "USD"}` : undefined,
      expires: r.exp != null ? new Date(r.exp * 1000).toISOString() : undefined,
      receipt_id: r.receipt_id,
    }));

  // Most useful first: the batches with the most room to spend.
  batches = batches.sort((a, b) => b.remaining - a.remaining);

  // Roll up per merchant so "how much do I have left at X" is one line even
  // when the agent bought several batches there.
  const perMerchant = new Map<string, { remaining: number; batches: number }>();
  for (const b of batches) {
    const key = b.merchant_id ?? "unknown";
    const cur = perMerchant.get(key) ?? { remaining: 0, batches: 0 };
    cur.remaining += b.remaining;
    cur.batches += 1;
    perMerchant.set(key, cur);
  }

  const payload = {
    agent: address,
    ...(merchantFilter ? { merchant_filter: merchantFilter } : {}),
    totals: Object.fromEntries(perMerchant),
    batches,
    note:
      batches.length === 0
        ? merchantFilter
          ? `no active quota at ${merchantFilter} — a new batch starts with that service's 402 (or agent_quote its URL first)`
          : "no active quota anywhere — pay a service's 402 to start a batch"
        : "`remaining` is authoritative where AiFinPay meters (hosted gateway); a merchant running its own @aifinpay/gate meters locally and our copy can lag behind by their traffic.",
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
  };
}

function errorResult(...lines: string[]) {
  return {
    isError: true,
    content: [{ type: "text", text: lines.join("\n") }],
  };
}
