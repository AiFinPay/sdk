/**
 * x402 discovery — the file an agent reads to learn a site takes payments
 * *before* it hits a 402.
 *
 * A partner asked, reasonably, "how does the agent even know?" The answer is
 * two-layered: the 402 itself carries `how_to_pay`, so an agent that just tries
 * learns everything from the response. But an agent that discovers politely,
 * before spending a request on a paywalled path, looks for a well-known file.
 * That file is a standard, and a merchant should not have to hand-write it —
 * the gate already knows every resource it protects, so it can serve it.
 *
 * Mount once, next to the gates:
 *
 *   app.use(aifpDiscovery({
 *     merchantId,
 *     apiBase,                 // where /v1/quote lives, default api.aifinpay.io
 *     resources: [
 *       { resource: "/api/agent/genres", tier: "standard" },
 *       { resource: "/api/agent/*",      tier: "standard", scope: "prefix" },
 *     ],
 *   }));
 *
 * Serves GET /.well-known/x402.json. Everything else falls through — and an
 * HTML page among it leaves with a `Link` header pointing at /llms.txt and at
 * this document, so an agent that lands on the home page finds both.
 */
import type { Request, Response, NextFunction, RequestHandler } from "express";
import type { Tier } from "./types.js";
import { unitPriceUsd } from "./pricing.js";
import { discoveryLinkHeader, isHtmlContentType, type DiscoveryLinkSetting } from "./discovery-link.js";

export interface DiscoveryResource {
  resource: string;
  tier?: Tier;
  /** How a receipt for this resource is scoped. Mirrors the 402's `scope`. */
  scope?: "exact" | "prefix" | "merchant";
  /** Optional human label for the catalog. */
  name?: string;
}

export interface DiscoveryOptions {
  merchantId: string;
  resources: DiscoveryResource[];
  /** Where settlement is negotiated. Default https://api.aifinpay.io */
  apiBase?: string;
  /** Override the served path. Default "/.well-known/x402.json". */
  path?: string;
  /** The `Link` header this middleware adds to every HTML response it lets
   *  through (see discovery-link.ts). On by default, pointing at `/llms.txt`
   *  and at `path`; `false` switches it off. */
  discoveryLink?: DiscoveryLinkSetting;
}

/** The x402 discovery document. Shape follows the x402 well-known convention:
 *  who to pay, what it costs, and where to settle — as data, not prose. */
export function buildDiscoveryDocument(opts: DiscoveryOptions): object {
  const api = (opts.apiBase ?? "https://api.aifinpay.io").replace(/\/+$/, "");
  return {
    x402_version: 1,
    protocol: "AIFP-1",
    merchant_id: opts.merchantId,
    // Where an agent negotiates and settles. The 402 says the same, so the two
    // can never point an agent at different places.
    quote_endpoint: `${api}/v1/quote`,
    pay_endpoint: `${api}/v1/pay`,
    // How an agent with no wallet gets one — the single most useful line for a
    // first-time agent, and the reason the 402 carries it too.
    onboarding: "npx @aifinpay/mcp init",
    documentation_url: "https://github.com/AiFinPay/sdk/blob/main/AGENT-FLOW.md",
    instructions_url: "https://raw.githubusercontent.com/AiFinPay/skill/main/agent/skills/aifinpay/SKILL.md",
    merchant_instructions_url:
      "https://raw.githubusercontent.com/AiFinPay/skill/main/agent/skills/aifinpay-merchant/SKILL.md",
    resources: opts.resources.map((r) => ({
      resource: r.resource,
      ...(r.name ? { name: r.name } : {}),
      tier: r.tier ?? "standard",
      scope: r.scope ?? "exact",
      unit_price_usd: unitPriceUsd(r.tier ?? "standard"),
    })),
    // Terms are per-quote, not fixed here: price is stated, but chain and asset
    // come from /v1/quote because they depend on the merchant's payout config,
    // which this static file cannot know without going stale.
    settlement_terms_from: `${api}/v1/quote`,
  };
}

const linkedResponses = new WeakSet<Response>();

/**
 * Add the discovery `Link` to `res` if, and only if, it turns out to be an
 * HTML page. The content type is known only when the headers go out, so the
 * check runs in `writeHead`, which `res.send`, `res.sendFile` and a bare
 * `res.end` all reach. Idempotent per response: the gate and the discovery
 * middleware can both be mounted without sending the header twice.
 */
export function linkHtmlResponse(res: Response, value: string | null): void {
  if (!value || linkedResponses.has(res)) return;
  linkedResponses.add(res);
  const writeHead = res.writeHead;
  res.writeHead = function (this: Response, ...args: unknown[]) {
    const inline = args.find((a): a is Record<string, unknown> => !!a && typeof a === "object" && !Array.isArray(a));
    const inlineType = inline && Object.entries(inline).find(([k]) => k.toLowerCase() === "content-type")?.[1];
    if (isHtmlContentType(String(this.getHeader("content-type") ?? inlineType ?? ""))) {
      const existing = this.getHeader("link");
      const current = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
      if (!current.some((v) => v.includes(value))) this.setHeader("link", [...current, value]);
    }
    return (writeHead as (...a: unknown[]) => Response).apply(this, args);
  } as Response["writeHead"];
}

export function aifpDiscovery(opts: DiscoveryOptions): RequestHandler {
  const path = opts.path ?? "/.well-known/x402.json";
  const doc = buildDiscoveryDocument(opts);
  const body = JSON.stringify(doc);
  const link = discoveryLinkHeader(opts.discoveryLink === false ? false : { x402: path, ...opts.discoveryLink });
  return function aifpDiscoveryHandler(req: Request, res: Response, next: NextFunction): void {
    if (req.method !== "GET" || req.path !== path) {
      linkHtmlResponse(res, link);
      return next();
    }
    res.set("content-type", "application/json");
    // Safe to cache: the document changes only when the merchant changes what it
    // gates, which is a redeploy, not a request.
    res.set("cache-control", "public, max-age=300");
    res.status(200).send(body);
  };
}
