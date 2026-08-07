import nacl from "tweetnacl";
import bs58 from "bs58";
import type { Agent } from "../agent.js";
import { sha256 } from "../crypto.js";
import { UntrustedPaymentTargetError } from "../errors.js";
import type { AuthPayload, Facilitator, PayOptions } from "./base.js";

const SIGNATURE_SCHEME = "aifinpay-ed25519-v2";
const MAX_CHALLENGE_TTL_MS = 5 * 60_000;

type SigningChallenge = {
  scheme?: string;
  hash?: string;
  message_version?: number;
  method?: string;
  resource?: string;
  expires?: string;
  min_usd?: string;
  agreement_hash?: string;
};

function canonicalSigningMessage(args: {
  nonce: string;
  agent: string;
  method: string;
  resource: string;
  expires: string;
  minUsd: string;
  agreementHash: string;
}): string {
  return [
    "AiFinPay-x402-v2",
    `nonce=${args.nonce}`,
    `agent=${args.agent}`,
    `method=${args.method}`,
    `resource=${args.resource}`,
    `expires=${args.expires}`,
    `min_usd=${args.minUsd}`,
    `agreement_hash=${args.agreementHash}`,
  ].join("\n");
}

/**
 * Native AiFinPay flavor.
 *
 * Security policy:
 * - accept auth challenges only from the configured AiFinPay origin;
 * - never fetch or sign a generic/unbound nonce;
 * - require the v2 server challenge to bind method, resource, expiry,
 *   minimum value terms and agreement hash;
 * - require the challenge resource to exactly match the response URL;
 * - reject expired or implausibly long-lived authorizations.
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
    let responseUrl: URL;
    let trustedOrigin: string;
    try {
      responseUrl = new URL(resp.url);
      trustedOrigin = new URL(agent.baseUrl).origin;
    } catch {
      throw new UntrustedPaymentTargetError(
        "[AIFINPAY_AUTH_UNTRUSTED] unable to determine response/base origin",
      );
    }

    if (!resp.url || responseUrl.origin !== trustedOrigin) {
      throw new UntrustedPaymentTargetError(
        `[AIFINPAY_AUTH_UNTRUSTED] refusing AiFinPay signature for origin ${responseUrl.origin}; ` +
          `trusted origin is ${trustedOrigin}`,
      );
    }

    let body: Record<string, unknown>;
    try {
      body = (await resp.clone().json()) as Record<string, unknown>;
    } catch {
      throw new UntrustedPaymentTargetError(
        "[AIFINPAY_AUTH_INVALID] trusted 402 response is not valid JSON",
      );
    }

    const nonce = typeof body["x-nonce"] === "string" ? body["x-nonce"] : "";
    const signing =
      typeof body.signing === "object" && body.signing !== null
        ? (body.signing as SigningChallenge)
        : null;

    if (!nonce || !signing) {
      throw new UntrustedPaymentTargetError(
        "[AIFINPAY_AUTH_INVALID] missing bound nonce/signing challenge",
      );
    }
    if (
      signing.scheme !== SIGNATURE_SCHEME ||
      signing.hash !== "sha256" ||
      signing.message_version !== 2
    ) {
      throw new UntrustedPaymentTargetError(
        "[AIFINPAY_AUTH_INVALID] unsupported or legacy signing scheme",
      );
    }

    const method = String(signing.method || "").toUpperCase();
    const resource = String(signing.resource || "");
    const expires = String(signing.expires || "");
    const minUsd = String(signing.min_usd || "");
    const agreementHash = String(signing.agreement_hash || "");
    const expectedResource = `${responseUrl.pathname}${responseUrl.search}`;
    const expiresMs = Date.parse(expires);
    const now = Date.now();

    if (!method || !/^[A-Z]+$/.test(method)) {
      throw new UntrustedPaymentTargetError(
        "[AIFINPAY_AUTH_INVALID] invalid bound HTTP method",
      );
    }
    if (!resource || resource !== expectedResource) {
      throw new UntrustedPaymentTargetError(
        `[AIFINPAY_AUTH_INVALID] challenge resource ${resource || "<missing>"} ` +
          `does not match ${expectedResource}`,
      );
    }
    if (
      !Number.isFinite(expiresMs) ||
      expiresMs <= now ||
      expiresMs - now > MAX_CHALLENGE_TTL_MS
    ) {
      throw new UntrustedPaymentTargetError(
        "[AIFINPAY_AUTH_INVALID] challenge expiry is invalid",
      );
    }
    if (!minUsd || !Number.isFinite(Number(minUsd)) || Number(minUsd) < 0) {
      throw new UntrustedPaymentTargetError(
        "[AIFINPAY_AUTH_INVALID] challenge value terms are invalid",
      );
    }
    if (!/^[a-fA-F0-9]{64}$/.test(agreementHash)) {
      throw new UntrustedPaymentTargetError(
        "[AIFINPAY_AUTH_INVALID] agreement hash is invalid",
      );
    }

    // Cross-check duplicated top-level terms so a malformed trusted response
    // cannot accidentally sign a different value/agreement than it displays.
    if (
      String(body.min_usd ?? "") !== minUsd ||
      String(body.agreement_hash ?? "") !== agreementHash
    ) {
      throw new UntrustedPaymentTargetError(
        "[AIFINPAY_AUTH_INVALID] signing terms disagree with challenge body",
      );
    }

    const message = canonicalSigningMessage({
      nonce,
      agent: agent.address,
      method,
      resource,
      expires,
      minUsd,
      agreementHash,
    });
    const digest = await sha256(new TextEncoder().encode(message));
    const sig = nacl.sign.detached(digest, agent.secretKey);

    return {
      headers: {
        "x-agent-pubkey": agent.address,
        "x-nonce": nonce,
        "x-signature": bs58.encode(sig),
        "x-aifinpay-signature-scheme": SIGNATURE_SCHEME,
      },
    };
  }
}

export { canonicalSigningMessage, SIGNATURE_SCHEME };
