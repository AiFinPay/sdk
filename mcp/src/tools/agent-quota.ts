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
import {
  isSolanaPublicKey,
  solanaHistorySelection,
  assertSolanaReadContext,
  assertSolanaQuota,
} from "../payment-identity.js";

const DEFAULT_BASE = "https://api.aifinpay.io";

export function agentQuotaTool() {
  return {
    name: "agent_quota",
    description:
      "Read this agent's prepaid quota, per service. Lists the " +
      "agent's active quota batches (merchant, resource, used, remaining, " +
      "expiry). Read-only; never spends, pays, or signs anything. Ask it " +
      "things like: how much prepaid quota do I have left at mrch_x?",
    inputSchema: {
      type: "object",
      properties: {
        merchant_id: {
          type: "string",
          description: "Optional mrch_… filter — only batches bought from this service.",
        },
        include_exhausted: {
          type: "boolean",
          default: false,
          description: "Also list batches with 0 remaining (still retained, not yet expired).",
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
  unit_quota?: number;
  used?: number;
  remaining?: number;
  amount?: string | number;
  currency?: string;
  exp?: number;
  chain?: string;
}

export async function runAgentQuota(ctx: ToolContext, args: Record<string, unknown>) {
  const base = (ctx.config.baseUrl ?? DEFAULT_BASE).replace(/\/+$/, "");
  const solana = ctx.config.payChain === "solana";
  const address = solana ? ctx.agent.solanaAddress : ctx.agent.evmAddress;
  const merchantFilter = typeof args.merchant_id === "string" && args.merchant_id ? args.merchant_id : null;
  const includeExhausted = args.include_exhausted === true;

  let resp: Response;
  let solanaSelection: ReturnType<typeof solanaHistorySelection> | undefined;
  try {
    let query = "";
    if (solana) {
      if (!isSolanaPublicKey(address)) throw new Error("Expected a canonical 32-byte Solana address");
      solanaSelection = solanaHistorySelection(ctx.config);
      query = `?${new URLSearchParams({ chain: "solana", network: solanaSelection.network, program: solanaSelection.program })}`;
    }
    resp = await ctx.agent.inner.fetchImpl(`${base}/v1/agents/${address}/receipts${query}`, {
      method: "GET",
    });
  } catch (e) {
    const err = e as Error;
    return errorResult(`could not reach ${base}: ${err.message}`);
  }
  if (!resp.ok) {
    return errorResult(`quota lookup failed: HTTP ${resp.status}`);
  }

  let body: { receipts?: WireReceipt[] };
  try {
    body = (await resp.json()) as { receipts?: WireReceipt[] };
    if (solanaSelection) {
      assertSolanaReadContext(body, address, solanaSelection, "address");
      if (!Array.isArray(body.receipts)) throw new Error("Invalid Solana quota response");
      for (const row of body.receipts) {
        assertSolanaReadContext(row, address, solanaSelection, "payer");
        assertSolanaQuota(row);
      }
    }
  } catch {
    return errorResult("Quota metadata is unavailable or does not match the selected wallet/network/program");
  }

  const now = Math.floor(Date.now() / 1000);
  // A site that meters itself tells only the agent what is left; take the lower count.
  const siteCount = solanaSelection ? new Map<string, number>() : localRemaining(ctx);

  let batches = (body.receipts ?? [])
    .filter((r) => r.exp == null || r.exp > now)
    .filter((r) => (merchantFilter ? r.merchant_id === merchantFilter : true))
    .map((r) => {
      const recorded = r.remaining ?? 0;
      const site = r.receipt_id !== undefined ? siteCount.get(r.receipt_id) : undefined;
      const lower = site !== undefined && site < recorded;
      const remaining = lower ? site : recorded;
      const quota = solanaSelection ? r.unit_quota! : (r.quota ?? 1);
      return {
        merchant_id: r.merchant_id,
        resource: r.resource,
        scope: r.scope ?? "exact",
        tier: r.tier,
        used: lower ? Math.max(r.used ?? 0, (r.unit_quota ?? quota) - remaining) : (r.used ?? 0),
        remaining,
        ...(lower ? { counted_by: "site" as const } : {}),
        quota,
        paid: r.amount != null ? `${r.amount} ${r.currency ?? "USD"}` : undefined,
        expires: r.exp != null ? new Date(r.exp * 1000).toISOString() : undefined,
        receipt_id: r.receipt_id,
      };
    })
    .filter((b) => includeExhausted || b.remaining > 0);

  // Most useful first: the batches with the most room to spend.
  batches = batches.sort((a, b) => b.remaining - a.remaining);

  // Roll up per merchant so "how much do I have left at X" is one line even
  // when the agent bought several batches there.
  const perMerchant = new Map<string, { remaining: number; batches: number }>();
  for (const b of batches) {
    const key = b.merchant_id ?? "unknown";
    const cur = perMerchant.get(key) ?? { remaining: 0, batches: 0 };
    cur.remaining += b.remaining;
    if (solanaSelection && !Number.isSafeInteger(cur.remaining))
      return errorResult("Quota total exceeds safe integer range");
    cur.batches += 1;
    perMerchant.set(key, cur);
  }

  const payload = {
    agent: address,
    ...(solanaSelection ? { chain: "solana", ...solanaSelection } : {}),
    ...(solanaSelection ? { unit: "billing_units" } : {}),
    ...(merchantFilter ? { merchant_filter: merchantFilter } : {}),
    totals: Object.fromEntries(perMerchant),
    batches,
    note: solanaSelection
      ? "Solana remaining/used/quota are billing units. The number of callable requests depends on each route's server-defined cost_units. Hosted gateway usage is durable; external merchant metering may lag. An empty result means no retained active quota in this selected wallet/network/program."
      : batches.length === 0
        ? merchantFilter
          ? `no active quota at ${merchantFilter} — a new batch starts when payable_fetch pays that service's 402`
          : "no active quota anywhere — pay a service's 402 to start a batch"
        : "`remaining` is the lower of AiFinPay's record and the count the site itself last reported to this agent (`counted_by: \"site\"`). A site running its own gate counts locally and does not report use to AiFinPay, so AiFinPay's record alone can read higher.",
  };

  return {
    content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

/** What each site last told this agent is left, by receipt id; persisted receipts too, so a restart keeps it. */
function localRemaining(ctx: ToolContext): Map<string, number> {
  const out = new Map<string, number>();
  const note = (id: unknown, remaining: unknown) => {
    if (typeof id !== "string" || typeof remaining !== "number" || !Number.isFinite(remaining) || remaining < 0) return;
    const prior = out.get(id);
    out.set(id, prior === undefined ? remaining : Math.min(prior, remaining));
  };
  try {
    for (const entry of ctx.agent.aifp1Receipts?.list?.() ?? []) note(entry.receiptId, entry.remaining);
  } catch {
    // An unreadable cache leaves AiFinPay's record as the answer.
  }
  try {
    for (const entry of ctx.paymentState?.read().receipts ?? []) note(entry.receiptId, entry.remaining);
  } catch {
    // Same for unreadable payment state.
  }
  return out;
}

function errorResult(...lines: string[]) {
  return {
    isError: true,
    content: [{ type: "text", text: lines.join("\n") }],
  };
}
