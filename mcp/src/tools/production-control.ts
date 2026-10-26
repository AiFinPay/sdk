import { PAYMENT_CHAINS, V14_DEPLOYMENTS, type Aifp1V14Chain } from "@aifinpay/agent";
import type { ToolContext } from "../server.js";
import { apiUrl } from "../api.js";
import { PAY_CHAINS } from "../pay-chains.js";

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
      "Where an agent can pay today. Lists the splitter v1.4 AIFP-1 routes payable_fetch uses first — one per chain the backend serves (read from the issuer's /api/health and /.well-known/x402.json, pinned against the SDK's deployment registry) with chain_id, assets, quote_endpoint and pay_endpoint — then the legacy splitter v1.3 routes from GET /v1/settlement/routes under legacy_v13. " +
      '"live": true means payable now through payable_fetch on that chain; a v1.3 entry being disabled says nothing about v1.4. ' +
      "AIFP-1 is merchant monetisation (99% merchant / 1% AiFinPay / 0% creator). AIFP-2/x402 is 100% provider / 0% AiFinPay / 0% creator.",
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

/** Chain names the discovery documents may use for a served chain. */
function servedAliases(chain: string): string[] {
  return [chain, `${chain}-mainnet`];
}

/** Every key and string value in a JSON document, lower-cased, to a bounded depth. */
function stringsIn(value: unknown, out: Set<string>, depth = 0): Set<string> {
  if (depth > 8) return out;
  if (typeof value === "string") out.add(value.trim().toLowerCase());
  else if (Array.isArray(value)) for (const entry of value) stringsIn(entry, out, depth + 1);
  else if (value && typeof value === "object")
    for (const [key, entry] of Object.entries(value)) {
      out.add(key.trim().toLowerCase());
      stringsIn(entry, out, depth + 1);
    }
  return out;
}

/**
 * Which v1.4 chains the backend serves, from its own discovery documents.
 *
 * The 2026-10-19 agent test read GET /v1/settlement/routes, which describes only
 * splitter v1.3, saw every route disabled and concluded Polygon was off. The
 * v1.4 path (/v1/quote → /v1/pay) is published on the issuer's health and
 * x402 documents instead, so that is what decides "live" here. Returns null
 * when neither document names a known chain, so a document the server cannot
 * read or does not understand is reported as unknown, never as "not served".
 */
async function servedV14Chains(ctx: ToolContext): Promise<{ chains: Set<string> | null; sources: string[] }> {
  const found = new Set<string>();
  const sources: string[] = [];
  for (const path of ["/api/health", "/.well-known/x402.json"]) {
    const url = apiUrl(base(ctx), path);
    try {
      const response = await ctx.agent.inner.fetchImpl(url);
      const body = response.ok ? await response.json() : null;
      if (body === null) {
        sources.push(`${url}: HTTP ${response.status}`);
        continue;
      }
      const strings = stringsIn(body, new Set<string>());
      for (const chain of Object.keys(PAY_CHAINS))
        if (servedAliases(chain).some((alias) => strings.has(alias))) found.add(chain);
      sources.push(`${url}: read`);
    } catch (e) {
      sources.push(`${url}: ${(e as Error).message}`);
    }
  }
  return { chains: found.size ? found : null, sources };
}

export async function runSettlementRoutes(ctx: ToolContext, args: Record<string, unknown>) {
  const route = args.route_class == null ? "" : String(args.route_class).toUpperCase();
  if (route && !ROUTES.has(route)) return errorResult("route_class must be AIFP-1 or AIFP-2");
  const served = await servedV14Chains(ctx);
  // payable_fetch quotes and pays at the API origin, not the site origin.
  const apiBase = (ctx.config.baseUrl ?? "https://api.aifinpay.io").replace(/\/+$/, "");
  const v14 =
    route === "AIFP-2"
      ? []
      : (Object.keys(PAY_CHAINS) as Aifp1V14Chain[])
          .map((name) => {
            const chain = PAY_CHAINS[name];
            const deployment = V14_DEPLOYMENTS[name];
            const enabled = deployment?.environment === "prod" && deployment.settlementEnabled === true;
            const servedNow = served.chains ? served.chains.has(name) : "unknown";
            return {
              route_class: "AIFP-1",
              chain: name,
              chain_id: deployment?.chainId ?? PAYMENT_CHAINS[name].chainId,
              label: chain.label,
              assets: [
                ...(chain.stablecoinOnly ? [] : [chain.native]),
                ...(deployment?.splitter.assets.map((asset) => asset.symbol) ?? []),
              ],
              splitter_version: "1.4",
              splitter: deployment?.splitter.address,
              deployment_enabled: enabled,
              served_by_backend: servedNow,
              live: enabled && servedNow !== false,
              quote_endpoint: `${apiBase}/v1/quote`,
              pay_endpoint: `${apiBase}/v1/pay`,
              pay_with: "payable_fetch",
            };
          })
          // Served chains first, Polygon (the default pay chain) ahead of the rest.
          .sort(
            (a, b) => Number(b.live) - Number(a.live) || Number(a.chain !== "polygon") - Number(b.chain !== "polygon")
          );
  let legacy: unknown;
  try {
    legacy = await api(ctx, `/v1/settlement/routes${route ? `?route_class=${encodeURIComponent(route)}` : ""}`);
  } catch (e) {
    legacy = { error: `Settlement route lookup failed: ${(e as Error).message}` };
  }
  return result({
    v14: {
      note: "Splitter v1.4 AIFP-1 routes: what payable_fetch pays with (402 → /v1/quote → signed transaction → /v1/pay → receipt). live:true is payable now on that chain; the owner selects it with AIFINPAY_PAY_CHAIN (polygon by default).",
      served_from: served.sources,
      routes: v14,
    },
    legacy_v13: {
      note: "Splitter v1.3 routes from GET /v1/settlement/routes. Not used by payable_fetch; a disabled v1.3 route does not mean the chain cannot be paid on v1.4.",
      ...(legacy && typeof legacy === "object" ? (legacy as Record<string, unknown>) : { body: legacy }),
    },
  });
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
        gross_amount: {
          type: "string",
          description: "Gross payer amount in base units (lamports for SOL, 6 decimals for USDC).",
        },
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
