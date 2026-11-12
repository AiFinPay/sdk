/** Contract cap on the treasury fee (Profiles.MAX_TREASURY_BPS); a bound, not a price. */
export const MAX_TREASURY_BPS = 500;

export function validFeeBps(v: unknown): number | undefined {
  return Number.isSafeInteger(v) && (v as number) >= 1 && (v as number) <= MAX_TREASURY_BPS ? (v as number) : undefined;
}

/** AIFP-1 fee in bps that a quote states; undefined when absent, out of range or contradictory. */
export function quotedFeeBps(quote: { fee_bps?: unknown; fee_policy?: unknown }): number | undefined {
  const policy =
    quote.fee_policy && typeof quote.fee_policy === "object"
      ? (quote.fee_policy as { treasury_bps?: unknown }).treasury_bps
      : undefined;
  const stated = [quote.fee_bps, policy].filter((v) => v !== undefined && v !== null);
  if (stated.length === 0) return undefined;
  if (!stated.every((v) => validFeeBps(v) !== undefined) || stated.some((v) => v !== stated[0])) return undefined;
  return stated[0] as number;
}

export function protocolFeeUnits(gross: bigint, bps: number): bigint {
  return (gross * BigInt(bps)) / 10_000n;
}
