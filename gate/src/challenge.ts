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
  tier: Tier;
  weight: number;
  detail?: string;
  unitPriceUsd?: string;
  minRequests?: number;
}): GateErrorBody {
  const { merchantId, resource, tier, weight } = args;
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
    protocol_fee_bps: PROTOCOL_FEE_BPS,
    // Unlike cards, there is no fixed floor per transaction, which is the only
    // reason a $0.0005 call is a viable product at all.
    no_minimum_fee: true,
    how_to_pay: [
      `POST /v1/quote {"merchant_id":"${merchantId}","resource":"${resource}","tier":"${tier}"}`,
      "settle the quoted batch on-chain from your own wallet (order_id = quote_id)",
      "POST /v1/pay {quote_id, chain, asset, tx_ref} -> quota receipt",
      "retry this request with header: AIFP-Receipt: <receipt JWT>",
    ],
  };
}
