import type { Agent } from "../agent.js";
import { UntrustedPaymentTargetError } from "../errors.js";
import type { AuthPayload, Facilitator, PayOptions } from "./base.js";

/**
 * Standard x402 — the `X-PAYMENT` header flow (x402 Foundation / Linux
 * Foundation standard, donated by Coinbase 2026-04).
 *
 * ⚠ THIS DOES NOT YET INTEROPERATE WITH LIVE x402 SERVICES.
 *
 * It targets x402Version 1, and the standard has moved to 2. Tested against
 * https://x402.org/protected on 2026-08-10: detect() returns false, so an agent
 * walks past a real x402 endpoint without recognising it. Four differences,
 * every one confirmed against that live response:
 *
 *   transport   we read the JSON body; v2 sends base64 in a `payment-required`
 *               response header and leaves the body as `{}`
 *   version     we expect x402Version 1; live is 2
 *   amount      we read `maxAmountRequired`; v2 calls it `amount`
 *   network     we map names like "base" via CHAIN_IDS; v2 uses CAIP-2,
 *               e.g. "eip155:84532"
 *
 * The header of this file previously claimed this made AiFinPay agents
 * interoperable with 69k+ agents. It shipped in @aifinpay/agent 1.8.1 and could
 * not complete one payment to any of them. Saying so here rather than deleting
 * the sentence, because the next person to read this file needs to know the
 * implementation is a draft ahead of its target, not behind it.
 *
 * isUnsupportedV2 below exists so the failure is legible: an agent hitting a real
 * endpoint gets "this is x402 v2, unsupported" instead of "no facilitator
 * matched", which sends anyone debugging it in the wrong direction.
 *
 * Wire format IMPLEMENTED HERE (v1, superseded):
 *   - 402 body: { x402Version, accepts: [ { scheme:"exact", network,
 *       maxAmountRequired, payTo, asset, maxTimeoutSeconds, extra:{name,version} }, … ] }
 *   - Client signs an EIP-3009 TransferWithAuthorization (gasless) and retries with
 *       X-PAYMENT: base64(JSON({ x402Version, scheme, network, payload }))
 *
 * EVM `exact` only for now; Solana `exact` is a follow-up.
 *
 * SIGNING IS ALSO DISABLED INDEPENDENTLY OF THE VERSION GAP, and would stay
 * disabled even if v2 landed tomorrow:
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

  /**
   * True when this is a v2 response — the version we do NOT support.
   *
   * Separate from detect() on purpose. detect() answers "can I pay this",
   * and the honest answer for v2 is no. This answers "is this the standard I
   * am failing to speak", so the caller can say which.
   */
  static isUnsupportedV2(resp: Response): boolean {
    if (resp.status !== 402) return false;
    const hdr = resp.headers.get("payment-required");
    if (!hdr) return false;
    try {
      const decoded = JSON.parse(
        typeof atob === "function"
          ? atob(hdr)
          : Buffer.from(hdr, "base64").toString("utf8"),
      );
      return Number(decoded?.x402Version) >= 2;
    } catch {
      return false;
    }
  }

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
