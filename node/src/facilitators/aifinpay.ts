import nacl from "tweetnacl";
import bs58 from "bs58";
import type { Agent } from "../agent.js";
import { sha256 } from "../crypto.js";
import { UntrustedPaymentTargetError } from "../errors.js";
import type { AuthPayload, Facilitator, PayOptions } from "./base.js";

/**
 * Native AiFinPay flavor.
 *
 * Security policy:
 * - never trust a nonce supplied by the 402 responder;
 * - obtain the nonce only from the configured AiFinPay base URL;
 * - never emit the legacy bearer-style signature to a different origin.
 *
 * The legacy wire signature is still `AiFinPay-x402:{nonce}:{pubkey}` because
 * the production verifier expects it. Restricting it to the configured
 * AiFinPay origin closes the arbitrary-endpoint signing-oracle path until the
 * protocol is upgraded to a request-bound signature format that includes
 * origin/resource/amount/expiry on both client and server.
 */
export class AiFinPayFacilitator implements Facilitator {
  static readonly name = "aifinpay";
  readonly name = "aifinpay";

  static async detect(resp: Response): Promise<boolean> {
    if (resp.status !== 402) return false;
    let body: unknown;
    try {
      body = await resp.clone().json();
    } catch {
      return false;
    }
    if (typeof body !== "object" || body === null) return false;
    const b = body as Record<string, unknown>;
    if (typeof b.protocol === "string" && b.protocol.startsWith("AiFinPay")) {
      return true;
    }
    return (
      ("agreement_hash" in b || "manifesto" in b) &&
      ("treasury_vault" in b || "program_id" in b)
    );
  }

  async buildAuth(
    resp: Response,
    agent: Agent,
    _opts: PayOptions,
  ): Promise<AuthPayload> {
    let responseOrigin: string;
    let trustedOrigin: string;
    try {
      responseOrigin = new URL(resp.url).origin;
      trustedOrigin = new URL(agent.baseUrl).origin;
    } catch {
      throw new UntrustedPaymentTargetError(
        "[AIFINPAY_AUTH_UNTRUSTED] unable to determine response/base origin",
      );
    }

    if (!resp.url || responseOrigin !== trustedOrigin) {
      throw new UntrustedPaymentTargetError(
        `[AIFINPAY_AUTH_UNTRUSTED] refusing legacy AiFinPay signature for origin ${responseOrigin}; ` +
          `trusted origin is ${trustedOrigin}`,
      );
    }

    const nonce = await this.fetchNonce(agent);
    const msg = new TextEncoder().encode(
      `AiFinPay-x402:${nonce}:${agent.address}`,
    );
    const digest = await sha256(msg);
    const sig = nacl.sign.detached(digest, agent.secretKey);
    return {
      headers: {
        "x-agent-pubkey": agent.address,
        "x-nonce": nonce,
        "x-signature": bs58.encode(sig),
      },
    };
  }

  private async fetchNonce(agent: Agent): Promise<string> {
    const r = await agent.fetchImpl(`${agent.baseUrl}/nonce`, {
      headers: { accept: "application/json" },
      redirect: "error",
    });
    if (!r.ok) throw new Error(`/nonce → ${r.status}`);
    const json = (await r.json()) as { nonce?: string };
    if (!json.nonce) throw new Error("/nonce: missing 'nonce' field");
    return json.nonce;
  }
}
