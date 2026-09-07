import type { ToolContext } from "../server.js";

export function devPaymentQuoteTool() {
  return { name: "dev_payment_quote",
    description: "Inspect the dev paid-content challenge and quote a prepaid batch on Amoy. Checks the requested contract version against the deployed quote. Never signs or broadcasts; a version mismatch is an error, not permission to relabel a contract.",
    inputSchema: { type: "object", additionalProperties: false, properties: {
      contract_version: { type: "string", enum: ["1.2", "1.4"] },
      units: { type: "integer", minimum: 1, default: 1000 },
    }, required: ["contract_version"] },
    annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
  };
}

export async function runDevPaymentQuote(ctx: ToolContext, args: Record<string, unknown>) {
  const fail = (text: string) => ({ isError: true, content: [{ type: "text", text }] });
  const version = args.contract_version, units = args.units ?? 1000;
  if (version !== "1.2" && version !== "1.4") return fail("Choose contract_version 1.2 or 1.4");
  if (!Number.isSafeInteger(units) || Number(units) < 1) return fail("units must be a positive integer");
  if (!ctx.config.devMode || !ctx.config.baseUrl) return fail("Configure AIFINPAY_MODE=dev and AIFINPAY_BASE_URL explicitly");
  try {
    const base = ctx.config.baseUrl.replace(/\/+$/, "");
    if (["aifinpay.io", "api.aifinpay.io", "gateway.aifinpay.io"].includes(new URL(base).hostname)) {
      return fail("Dev quotes require a separate dev backend URL");
    }
    const fetchImpl = ctx.agent.inner.fetchImpl;
    const resource = "/v1/dev/paid/data";
    const response = await fetchImpl(`${base}${resource}`);
    if (response.status !== 402) return fail(`Dev paid route must return 402; received HTTP ${response.status}`);
    const challenge = await response.json() as any;
    if (!challenge?.merchant_id || !challenge.accepted_chains?.includes("amoy")) return fail("Dev route has no configured Amoy settlement");
    const quoted = await fetchImpl(`${base}/v1/quote`, { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ merchant_id: challenge.merchant_id, resource, scope: "exact", tier: "standard", units,
        payer: ctx.agent.evmAddress }) });
    if (!quoted.ok) return fail(`Dev quote failed: HTTP ${quoted.status}`);
    const quote = await quoted.json() as any;
    if (quote.network_mode !== "test" || quote.merchant_id !== challenge.merchant_id ||
        quote.resource !== resource || quote.accepted_chains?.length !== 1 || quote.accepted_chains[0] !== "amoy") {
      return fail("Quote is not bound to this test merchant/resource on Amoy");
    }
    if (quote.settlement_call?.splitter_version !== version) return fail(`Requested ${version}; backend advertises ${quote.settlement_call?.splitter_version ?? "no verified version"}. Configure the corresponding dev deployment first.`);
    return { content: [{ type: "text", text: JSON.stringify({ quote, signing_available: false,
      next_step: "Use a separately verified Amoy executor for this exact deployment; current MCP does not broadcast payments. Keep the quote and transaction reference for receipt recovery." }, null, 2) }] };
  } catch { return fail("Dev backend unavailable or returned an invalid response"); }
}
