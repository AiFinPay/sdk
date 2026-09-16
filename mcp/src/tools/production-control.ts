import type { ToolContext } from "../server.js";
import { apiUrl } from "../api.js";

const DEFAULT_BASE = "https://aifinpay.io";
const ROUTES = new Set(["AIFP-1", "AIFP-2"]);

const EVM_CHAINS = new Set([
  "polygon",
  "avalanche",
  "arbitrum",
  "bnb",
  "base",
  "unichain",
  "optimism",
  "botchain",
  "robinhood",
  "xrplevm",
]);

const SOLANA_CHAINS = new Set(["solana"]);
const CASPER_CHAINS = new Set(["casper"]);

const ALL_CHAINS = new Set([...EVM_CHAINS, ...SOLANA_CHAINS, ...CASPER_CHAINS]);

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
  const response = await ctx.agent.inner.fetchImpl(apiUrl(base(ctx), path), init);
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const detail = body && typeof body === "object" ? JSON.stringify(body) : `HTTP ${response.status}`;
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
        identifier: {
          type: "string",
          description: "@username, AIFP-#########, or aifp_agent_* id",
        },
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
      "Build and validate a NON-SIGNING v1.3 settlement invoice for EVM chains. This tool never moves funds. " +
      "Use the published @aifinpay/agent v2 settlement executor to verify bytecode/profile and sign it.",
    inputSchema: {
      type: "object",
      properties: {
        route_class: { type: "string", enum: ["AIFP-1", "AIFP-2"] },
        chain: { type: "string", enum: [...EVM_CHAINS] },
        asset: {
          type: "string",
          description: "Native symbol, USDC, or USDT if the route advertises it.",
        },
        gross_amount: { type: "string", description: "Gross payer amount in base units." },
        merchant_wallet: { type: "string", description: "Merchant/provider EVM wallet (0x...)." },
        order_id: { type: "string" },
        valid_until: {
          type: "integer",
          description: "Optional Unix seconds, max 20 minutes ahead.",
        },
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
  if (!EVM_CHAINS.has(chain)) return errorResult("unsupported EVM settlement chain");
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
    return result(
      await api(ctx, "/v1/settlement/invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
  } catch (e) {
    return errorResult(`Settlement invoice failed: ${(e as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Solana settlement
// ─────────────────────────────────────────────────────────────────────────────

const SOLANA_ASSETS = new Set(["SOL", "USDC"]);

export function settlementSolanaTool() {
  return {
    name: "settlement_solana",
    description:
      "Build and validate a NON-SIGNING Solana settlement invoice. This tool never moves funds. " +
      "Uses the AiFinPay Solana B2B split program (Anchor). " +
      "Use the published @aifinpay/agent v2 settlement executor to sign and submit.",
    inputSchema: {
      type: "object",
      properties: {
        route_class: { type: "string", enum: ["AIFP-1", "AIFP-2"] },
        chain: { type: "string", enum: [...SOLANA_CHAINS] },
        asset: {
          type: "string",
          enum: [...SOLANA_ASSETS],
          description: "SOL (native) or USDC (SPL token).",
        },
        gross_amount: { type: "string", description: "Gross payer amount in base units (lamports for SOL, 6 decimals for USDC)." },
        merchant_wallet: {
          type: "string",
          description: "Merchant/provider Solana base58 public key.",
        },
        order_id: { type: "string" },
        valid_until: {
          type: "integer",
          description: "Optional Unix seconds, max 20 minutes ahead.",
        },
      },
      required: ["route_class", "chain", "asset", "gross_amount", "merchant_wallet", "order_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    outputSchema: { type: "object" },
  };
}

export async function runSettlementSolana(ctx: ToolContext, args: Record<string, unknown>) {
  const route = String(args.route_class || "").toUpperCase();
  const chain = String(args.chain || "").toLowerCase();
  if (!ROUTES.has(route)) return errorResult("route_class must be AIFP-1 or AIFP-2");
  if (!SOLANA_CHAINS.has(chain)) return errorResult("unsupported Solana settlement chain");

  const wallet = String(args.merchant_wallet || "");
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(wallet)) {
    return errorResult("merchant_wallet must be a valid Solana base58 public key");
  }

  const asset = String(args.asset || "").toUpperCase();
  if (!SOLANA_ASSETS.has(asset)) {
    return errorResult("asset must be SOL or USDC");
  }

  try {
    const payload = {
      route_class: route,
      chain,
      asset,
      gross_amount: String(args.gross_amount || ""),
      merchant_wallet: wallet,
      order_id: String(args.order_id || ""),
      ...(args.valid_until != null ? { valid_until: Number(args.valid_until) } : {}),
    };
    return result(
      await api(ctx, "/v1/settlement/invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
  } catch (e) {
    return errorResult(`Solana settlement invoice failed: ${(e as Error).message}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Casper settlement
// ─────────────────────────────────────────────────────────────────────────────

const CASPER_ASSETS = new Set(["CSPR"]);

export function settlementCasperTool() {
  return {
    name: "settlement_casper",
    description:
      "Build and validate a NON-SIGNING Casper settlement invoice. This tool never moves funds. " +
      "Casper uses Wasm smart contracts and deploys (not EVM transactions). " +
      "Use the published @aifinpay/agent v2 settlement executor to sign and submit.",
    inputSchema: {
      type: "object",
      properties: {
        route_class: { type: "string", enum: ["AIFP-1", "AIFP-2"] },
        chain: { type: "string", enum: [...CASPER_CHAINS] },
        asset: {
          type: "string",
          enum: [...CASPER_ASSETS],
          description: "CSPR (native Casper token).",
        },
        gross_amount: { type: "string", description: "Gross payer amount in motes (10^-8 CSPR)." },
        merchant_wallet: {
          type: "string",
          description: "Merchant/provider Casper account hex (account-hash-...).",
        },
        order_id: { type: "string" },
        valid_until: {
          type: "integer",
          description: "Optional Unix seconds, max 20 minutes ahead.",
        },
      },
      required: ["route_class", "chain", "asset", "gross_amount", "merchant_wallet", "order_id"],
    },
    annotations: { readOnlyHint: true, openWorldHint: false, destructiveHint: false },
    outputSchema: { type: "object" },
  };
}

export async function runSettlementCasper(ctx: ToolContext, args: Record<string, unknown>) {
  const route = String(args.route_class || "").toUpperCase();
  const chain = String(args.chain || "").toLowerCase();
  if (!ROUTES.has(route)) return errorResult("route_class must be AIFP-1 or AIFP-2");
  if (!CASPER_CHAINS.has(chain)) return errorResult("unsupported Casper settlement chain");

  const wallet = String(args.merchant_wallet || "");
  if (!/^account-hash-[0-9a-f]{64}$/.test(wallet)) {
    return errorResult("merchant_wallet must be a valid Casper account hash (account-hash-...)");
  }

  const asset = String(args.asset || "").toUpperCase();
  if (!CASPER_ASSETS.has(asset)) {
    return errorResult("asset must be CSPR");
  }

  try {
    const payload = {
      route_class: route,
      chain,
      asset,
      gross_amount: String(args.gross_amount || ""),
      merchant_wallet: wallet,
      order_id: String(args.order_id || ""),
      ...(args.valid_until != null ? { valid_until: Number(args.valid_until) } : {}),
    };
    return result(
      await api(ctx, "/v1/settlement/invoice", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(payload),
      })
    );
  } catch (e) {
    return errorResult(`Casper settlement invoice failed: ${(e as Error).message}`);
  }
}
