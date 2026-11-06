import { createHash, createHmac, createPrivateKey, createPublicKey, sign } from "node:crypto";

const PKCS8_ED25519 = "302e020100300506032b657004220420";
const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

export function keyFromSeed({ kid, seed_hex }) {
  const privateKey = createPrivateKey({ key: Buffer.concat([Buffer.from(PKCS8_ED25519, "hex"), Buffer.from(seed_hex, "hex")]), format: "der", type: "pkcs8" });
  const jwk = createPublicKey(privateKey).export({ format: "jwk" });
  return { privateKey, jwk: { ...jwk, kid, alg: "EdDSA", use: "sig" }, x: Buffer.from(jwk.x, "base64url") };
}

export const uniqueHex = (seed, length = 16) => createHash("sha256").update(seed).digest("hex").slice(0, length);

/** Compact JWT for a case's receipt definition; claims and header keys set to null are dropped. */
export function mintReceipt(definition, { fixtures, keys, payer, seed, now }) {
  const overrides = { ...(definition.claims ?? {}) };
  const signing = definition.sign ?? {};
  if (overrides.aud === "$other_merchant") overrides.aud = fixtures.other_merchant_id;
  if (typeof overrides.exp_in === "number") {
    overrides.exp = now + overrides.exp_in;
    delete overrides.exp_in;
  }
  const claims = {
    iss: fixtures.issuer, aud: fixtures.merchant_id, sub: payer, payer, iat: 1758700000, exp: 4102444800,
    resource: "/paid/*", scope: "exact", tier: "standard", amount: "0.02", currency: "USD", asset: "USDC", chain: "polygon",
    tx_ref: "0x" + uniqueHex(`tx:${seed}`, 64), receipt_id: `rcpt_${uniqueHex(`id:${seed}`)}`, nonce: `n-${uniqueHex(`nonce:${seed}`)}`, unit_quota: 3,
    ...overrides,
  };
  for (const key of Object.keys(claims)) if (claims[key] === null) delete claims[key];
  const key = keys[signing.key ?? "issuer"];
  const header = { alg: "EdDSA", typ: "JWT", kid: key.jwk.kid, ...(signing.header ?? {}) };
  for (const name of Object.keys(header)) if (header[name] === null) delete header[name];
  const signed = (h, p) => `${h}.${p}.${sign(null, Buffer.from(`${h}.${p}`), key.privateKey).toString("base64url")}`;
  switch (signing.mutate) {
    case "tamper_payload": {
      const token = signed(b64(header), b64(claims));
      const [h, , s] = token.split(".");
      return `${h}.${b64({ ...claims, unit_quota: 999999 })}.${s}`;
    }
    case "alg_none":
      return `${b64({ alg: "none", typ: "JWT" })}.${b64(claims)}.`;
    case "alg_hs256": {
      const h = b64({ alg: "HS256", typ: "JWT", kid: key.jwk.kid });
      const p = b64(claims);
      return `${h}.${p}.${createHmac("sha256", key.x).update(`${h}.${p}`).digest("base64url")}`;
    }
    case "garbage":
      return "not.a.jwt";
    default:
      return signed(b64(header), b64(claims));
  }
}
