// The gate serves x402 discovery so a merchant never hand-writes it.
//
// A partner asked how an agent learns a site takes payments before it hits a
// 402. Two answers: the 402 carries how_to_pay (an agent that tries, learns),
// and a well-known file (an agent that discovers politely, before spending a
// request). The file is a standard, and the gate already knows every resource
// it protects — so it builds the file, the merchant doesn't.
import { describe, it, expect } from "vitest";
import { buildDiscoveryDocument, aifpDiscovery } from "../src/index.js";

const OPTS = {
  merchantId: "mrch_raters",
  apiBase: "https://api.aifinpay.io",
  resources: [
    { resource: "/api/agent/genres", tier: "standard" as const },
    { resource: "/api/agent/*", tier: "complex" as const, scope: "prefix" as const, name: "agent API" },
  ],
};

describe("x402 discovery document", () => {
  it("names the merchant, the protocol, and where to settle", () => {
    const d = buildDiscoveryDocument(OPTS) as any;
    expect(d.protocol).toBe("AIFP-1");
    expect(d.merchant_id).toBe("mrch_raters");
    expect(d.quote_endpoint).toBe("https://api.aifinpay.io/v1/quote");
    expect(d.pay_endpoint).toBe("https://api.aifinpay.io/v1/pay");
  });

  it("tells a wallet-less agent how to get one", () => {
    // The single most useful line for a first-time agent, and why the 402
    // carries it too.
    expect((buildDiscoveryDocument(OPTS) as any).onboarding).toMatch(/@aifinpay\/mcp init/);
  });

  it("lists every gated resource with its price and scope", () => {
    const d = buildDiscoveryDocument(OPTS) as any;
    expect(d.resources).toHaveLength(2);
    expect(d.resources[0]).toMatchObject({ resource: "/api/agent/genres", tier: "standard", scope: "exact" });
    expect(d.resources[1]).toMatchObject({ resource: "/api/agent/*", scope: "prefix", name: "agent API" });
    for (const r of d.resources) expect(typeof r.unit_price_usd).toBe("string");
  });

  it("does NOT inline chain or asset — those come from the quote", () => {
    // A static file cannot know the merchant's payout chains without going
    // stale, so it points at /v1/quote instead of guessing. Same discipline as
    // the 402 challenge.
    const d = buildDiscoveryDocument(OPTS) as any;
    expect(d.accepted_chains).toBeUndefined();
    expect(d.settlement_terms_from).toContain("/v1/quote");
  });

  it("trims a trailing slash on apiBase so endpoints are never doubled", () => {
    const d = buildDiscoveryDocument({ ...OPTS, apiBase: "https://api.aifinpay.io/" }) as any;
    expect(d.quote_endpoint).toBe("https://api.aifinpay.io/v1/quote");
  });
});

describe("aifpDiscovery middleware", () => {
  function run(method: string, path: string) {
    const mw = aifpDiscovery(OPTS);
    let served: { status?: number; body?: string; type?: string } = {};
    let nexted = false;
    const req: any = { method, path, header: () => undefined };
    const res: any = {
      set(k: any, v?: any) { if (k === "content-type") this._t = v; return this; },
      status(s: number) { served.status = s; return this; },
      send(b: string) { served.body = b; return this; },
    };
    mw(req, res, () => { nexted = true; });
    return { served, nexted, res };
  }

  it("serves GET /.well-known/x402.json", () => {
    const { served, nexted } = run("GET", "/.well-known/x402.json");
    expect(nexted).toBe(false);
    expect(served.status).toBe(200);
    expect(JSON.parse(served.body!).merchant_id).toBe("mrch_raters");
  });

  it("passes everything else through untouched", () => {
    // The merchant mounts it app-wide; it must not swallow real routes.
    expect(run("GET", "/api/agent/genres").nexted).toBe(true);
    expect(run("POST", "/.well-known/x402.json").nexted).toBe(true);   // GET only
    expect(run("GET", "/").nexted).toBe(true);
  });
});
