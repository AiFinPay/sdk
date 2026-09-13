import type { Agent } from "../agent.js";
import { FacilitatorNotImplementedError, PaymentTooExpensiveError, UnsupportedFacilitatorError } from "../errors.js";
import type { AuthPayload, Facilitator, PayOptions } from "./base.js";

/**
 * Coinbase x402 flavor — `PAYMENT-REQUIRED` / `PAYMENT-SIGNATURE` headers.
 *
 * Reference: github.com/coinbase/x402
 *
 * Detection works today. Payment execution requires an EVM key + the
 * EIP-3009 `transferWithAuthorization` flow; scheduled for SDK 0.3.x.
 */
export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

export class CoinbaseX402Facilitator implements Facilitator {
  static readonly name = "coinbase-x402";
  readonly name = "coinbase-x402";

  static detect(resp: Response): boolean {
    if (resp.status !== 402) return false;
    return resp.headers.has(PAYMENT_REQUIRED_HEADER);
  }

  async buildAuth(resp: Response, _agent: Agent, opts: PayOptions): Promise<AuthPayload> {
    const spec = decodePaymentRequired(resp);
    const accepts = (spec.accepts ?? spec.paymentRequirements ?? []) as Array<Record<string, unknown>>;

    if (accepts.length && opts.maxAmountUsd !== undefined) {
      const cheapest = minUsd(accepts);
      if (cheapest !== null && cheapest > opts.maxAmountUsd) {
        throw new PaymentTooExpensiveError(
          `Coinbase x402 wants $${cheapest.toFixed(4)}, ` + `caller cap is $${opts.maxAmountUsd.toFixed(4)}`
        );
      }
    }

    throw new FacilitatorNotImplementedError(
      "Coinbase x402 detected, but payment execution is not yet wired. " +
        "This SDK build supports detection + parsing only. " +
        "Track progress in `14 - Design - Generic x402 Client.md`."
    );
  }
}

function decodePaymentRequired(resp: Response): Record<string, unknown> {
  const raw = resp.headers.get(PAYMENT_REQUIRED_HEADER);
  if (!raw) {
    throw new UnsupportedFacilitatorError(`missing ${PAYMENT_REQUIRED_HEADER} header on Coinbase x402 response`);
  }
  let decoded: string;
  try {
    decoded = typeof Buffer !== "undefined" ? Buffer.from(raw, "base64").toString("utf-8") : atob(raw);
  } catch (e) {
    throw new UnsupportedFacilitatorError(`${PAYMENT_REQUIRED_HEADER} is not valid base64: ${(e as Error).message}`);
  }
  try {
    return JSON.parse(decoded);
  } catch (e) {
    throw new UnsupportedFacilitatorError(`${PAYMENT_REQUIRED_HEADER} body is not valid JSON: ${(e as Error).message}`);
  }
}

function minUsd(accepts: Array<Record<string, unknown>>): number | null {
  const candidates: number[] = [];
  for (const entry of accepts) {
    const usd = entry.priceUsd ?? entry.usdPrice;
    if (typeof usd === "number") candidates.push(usd);
  }
  return candidates.length ? Math.min(...candidates) : null;
}
