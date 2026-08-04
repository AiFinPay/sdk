import type { Agent } from "../agent.js";
import { UntrustedPaymentTargetError } from "../errors.js";
import type { AuthPayload, Facilitator, PayOptions } from "./base.js";

/**
 * Standard x402 detector.
 *
 * Signing is deliberately disabled until AiFinPay has a signed registry that
 * binds network, asset/codehash/decimals, EIP-712 domain, payTo, fee policy and
 * validity window. Every one of those values currently comes from the
 * untrusted 402 server, so producing EIP-3009 authorization would make the SDK
 * a signing oracle.
 */
export class StandardX402Facilitator implements Facilitator {
  static readonly name = "x402";
  readonly name = "x402";

  static async detect(resp: Response): Promise<boolean> {
    if (resp.status !== 402) return false;
    let body: unknown;
    try {
      body = await resp.clone().json();
    } catch {
      return false;
    }
    if (typeof body !== "object" || body === null) return false;
    const value = body as Record<string, unknown>;
    return "x402Version" in value && Array.isArray(value.accepts);
  }

  async buildAuth(
    _resp: Response,
    _agent: Agent,
    _opts: PayOptions,
  ): Promise<AuthPayload> {
    throw new UntrustedPaymentTargetError(
      "[X402_TARGET_REGISTRY_REQUIRED] standard x402 signing is disabled: " +
        "asset, payTo, EIP-712 domain and token decimals are not bound to a signed AiFinPay registry",
    );
  }
}
