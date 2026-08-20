import { describe, expect, it } from "vitest";
import * as jose from "jose";
import { createGate, MemoryStore } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req } from "./helpers.js";

describe("verification is pinned to EdDSA", () => {
  it("rejects an HS256 token that reuses the JWKS public key bytes as an HMAC secret", async () => {
    // The classic algorithm-confusion attack: take the public key we publish,
    // treat it as a shared secret, and mint your own receipt. Pinning
    // `algorithms: ["EdDSA"]` kills the whole class — the token is refused
    // before any key lookup happens.
    const iss = await issuer();
    const pub = iss.jwks.keys[0] as { x: string };
    const secret = new Uint8Array(Buffer.from(pub.x, "base64url"));

    const forged = await new jose.SignJWT({
      resource: "/api/search",
      scope: "exact",
      unit_quota: 1_000_000,
      receipt_id: "rcpt_forged",
      nonce: "n",
      amount: "0",
    })
      .setProtectedHeader({ alg: "HS256", kid: "test-key" })
      .setIssuer(ISSUER)
      .setSubject("agt_attacker")
      .setAudience(MERCHANT)
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(secret);

    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwks: iss.jwks,
      store: new MemoryStore(),
    });

    const r = await gate(req("/api/search", { "AIFP-Receipt": forged }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.status).toBe(403);
  });
});

describe("when the key set cannot be reached", () => {
  it("fails CLOSED with 503, never open", async () => {
    // Failing open would turn a partner's paid API into a free one for the
    // duration of our outage — a far more expensive failure than a 503 the
    // agent will retry. Port 1 refuses connections instantly, so this needs no
    // network access.
    const iss = await issuer();
    const token = await iss.sign({ unit_quota: 100 });
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwksUri: "http://127.0.0.1:1/.well-known/jwks.json",
      store: new MemoryStore(),
    });

    const r = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("AIFP-503-METER");
    expect(r.headers["Retry-After"]).toBeDefined();
  });
});

describe("when the quota store is down", () => {
  const brokenStore = {
    async incrBy(): Promise<number> {
      throw new Error("ECONNREFUSED redis");
    },
  };

  it("refuses by default rather than serving un-metered calls", async () => {
    const iss = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwks: iss.jwks,
      store: brokenStore,
    });

    const r = await gate(req("/api/search", { "AIFP-Receipt": await iss.sign({ unit_quota: 5 }) }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.status).toBe(503);
    expect(r.body.error).toBe("AIFP-503-METER");
  });

  it("serves and flags the degradation when the partner explicitly chose availability", async () => {
    const iss = await issuer();
    const events: string[] = [];
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwks: iss.jwks,
      store: brokenStore,
      onStoreError: "open",
      onEvent: (e) => events.push(e.kind),
    });

    const r = await gate(req("/api/search", { "AIFP-Receipt": await iss.sign({ unit_quota: 5 }) }));
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.headers["AIFP-Meter"]).toBe("degraded");
    // Chosen, but never silent.
    expect(events).toContain("meter_error");
  });
});

describe("single-use receipts", () => {
  it("are refused on replay, because a 1-unit batch has no counter headroom", async () => {
    const iss = await issuer();
    const gate = createGate({
      merchantId: MERCHANT,
      resource: "/api/search",
      issuer: ISSUER,
      jwks: iss.jwks,
      store: new MemoryStore(),
    });
    const token = await iss.sign({ unit_quota: 1, nonce: "nonce_once" });

    const first = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(first.ok).toBe(true);
    const second = await gate(req("/api/search", { "AIFP-Receipt": token }));
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.status).toBe(403);
  });
});
