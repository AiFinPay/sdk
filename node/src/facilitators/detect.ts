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
