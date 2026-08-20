// ──────────────────────────────────────────────────────────────────────────
// Receipt verification — local, stateless, and pinned to EdDSA.
//
// The gate never asks our control plane whether a receipt is good. It checks
// an Ed25519 signature against our published JWKS, in the partner's own
// process, on the partner's own CPU. That is the property that makes this
// middleware safe to put in front of a hot API: our availability does not
// become their latency.
//
// `algorithms: ["EdDSA"]` is not a default we inherited, it is a lock. The
// issuer signs Ed25519 and nothing else, so pinning removes the entire
// algorithm-confusion class — including the classic one where a JWKS's public
// key bytes are replayed as an HMAC secret on an HS256 token.
// ──────────────────────────────────────────────────────────────────────────
import * as jose from "jose";
import type { AifpReceiptClaims } from "./types.js";

export type VerifyResult =
  | { ok: true; payload: AifpReceiptClaims }
  | { ok: false; kind: "expired" }
  | { ok: false; kind: "invalid"; reason: string }
  | { ok: false; kind: "jwks_unavailable"; reason: string };

export interface VerifierOptions {
  issuer: string;
  audience: string;
  clockToleranceSec: number;
  jwksUri: string;
  /** Pin the key set and skip network I/O entirely. Tests use it; so should any
   *  partner who refuses a runtime dependency on us (at the cost of a redeploy
   *  on key rotation). */
  jwks?: { keys: object[] };
}

type KeyLookup = Parameters<typeof jose.jwtVerify>[1];

/** Lazily built, then reused: createRemoteJWKSet holds the cache, so building
 *  one per request would defeat the caching and hammer our JWKS endpoint. */
export function createVerifier(opts: VerifierOptions): (token: string) => Promise<VerifyResult> {
  let keys: KeyLookup | null = null;
  const getKeys = (): KeyLookup => {
    if (!keys) {
      keys = opts.jwks
        ? (jose.createLocalJWKSet(opts.jwks as jose.JSONWebKeySet) as unknown as KeyLookup)
        : (jose.createRemoteJWKSet(new URL(opts.jwksUri), {
            // Long cache, short cooldown: a rotated key is picked up within
            // 30s, and a JWKS outage is survivable for 10 minutes of traffic.
            cooldownDuration: 30_000,
            cacheMaxAge: 600_000,
          }) as unknown as KeyLookup);
    }
    return keys;
  };

  return async function verifyReceipt(token: string): Promise<VerifyResult> {
    try {
      const { payload } = await jose.jwtVerify(token, getKeys(), {
        issuer: opts.issuer,
        audience: opts.audience,
        algorithms: ["EdDSA"],
        clockTolerance: opts.clockToleranceSec,
      });
      return { ok: true, payload: payload as unknown as AifpReceiptClaims };
    } catch (e) {
      const code = (e as { code?: string }).code;
      const msg = e instanceof Error ? e.message : String(e);
      if (code === "ERR_JWT_EXPIRED") return { ok: false, kind: "expired" };
      // We could not REACH the key set, as opposed to reaching it and finding
      // the token bad. The two get different HTTP answers because only one of
      // them is the agent's fault.
      if (code === "ERR_JWKS_TIMEOUT" || (!code && isNetworkish(msg))) {
        return { ok: false, kind: "jwks_unavailable", reason: msg };
      }
      return { ok: false, kind: "invalid", reason: msg };
    }
  };
}

/** A fetch failure arrives as a plain TypeError with no jose code, so the
 *  message is all we have to go on. Kept narrow: mislabelling a bad token as
 *  an outage would answer 503 to a forgery. */
function isNetworkish(msg: string): boolean {
  return /fetch failed|network|ENOTFOUND|ECONNREFUSED|ECONNRESET|EAI_AGAIN|timed? ?out|aborted/i.test(msg);
}
