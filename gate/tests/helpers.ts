// Hermetic issuer: an Ed25519 keypair generated in-process and handed to the
// gate as a pinned local JWKS. Nothing here touches the network, so the tests
// exercise the real verification path (jose, EdDSA, iss/aud/exp) without
// depending on api.aifinpay.io being reachable from CI.
import * as jose from "jose";
import type { GateRequest, Scope, Tier } from "../src/index.js";

export const ISSUER = "https://api.aifinpay.io";
export const MERCHANT = "mrch_test";

let keypair: jose.GenerateKeyPairResult | null = null;

export async function issuer(): Promise<{
  jwks: { keys: object[] };
  sign: (claims: SignArgs) => Promise<string>;
  privateKey: CryptoKey;
}> {
  if (!keypair) keypair = await jose.generateKeyPair("Ed25519", { extractable: true });
  const kp = keypair;
  const pub = await jose.exportJWK(kp.publicKey);
  const jwks = { keys: [{ ...pub, kid: "test-key", use: "sig", alg: "EdDSA" }] };
  return {
    jwks,
    privateKey: kp.privateKey as CryptoKey,
    sign: (claims: SignArgs) => signReceipt(kp.privateKey as CryptoKey, claims),
  };
}

export interface SignArgs {
  sub?: string;
  aud?: string;
  iss?: string;
  resource?: string;
  scope?: Scope;
  tier?: Tier;
  unit_quota?: number;
  quota?: number;
  receipt_id?: string;
  nonce?: string;
  /** Seconds from now; negative for an already-expired receipt. */
  expiresInSec?: number;
}

/** Mirror of backend/aifp/receipts.js signReceipt — same claim names, same
 *  header, same EdDSA. If the server's claim set changes, this fixture is
 *  where the mismatch should surface first. */
export async function signReceipt(privateKey: CryptoKey, a: SignArgs = {}): Promise<string> {
  const iat = Math.floor(Date.now() / 1000);
  const exp = iat + (a.expiresInSec ?? 3600);
  const body: Record<string, unknown> = {
    resource: a.resource ?? "/api/search",
    scope: a.scope ?? "exact",
    tier: a.tier ?? "standard",
    amount: "0.10",
    currency: "USD",
    tx_ref: "0xdeadbeef",
    receipt_id: a.receipt_id ?? "rcpt_" + Math.random().toString(16).slice(2, 18),
    nonce: a.nonce ?? "nonce_" + Math.random().toString(16).slice(2, 10),
  };
  if (a.unit_quota !== undefined) body.unit_quota = a.unit_quota;
  if (a.quota !== undefined) body.quota = a.quota;

  return new jose.SignJWT(body)
    .setProtectedHeader({ alg: "EdDSA", typ: "JWT", kid: "test-key" })
    .setIssuer(a.iss ?? ISSUER)
    .setSubject(a.sub ?? "agt_test")
    .setAudience(a.aud ?? MERCHANT)
    .setIssuedAt(iat)
    .setExpirationTime(exp)
    .sign(privateKey);
}

/** Minimal GateRequest — the whole reason the core takes an interface instead
 *  of an express Request. */
export function req(path: string, headers: Record<string, string> = {}): GateRequest {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return { path, header: (n: string) => lower.get(n.toLowerCase()) };
}
