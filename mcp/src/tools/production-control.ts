import type { ToolContext } from "../server.js";

const DEFAULT_BASE = "https://aifinpay.io";
const ROUTES = new Set(["AIFP-1", "AIFP-2"]);
const CHAINS = new Set([
  "polygon", "avalanche", "arbitrum", "bnb", "base",
  "unichain", "optimism", "botchain", "xrplevm",
]);

function result(value: unknown) {
  return { content: [{ type: "text", text: JSON.stringify(value, null, 2) }] };
}
function errorResult(message: string) {
  return { isError: true, content: [{ type: "text", text: message }] };
}
function base(ctx: ToolContext) {
  return String(ctx.config.baseUrl || DEFAULT_BASE).replace(/\/$/, "");
}
async function api(ctx: ToolContext, path: string, init?: RequestInit) {
  const response = await ctx.agent.inner.fetchImpl(`${base(ctx)}${path}`, init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === "object"
      ? JSON.stringify(body)
      : `HTTP ${response.status}`;
    throw new Error(detail);
  }
  return body;
}

export function agentPassportResolveTool() {
  return {
    name: "agent_passport_resolve",
    description:
      "Resolve an AiFinPay Agent Passport by @username, permanent AIFP number, or immutable agent id. " +
      "Returns verified public wallet bindings only. Resolution never authorizes a payment.",
    inputSchema: {
      type: "object",
      properties: {
        identifier: { type: "string", description: "@username, AIFP-#########, or aifp_agent_* id" },
      },
      required: ["identifier"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    outputSchema: { type: "object" },
  };
}

export async function runAgentPassportResolve(ctx: ToolContext, args: Record<string, unknown>) {
  const identifier = String(args.identifier || "").trim();
  if (!identifier) return errorResult("missing required arg: identifier");
  try {
    const body = await api(ctx, `/api/agent/resolve/${encodeURIComponent(identifier)}`);
    return result(body);
  } catch (e) {
    return errorResult(`Agent Passport resolve failed: ${(e as Error).message}`);
  }
}

export function settlementRoutesTool() {
  return {
    name: "settlement_routes",
    description:
      "Read AiFinPay's currently runtime-verified v1.3 settlement routes. " +
      "AIFP-1 is merchant monetisation (99% merchant / 1% AiFinPay / 0% creator). " +
      "AIFP-2/x402 is 100% provider / 0% AiFinPay / 0% creator.",
    inputSchema: {
      type: "object",
      properties: {
        route_class: { type: "string", enum: ["AIFP-1", "AIFP-2"] },
      },
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    outputSchema: { type: "object" },
  };
}

export async function runSettlementRoutes(ctx: ToolContext, args: Record<string, unknown>) {
  const route = args.route_class == null ? "" : String(args.route_class).toUpperCase();
  if (route && !ROUTES.has(route)) return errorResult("route_class must be AIFP-1 or AIFP-2");
  try {
    return result(await api(ctx, `/v1/settlement/routes${route ? `?route_class=${encodeURIComponent(route)}` : ""}`));
  } catch (e) {
    return errorResult(`Settlement route lookup failed: ${(e as Error).message}`);
  }
}

export function settlementInvoiceTool() {
  return {
    name: "settlement_invoice",
    description:
      "Build and validate a NON-SIGNING v1.3 settlement invoice. This tool never moves funds. " +
      "Use the published @aifinpay/agent v2 settlement executor to verify bytecode/profile and sign it.",
    inputSchema: {
      type: "object",
      properties: {
        route_class: { type: "string", enum: ["AIFP-1", "AIFP-2"] },
        chain: { type: "string", enum: [...CHAINS] },
        asset: { type: "string", description: "Native symbol, USDC, or USDT if the route advertises it." },
        gross_amount: { type: "string", description: "Gross payer amount in base units." },
        merchant_wallet: { type: "string", description: "Merchant/provider EVM wallet." },
        order_id: { type: "string" },
        valid_until: { type: "integer", description: "Optional Unix seconds, max 20 minutes ahead." },
      },
      required: ["route_class", "chain", "asset", "gross_amount", "merchant_wallet", "order_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    outputSchema: { type: "object" },
  };
}

export async function runSettlementInvoice(ctx: ToolContext, args: Record<string, unknown>) {
  const route = String(args.route_class || "").toUpperCase();
  const chain = String(args.chain || "").toLowerCase();
  if (!ROUTES.has(route)) return errorResult("route_class must be AIFP-1 or AIFP-2");
  if (!CHAINS.has(chain)) return errorResult("unsupported EVM settlement chain");
  try {
    const payload = {
      route_class: route,
      chain,
      asset: String(args.asset || "").toUpperCase(),
      gross_amount: String(args.gross_amount || ""),
      merchant_wallet: String(args.merchant_wallet || ""),
      order_id: String(args.order_id || ""),
      ...(args.valid_until != null ? { valid_until: Number(args.valid_until) } : {}),
    };
    return result(await api(ctx, "/v1/settlement/invoice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    }));
  } catch (e) {
    return errorResult(`Settlement invoice failed: ${(e as Error).message}`);
  }
}
