import type { GateErrorBody, Tier } from "./types.js";
import { PROTOCOL_FEE_BPS, minRequestsForTier, unitPriceUsd } from "./pricing.js";

/**
 * The 402 body, byte-for-byte what the hosted gateway emits.
 *
 * This is the only documentation an agent gets. It arrives before any
 * relationship exists — no key, no account, no docs page read — so it has to
 * carry the whole purchase path: what this costs, what the smallest batch is,
 * and the four calls that turn a 402 into a 200.
 *
 * Prices are computed locally from the tier. A 402 is the hot path when an
 * agent first shows up, and making it wait on a control-plane round-trip would
 * put our latency in front of the partner's cheapest response. A merchant who
 * has overridden their unit prices can pass `unitPriceUsd`/`minRequests`
 * through from a cached merchant record; otherwise the protocol defaults are
 * correct, because those overrides must equal one of the three fixed settings.
 */
export function buildChallenge(args: {
  merchantId: string;
  resource: string;
  /** Which paths a receipt for this resource opens. Defaults to "exact". */
  scope?: "exact" | "prefix" | "merchant";
  tier: Tier;
  weight: number;
  detail?: string;
  unitPriceUsd?: string;
  minRequests?: number;
  /** Origin that serves /v1/quote and /v1/pay. MUST be absolute: this gate
   *  runs on the PARTNER's host, so a relative "/v1/quote" would point the
   *  agent at the partner's own server, where nothing answers it. (The paths
   *  are relative inside our own backend's gate, which is where they were
   *  copied from — correct there, wrong here.) */
  apiBase?: string;
}): GateErrorBody {
  const { merchantId, resource, tier, weight } = args;
  const api = (args.apiBase ?? "https://api.aifinpay.io").replace(/\/+$/, "");
  return {
    error: "AIFP-402",
    detail:
      args.detail ||
      "Payment Required — prepay a batch of requests and retry with the AIFP-Receipt header",
    protocol: "AIFP-1",
    merchant_id: merchantId,
    resource,
    tier,
    unit_weight: weight,
    unit_price_usd: args.unitPriceUsd ?? unitPriceUsd(tier),
    min_requests: args.minRequests ?? minRequestsForTier(tier),
    // Which paths a receipt bought for THIS resource will open.
    //
    // Unlike the chain list below, a self-hosted gate DOES know this: scope is
    // a property of the mount, not of the merchant's payout state. Its absence
    // is what a QA pass spent a day on — an agent buying for "/genres" could
    // not tell whether that covered "/genres/action", and found out by paying
    // and being refused. Fixing the scope COMPARISON (0.2.3) does not help
    // while the challenge never says which scope was sold.
    scope: args.scope ?? "exact",
    protocol_fee_bps: PROTOCOL_FEE_BPS,
    // Unlike cards, there is no fixed floor per transaction, which is the only
    // reason a $0.0005 call is a viable product at all.
    no_minimum_fee: true,
    // Where the chain and asset list lives, and why it is not here.
    //
    // An external QA pass on a partner integration read this 402 and reported
    // "no chain ID, no token, no merchant address, no expiry" as a protocol
    // defect. It is not — but the 402 never said where they were, so the
    // reading was reasonable.
    //
    // They cannot be in a static challenge. accepted_chains is derived per
    // merchant from `Object.keys(merchant.pay_to)` (backend/routes/aifp.js),
    // accepted_assets drops POL whenever there is no live POL rate, and both
    // change without this resource changing. A gate running on the partner's
    // own host has none of that state. Naming the endpoint that does is the
    // honest answer; inlining a guess would be a 402 that promises chains the
    // quote will refuse.
    settlement_terms_from: `POST ${api}/v1/quote — returns accepted_chains, accepted_assets, amount, order_id and expiry`,
    how_to_pay: [
      `POST ${api}/v1/quote {"merchant_id":"${merchantId}","resource":"${resource}","tier":"${tier}"}`,
      "settle the quoted batch on-chain from your own wallet (order_id = quote_id)",
      `POST ${api}/v1/pay {quote_id, chain, asset, tx_ref} -> quota receipt`,
      "retry this request with header: AIFP-Receipt: <receipt JWT>",
    ],
    // The 402 is the only documentation an agent is guaranteed to read, and
    // "your own wallet" above is a dead end for an agent that has none. This
    // line is the way out — the SDKs create a local wallet and run the whole
    // quote→settle→receipt→retry loop from one call.
    no_wallet:
      "npx @aifinpay/mcp init — creates a local wallet; then agent.pay(url) handles this 402 end-to-end (npm @aifinpay/agent · pypi aifinpay-agent)",
  };
}
