import nacl from "tweetnacl";
import bs58 from "bs58";
import type { Agent } from "../agent.js";
import { sha256 } from "../crypto.js";
import type {
  AuthPayload,
  AuthRequestContext,
  Facilitator,
  PayOptions,
} from "./base.js";

/**
 * Native AiFinPay flavor.
 *
 * Wire format:
 *   - 402 carries a JSON body with `protocol: "AiFinPay vX"` and
 *     `agreement_hash`, `treasury_vault`, `x-nonce` …
 *   - Client retries with three headers:
 *       x-agent-pubkey, x-nonce, x-signature
 *   - Signature: Ed25519 over SHA-256(canonical v2 request binding)
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
    // Fallback fingerprint when an upstream proxy strips `protocol`.
    return (
      ("agreement_hash" in b || "manifesto" in b) &&
      ("treasury_vault" in b || "program_id" in b)
    );
  }

  async buildAuth(
    resp: Response,
    agent: Agent,
    _opts: PayOptions,
    context?: AuthRequestContext,
  ): Promise<AuthPayload> {
    if (!context) {
      throw new Error(
        "AiFinPay native auth v1 is no longer supported. Retry through Agent.pay() so the SDK can bind the challenge to the request.",
      );
    }
    if (context.url.origin !== context.trustedOrigin) {
      throw new Error(
        `refusing native authentication for untrusted origin ${context.url.origin}; configure Agent.baseUrl for that facilitator explicitly`,
      );
    }
    if (resp.url && new URL(resp.url).origin !== context.trustedOrigin) {
      throw new Error("refusing native authentication after a cross-origin response");
    }

    const challenge = await this.inbandChallenge(resp, context.bodyDigest);
    if (!challenge) {
      throw new Error(
        "AiFinPay native auth v2 requires an in-band request-bound challenge. Retry the original request without credentials.",
      );
    }
    const message = JSON.stringify([
      "AiFinPay-x402",
      "v2",
      challenge.nonce,
      agent.address,
      context.trustedOrigin,
      context.method.toUpperCase(),
      `${context.url.pathname}${context.url.search}`,
      context.bodyDigest,
      challenge.expiresAt,
    ]);
    const msg = new TextEncoder().encode(message);
    const digest = await sha256(msg);
    const sig = nacl.sign.detached(digest, agent.secretKey);
    return {
      headers: {
        "x-agent-pubkey": agent.address,
        "x-nonce": challenge.nonce,
        "x-signature": bs58.encode(sig),
        "x-aifinpay-auth-version": "2",
      },
    };
  }

  private async inbandChallenge(
    resp: Response,
    expectedBodyDigest: string,
  ): Promise<{ nonce: string; expiresAt: number; bodyDigest: string } | null> {
    let body: unknown;
    try {
      body = await resp.clone().json();
    } catch {
      return null;
    }
    if (typeof body !== "object" || body === null) return null;
    const b = body as Record<string, unknown>;
    const nonce = b["x-nonce"];
    const expiresAt = b["x-nonce-expires-at"];
    const version = b["x-aifinpay-auth-version"];
    const bodyDigest = b["x-aifinpay-body-sha256"];
    if (
      typeof nonce !== "string" ||
      !/^[A-Za-z0-9_-]{16,128}$/.test(nonce) ||
      (version !== 2 && version !== "2") ||
      (typeof expiresAt !== "string" && typeof expiresAt !== "number") ||
      !/^[1-9][0-9]{0,15}$/.test(String(expiresAt)) ||
      typeof bodyDigest !== "string" ||
      !/^[0-9a-f]{64}$/.test(bodyDigest) ||
      bodyDigest !== expectedBodyDigest
    ) {
      return null;
    }
    const parsedExpiry = Number(expiresAt);
    const now = Date.now();
    return Number.isSafeInteger(parsedExpiry) && parsedExpiry > now && parsedExpiry <= now + 5 * 60_000
      ? { nonce, expiresAt: parsedExpiry, bodyDigest }
      : null;
  }
}
