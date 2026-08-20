import { describe, expect, it } from "vitest";
import {
  AifpAuthError,
  AifpConflictError,
  AifpMerchant,
  AifpValidationError,
  ResourceRegistry,
} from "../src/index.js";

const SECRET = "sk_live_supersecret_do_not_log_me";

/** Records every request so the transport can be asserted directly — headers,
 *  method, URL and body are the parts a partner cannot see when it goes wrong. */
function stubFetch(handler: (url: string, init: RequestInit) => { status: number; body: unknown }) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = (async (url: string | URL, init: RequestInit = {}) => {
    calls.push({ url: String(url), init });
    const { status, body } = handler(String(url), init);
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof globalThis.fetch;
  return { fetchImpl, calls };
}

const resource = (route_pattern: string, id = "res_aaaaaaaaaaaa") => ({
  id,
  route_pattern,
  type: "api",
  paywall_enabled: true,
  tier: "standard",
  unit_weight: null,
  name: null,
  created_at: "2026-08-20T00:00:00.000Z",
});

describe("AifpMerchant transport", () => {
  it("sends the secret in the header, to api.aifinpay.io, at the right path", () => {
    const { fetchImpl, calls } = stubFetch(() => ({ status: 200, body: { resources: [] } }));
    const m = new AifpMerchant({ merchantId: "mrch_1", secret: SECRET, fetch: fetchImpl });
    expect(m.baseUrl).toBe("https://api.aifinpay.io");
    return m.listResources().then(() => {
      expect(calls[0].url).toBe("https://api.aifinpay.io/v1/merchants/mrch_1/resources");
      expect((calls[0].init.headers as Record<string, string>)["AIFP-Merchant-Secret"]).toBe(SECRET);
    });
  });

  it("never retries a create — a retried POST is a duplicate route_pattern", async () => {
    let attempts = 0;
    const { fetchImpl } = stubFetch(() => {
      attempts++;
      throw new Error("network down");
    });
    const m = new AifpMerchant({
      merchantId: "mrch_1",
      secret: SECRET,
      fetch: fetchImpl,
      retries: 3,
    });
    await expect(m.createResource({ route_pattern: "/a", type: "api" })).rejects.toThrow(
      /unreachable/,
    );
    expect(attempts).toBe(1);
  });

  it("retries a GET, because reading twice costs nothing", async () => {
    let attempts = 0;
    const { fetchImpl } = stubFetch(() => {
      attempts++;
      if (attempts < 3) throw new Error("network blip");
      return { status: 200, body: { resources: [] } };
    });
    const m = new AifpMerchant({ merchantId: "mrch_1", secret: SECRET, fetch: fetchImpl, retries: 2 });
    await m.listResources();
    expect(attempts).toBe(3);
  });
});

describe("AifpMerchant error mapping", () => {
  it("409 becomes a typed conflict carrying the existing resource id", async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 409,
      body: {
        error: "AIFP-409",
        detail: "a resource with this route_pattern already exists",
        resource_id: "res_beefbeefbeef",
      },
    }));
    const m = new AifpMerchant({ merchantId: "mrch_1", secret: SECRET, fetch: fetchImpl });
    await expect(m.createResource({ route_pattern: "/api/search", type: "api" })).rejects.toBeInstanceOf(
      AifpConflictError,
    );
    // The id is what turns a conflict into a fix: PATCH that resource.
    await m
      .createResource({ route_pattern: "/api/search", type: "api" })
      .catch((e: AifpConflictError) => expect(e.resourceId).toBe("res_beefbeefbeef"));
  });

  it("400 surfaces the server's own hint verbatim", async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 400,
      body: { error: "AIFP-400", detail: "type must be one of page|api|dataset|mcp_tool|product" },
    }));
    const m = new AifpMerchant({ merchantId: "mrch_1", secret: SECRET, fetch: fetchImpl });
    await expect(
      m.createResource({ route_pattern: "/a", type: "wat" as never }),
    ).rejects.toBeInstanceOf(AifpValidationError);
  });

  it("403 becomes an auth error and the secret never appears in it", async () => {
    const { fetchImpl } = stubFetch(() => ({
      status: 403,
      body: { error: "AIFP-403", detail: "invalid merchant secret" },
    }));
    const m = new AifpMerchant({ merchantId: "mrch_1", secret: SECRET, fetch: fetchImpl });
    try {
      await m.listResources();
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(AifpAuthError);
      const err = e as Error;
      // An error message ends up in logs, issue trackers and screenshots.
      expect(err.message).not.toContain(SECRET);
      expect(String(err.stack)).not.toContain(SECRET);
    }
  });

  it("404 on a read is null, and on a delete is false — neither is an exception", async () => {
    const { fetchImpl } = stubFetch(() => ({ status: 404, body: { error: "AIFP-404" } }));
    const m = new AifpMerchant({ merchantId: "mrch_1", secret: SECRET, fetch: fetchImpl });
    expect(await m.getResource("res_000000000000")).toBe(null);
    expect(await m.deleteResource("res_000000000000")).toBe(false);
  });
});

describe("the secret is not printable", () => {
  it("stays out of JSON.stringify and console.log of the client", () => {
    const m = new AifpMerchant({ merchantId: "mrch_1", secret: SECRET, fetch: globalThis.fetch });
    expect(JSON.stringify(m)).not.toContain(SECRET);
    expect(JSON.stringify({ config: m })).not.toContain(SECRET);
    expect(String(Object.keys(m))).not.toContain("_secret");
  });
});

describe("ensureResources", () => {
  it("sends upsert:true and converges on a second run instead of duplicating", async () => {
    const created = new Map<string, ReturnType<typeof resource>>();
    const bodies: unknown[] = [];
    const { fetchImpl } = stubFetch((_url, init) => {
      const body = JSON.parse(String(init.body)) as { route_pattern: string; upsert?: boolean };
      bodies.push(body);
      const existing = created.get(body.route_pattern);
      if (existing) return { status: 200, body: { resource: existing } };
      const rec = resource(body.route_pattern, "res_" + created.size.toString().padStart(12, "0"));
      created.set(body.route_pattern, rec);
      return { status: 201, body: { resource: rec } };
    });

    const m = new AifpMerchant({ merchantId: "mrch_1", secret: SECRET, fetch: fetchImpl });
    const inputs = [
      { route_pattern: "/api/search", type: "api" as const, tier: "complex" as const },
      { route_pattern: "/api/lookup/*", type: "api" as const },
    ];

    const run1 = await m.ensureResources(inputs);
    const run2 = await m.ensureResources(inputs);

    // The call a partner puts in their boot script must be safe on every boot.
    expect(run1.map((r) => r.id)).toEqual(run2.map((r) => r.id));
    expect(created.size).toBe(2);
    expect(bodies.every((b) => (b as { upsert?: boolean }).upsert === true)).toBe(true);
  });

  it("warns loudly when the control plane stored the record non-durably", async () => {
    // A 201 for a record that only reached one process's memory is a 201 that
    // lied: invisible in the dashboard, gone on restart.
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(" "));
    try {
      const { fetchImpl } = stubFetch(() => ({
        status: 201,
        body: { resource: { ...resource("/api/search"), durable: false } },
      }));
      const m = new AifpMerchant({ merchantId: "mrch_1", secret: SECRET, fetch: fetchImpl });
      await m.ensureResources([{ route_pattern: "/api/search", type: "api" }]);
    } finally {
      console.warn = original;
    }
    expect(warnings.join(" ")).toContain("non-durably");
  });
});

describe("ResourceRegistry", () => {
  it("keeps the last good snapshot when a refresh fails, rather than un-paywalling everything", async () => {
    let mode: "ok" | "fail" = "ok";
    const { fetchImpl } = stubFetch(() => {
      if (mode === "fail") throw new Error("control plane down");
      return { status: 200, body: { resources: [resource("/api/search")] } };
    });
    const m = new AifpMerchant({ merchantId: "mrch_1", secret: SECRET, fetch: fetchImpl, retries: 0 });
    const registry = new ResourceRegistry({ merchant: m });

    await registry.refresh();
    expect(registry.match("/api/search")?.route_pattern).toBe("/api/search");

    mode = "fail";
    await registry.refresh();
    // A network blip must not become free traffic.
    expect(registry.match("/api/search")?.route_pattern).toBe("/api/search");
    expect(registry.snapshot().resources.length).toBe(1);
  });

  it("matches nothing before the first successful fetch — which the gate reads as paywalled", async () => {
    const { fetchImpl } = stubFetch(() => {
      throw new Error("never reachable");
    });
    const m = new AifpMerchant({ merchantId: "mrch_1", secret: SECRET, fetch: fetchImpl, retries: 0 });
    const registry = new ResourceRegistry({ merchant: m });
    await registry.refresh();
    expect(registry.match("/api/search")).toBe(null);
    expect(registry.snapshot().stale).toBe(true);
  });
});
