import { describe, expect, it } from "vitest";
import { createGate, MemoryStore, ResourceRegistry } from "../src/index.js";
import { ISSUER, MERCHANT, issuer, req } from "./helpers.js";

/**
 * Three defects an independent review of this package found before it shipped.
 * Each is a money-path or availability bug that the existing suite passed
 * straight through, so each gets a behavioural assertion here.
 */

/** A registry stub: no network, and we control whether it has ever loaded. */
function registryStub(resources: unknown[], opts: { loaded?: boolean } = {}) {
  const loaded = opts.loaded !== false;
  const reg = new ResourceRegistry({
    merchant: {
      listResources: async () => resources,
    } as never,
  });
  if (loaded) {
    // Reach past the private fields the same way a successful refresh would.
    (reg as unknown as { resources: unknown[] }).resources = resources;
    (reg as unknown as { fetchedAt: string | null }).fetchedAt = new Date().toISOString();
  }
  return reg;
}

async function gateWith(overrides: Record<string, unknown> = {}) {
  const iss = await issuer();
  return createGate({
    merchantId: MERCHANT,
    resource: "/api/search",
    tier: "standard",
    issuer: ISSUER,
    jwks: iss.jwks,
    store: new MemoryStore(),
    ...overrides,
  });
}

describe("the 402 has to be actionable from the partner's host", () => {
  it("names an absolute AiFinPay URL, not a path on the partner's own server", async () => {
    const gate = await gateWith();
    const r = await gate(req("/api/search"));
    expect(r.ok).toBe(false);
    if (r.ok) return;

    const quoteLine = r.body.how_to_pay[0];
    // This gate runs on the PARTNER's host. A relative "/v1/quote" would point
    // the agent at the partner's own server, where nothing answers it.
    expect(quoteLine).toContain("https://api.aifinpay.io/v1/quote");
    expect(r.body.how_to_pay.some((l: string) => l.includes("https://api.aifinpay.io/v1/pay"))).toBe(true);
  });

  it("honours an apiBase override for a staging control plane", async () => {
    const gate = await gateWith({ apiBase: "https://staging.aifinpay.io/" });
    const r = await gate(req("/api/search"));
    if (r.ok) return;
    // Trailing slash must not produce a double slash in the emitted URL.
    expect(r.body.how_to_pay[0]).toContain("https://staging.aifinpay.io/v1/quote");
  });
});

describe("the advertised price must be the price that is metered", () => {
  it("quotes the matched resource's tier, not the mount's", async () => {
    const gate = await gateWith({
      resource: undefined,
      tier: undefined, // mount defaults to standard
      registry: registryStub([
        { id: "res_a", route_pattern: "/api/summarize", type: "api", tier: "premium", unit_weight: null, paywall_enabled: true },
      ]),
    });
    const r = await gate(req("/api/summarize"));
    expect(r.ok).toBe(false);
    if (r.ok) return;

    // The weight came from the premium record; the tier and price have to come
    // from the same place, or the agent is told $0.0005 and charged 10 units.
    expect(r.body.tier).toBe("premium");
    expect(r.body.unit_weight).toBe(10);
    expect(r.body.unit_price_usd).toBe("0.005");
  });
});

describe("a registry that has never loaded must not price anything", () => {
  it("answers 503 rather than silently metering a premium route at 1 unit", async () => {
    const gate = await gateWith({
      resource: undefined,
      registry: registryStub([], { loaded: false }),
    });
    const r = await gate(req("/api/summarize"));
    expect(r.ok).toBe(false);
    if (r.ok) return;

    expect(r.status).toBe(503);
    expect(r.body.error).toBe("AIFP-503-PRICING");
    expect(r.headers["Retry-After"]).toBeDefined();
  });

  it("lets a partner opt into availability over correct billing", async () => {
    const gate = await gateWith({
      resource: undefined,
      registry: registryStub([], { loaded: false }),
      registryUnavailable: "mount-default",
    });
    const r = await gate(req("/api/summarize"));
    if (r.ok) return;
    // Back to the ordinary "pay me" answer at the mount's tier.
    expect(r.status).toBe(402);
  });

  it("a loaded-but-empty registry is a real answer and still charges", async () => {
    const gate = await gateWith({ resource: undefined, registry: registryStub([]) });
    const r = await gate(req("/api/summarize"));
    if (r.ok) return;
    expect(r.status).toBe(402);
  });
});
