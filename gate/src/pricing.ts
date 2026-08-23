// ──────────────────────────────────────────────────────────────────────────
// Pricing constants — transcribed from backend/aifp/pricing.js, the code, not
// from any prose about it.
//
// THE INVARIANT: weight === unitPrice / basePrice, for every tier.
//
//   standard $0.0005 ÷ $0.0005 =  1
//   complex  $0.0020 ÷ $0.0005 =  4
//   premium  $0.0050 ÷ $0.0005 = 10
//
// That equality is what makes a widened receipt scope safe: a batch spent
// across paths of different tiers drains at each path's real rate only because
// every tier costs the same money per billing unit.
//
// Complex is 4, not 6. It was 6 when the tiers were priced $0.0001/$0.0006/
// $0.0010 and moved to 4 when the prices did — but the comment above the
// server's own gate still says 6, and copying that comment instead of the code
// would meter every complex call at 6 units against a batch priced for 4:
// a 50% overcharge on that tier, and batches that drain early for no visible
// reason. pricing.test.ts asserts the ratio for all three tiers so this file
// cannot drift away from the money again.
// ──────────────────────────────────────────────────────────────────────────
import type { Tier } from "./types.js";

/** Billing units consumed per call, per tier preset. */
export const TIER_WEIGHTS: { standard: 1; complex: 4; premium: 10 } = {
  standard: 1,
  complex: 4,
  premium: 10,
};

/** Per-call AIFP-1 gross price paid by the agent. Strings, never floats — these are money. */
export const UNIT_PRICE_USD: { standard: "0.0005"; complex: "0.002"; premium: "0.005" } = {
  standard: "0.0005",
  complex: "0.002",
  premium: "0.005",
};

/** One billing unit is priced at the base tier. */
export const BASE_UNIT_PRICE_USD = "0.0005" as const;

/** AIFP-1 protocol fee: 1% of the gross price paid by the agent.
 *  It is deducted from gross settlement; it is NOT added on top.
 *  A merchant settlement is therefore 99% of the gross AIFP-1 price before
 *  external network/settlement costs. */
export const PROTOCOL_FEE_BPS = 100 as const;
export const MERCHANT_SHARE_BPS = 9_900 as const;
export const CREATOR_FEE_BPS = 0 as const;
export const FEE_MODE = "gross-inclusive" as const;

/** Stablecoin minor units (6 dp) per call — the integer form the server does
 *  its batch math in, kept here only so min_requests can be computed locally. */
const UNIT_PRICE_UNITS: Record<Tier, number> = { standard: 500, complex: 2000, premium: 5000 };

/** Default minimum batch: $0.10 in 6-dp minor units. */
const MIN_BATCH_UNITS = 100_000;

/** Billing units per call for a tier preset; unknown/absent → 1, matching the
 *  server. An unweighted mount therefore meters exactly 1 per call. */
export function weightForTier(tier?: string): number {
  return (TIER_WEIGHTS as Record<string, number>)[tier ?? ""] ?? 1;
}

/** Smallest whole request count that clears the $0.10 batch floor, so a 402
 *  can quote a real number without a control-plane round-trip. The 402 is the
 *  hot path when an agent first arrives, and it must not depend on us. */
export function minRequestsForTier(tier?: string): number {
  const unit = UNIT_PRICE_UNITS[(tier as Tier) ?? "standard"] ?? UNIT_PRICE_UNITS.standard;
  return Math.ceil(MIN_BATCH_UNITS / unit);
}

/** Per-call gross AIFP-1 price as a USD string; unknown tier falls back to the base rate. */
export function unitPriceUsd(tier?: string): string {
  return (UNIT_PRICE_USD as Record<string, string>)[tier ?? ""] ?? BASE_UNIT_PRICE_USD;
}
