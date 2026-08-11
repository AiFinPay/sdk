import { UnsupportedFacilitatorError } from "../errors.js";
import { AiFinPayFacilitator } from "./aifinpay.js";
import type { Facilitator, FacilitatorClass } from "./base.js";
import { CoinbaseX402Facilitator } from "./coinbase.js";
import { StandardX402Facilitator } from "./standard-x402.js";

/**
 * Order matters: most-specific detector first. A response that matches
 * AiFinPay's body schema is also technically a 402, so we try AiFinPay
 * before falling back to header-based checks.
 */
export const REGISTERED: FacilitatorClass[] = [
  AiFinPayFacilitator,
  StandardX402Facilitator,
  CoinbaseX402Facilitator,
];

const BY_NAME = new Map<string, FacilitatorClass>(
  REGISTERED.map((cls) => [cls.name, cls]),
);

export async function detectFacilitator(
  resp: Response,
  override: string = "auto",
): Promise<Facilitator> {
  if (override && override !== "auto") {
    const cls = BY_NAME.get(override);
    if (!cls) {
      throw new UnsupportedFacilitatorError(
        `unknown facilitator override: '${override}'. ` +
          `known: ${[...BY_NAME.keys()].join(", ")}`,
      );
    }
    return new cls();
  }


  // Checked BEFORE the loop, and that ordering is the whole point.
  //
  // The Coinbase facilitator detects a `PAYMENT-REQUIRED` header, and the v2
  // standard uses `payment-required` — the same header, since HTTP header
  // names are case-insensitive. So Coinbase claims a real v2 response, wins
  // the loop, and then fails somewhere deep in buildAuth with an error about
  // its own internals. Anyone debugging that goes looking at Coinbase, which
  // has nothing to do with it.
  //
  // Verified against https://x402.org/protected on 2026-08-10: without this,
  // detectFacilitator returns coinbase-x402 for an endpoint that is not
  // Coinbase's flavour at all.
  if (StandardX402Facilitator.isUnsupportedV2(resp)) {
    throw new UnsupportedFacilitatorError(
      "this endpoint speaks x402 version 2 (payment data in the " +
        "`payment-required` header), which this SDK does not implement yet — " +
        "its standard-x402 facilitator targets version 1, where the payment " +
        "data is in the response body. The agent cannot pay this endpoint. " +
        "Tracking: Obsidian/proposals/2026-08-10-x402-interop-scoping.md",
    );
  }
  for (const cls of REGISTERED) {
    if (await cls.detect(resp)) return new cls();
  }

  const headerKeys: string[] = [];
  resp.headers.forEach((_, key) => headerKeys.push(key));
  throw new UnsupportedFacilitatorError(
    `402 response did not match any known facilitator. ` +
      `Status: ${resp.status}. ` +
      `Headers: ${headerKeys.slice(0, 8).join(", ")}.`,
  );
}
