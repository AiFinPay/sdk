import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { verifyMessage } from "viem";
import { AiFinPayAgent } from "../src/index.js";

// ── Agent-network directory tests ──────────────────────────────────────────
//
// Exercises register() / unregister() / search() against a mocked fetch.
// The key invariant: register() must sign the EXACT canonical message the
// backend verifies (routes/network-agents.js → publishMessage):
//   AiFinPay-network-publish:polygon:<lowercased-addr>:<nonce>
// We re-verify the produced signature with viem.verifyMessage so a drift in
// the message template on either side fails this test.

const TEST_NONCE = "test-nonce-123";

interface Captured {
  url: string;
  method: string;
  body: any;
}

let originalFetch: typeof globalThis.fetch;
let captured: Captured[] = [];

// Mock for the happy path — nonce issuance, publish, unpublish, search.
function installMock(searchResult: unknown[] = []) {
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    const method = (init?.method ?? "GET").toUpperCase();
    let body: any = undefined;
    if (init?.body) {
      try {
        body = JSON.parse(String(init.body));
      } catch {
        body = String(init.body);
      }
    }
    captured.push({ url, method, body });

    const u = new URL(url);
    const path = u.pathname;

    if (path === "/api/network/nonce") {
      return new Response(JSON.stringify({ nonce: TEST_NONCE }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (/\/api\/network\/agents\/0x[0-9a-f]{40}\/publish$/.test(path)) {
      return new Response(
        JSON.stringify({
          ok: true,
          agent: {
            address: body.signature ? path.split("/")[4] : null,
            name: body.name,
            description: body.description ?? null,
            endpoint: body.endpoint,
            capabilities: body.capabilities ?? [],
            pricing: body.pricing ?? null,
            rating: null,
            published_at: 1_700_000_000,
            created_at: 1_700_000_000,
          },
          profile_url: `https://dashboard.aifinpay.io/network/agents/${path.split("/")[4]}`,
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }
    if (/\/api\/network\/agents\/0x[0-9a-f]{40}\/unpublish$/.test(path)) {
      return new Response(JSON.stringify({ ok: true, published: false }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (path === "/api/network/agents") {
      return new Response(JSON.stringify({ count: searchResult.length, agents: searchResult }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response("not mocked", { status: 404 });
  }) as typeof globalThis.fetch;
}

beforeEach(() => {
  originalFetch = globalThis.fetch;
  captured = [];
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("AiFinPayAgent.register", () => {
  it("fetches a nonce, signs the canonical publish message, and POSTs the payload", async () => {
    installMock();
    const agent = await AiFinPayAgent.new({ telemetry: false });
    const addr = agent.evmAddress.toLowerCase();

    const result = await agent.register({
      name: "Weather Oracle",
      endpoint: "https://weather.example.com/agent",
      description: "Forecasts on demand",
      capabilities: ["weather", "forecast"],
      pricing: { perCall: 0.01, currency: "USDC" },
    });

    // 1. nonce was fetched first, then publish POSTed
    expect(captured[0]!.method).toBe("GET");
    expect(new URL(captured[0]!.url).pathname).toBe("/api/network/nonce");
    expect(captured[1]!.method).toBe("POST");
    expect(new URL(captured[1]!.url).pathname).toBe(`/api/network/agents/${addr}/publish`);

    // 2. the signature is valid for the EXACT message the backend re-verifies
    const body = captured[1]!.body;
    const message = `AiFinPay-network-publish:polygon:${addr}:${TEST_NONCE}`;
    const ok = await verifyMessage({
      address: agent.evmAddress as `0x${string}`,
      message,
      signature: body.signature as `0x${string}`,
    });
    expect(ok).toBe(true);

    // 3. payload carries the registration fields + nonce
    expect(body.name).toBe("Weather Oracle");
    expect(body.endpoint).toBe("https://weather.example.com/agent");
    expect(body.capabilities).toEqual(["weather", "forecast"]);
    expect(body.pricing).toEqual({ per_call: 0.01, currency: "USDC" });
    expect(body.nonce).toBe(TEST_NONCE);

    // 4. returns the published agent record
    expect(result.name).toBe("Weather Oracle");
    expect(result.capabilities).toEqual(["weather", "forecast"]);
  });

  it("defaults pricing currency to USDC and description to null when omitted", async () => {
    installMock();
    const agent = await AiFinPayAgent.new({ telemetry: false });

    await agent.register({
      name: "Bare Agent",
      endpoint: "https://bare.example.com",
      pricing: { perCall: 0.5 },
    });

    const body = captured[1]!.body;
    expect(body.pricing).toEqual({ per_call: 0.5, currency: "USDC" });
    expect(body.description).toBeNull();
    expect(body.capabilities).toEqual([]);
  });

  it("throws when the backend rejects the publish", async () => {
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const path = new URL(typeof input === "string" ? input : input.toString()).pathname;
      if (path === "/api/network/nonce") {
        return new Response(JSON.stringify({ nonce: TEST_NONCE }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ error: "signature_invalid" }), {
        status: 401,
        headers: { "content-type": "application/json" },
      });
    }) as typeof globalThis.fetch;

    const agent = await AiFinPayAgent.new({ telemetry: false });
    await expect(agent.register({ name: "X", endpoint: "https://x.example.com" })).rejects.toThrow(
      /network publish failed: signature_invalid/
    );
  });
});

describe("AiFinPayAgent.unregister", () => {
  it("signs the unpublish message and POSTs to the unpublish endpoint", async () => {
    installMock();
    const agent = await AiFinPayAgent.new({ telemetry: false });
    const addr = agent.evmAddress.toLowerCase();

    await agent.unregister();

    expect(new URL(captured[0]!.url).pathname).toBe("/api/network/nonce");
    expect(captured[1]!.method).toBe("POST");
    expect(new URL(captured[1]!.url).pathname).toBe(`/api/network/agents/${addr}/unpublish`);

    const body = captured[1]!.body;
    const message = `AiFinPay-network-unpublish:polygon:${addr}:${TEST_NONCE}`;
    const ok = await verifyMessage({
      address: agent.evmAddress as `0x${string}`,
      message,
      signature: body.signature as `0x${string}`,
    });
    expect(ok).toBe(true);
  });
});

describe("AiFinPayAgent.search", () => {
  it("builds a capability query from a bare string and parses the agents array", async () => {
    const fixture = [
      {
        address: "0x000000000000000000000000000000000000dead",
        name: "Weather Oracle",
        description: null,
        endpoint: "https://w.example.com",
        capabilities: ["weather"],
        pricing: null,
        rating: null,
        published_at: 1_700_000_000,
        created_at: 1_700_000_000,
      },
    ];
    installMock(fixture);
    const agent = await AiFinPayAgent.new({ telemetry: false });

    const agents = await agent.search("weather");

    const u = new URL(captured[0]!.url);
    expect(u.pathname).toBe("/api/network/agents");
    expect(u.searchParams.get("capability")).toBe("weather");
    expect(agents).toHaveLength(1);
    expect(agents[0]!.name).toBe("Weather Oracle");
  });

  it("passes capability, q and limit from an options object", async () => {
    installMock([]);
    const agent = await AiFinPayAgent.new({ telemetry: false });

    await agent.search({ capability: "translate", q: "spanish", limit: 5 });

    const u = new URL(captured[0]!.url);
    expect(u.searchParams.get("capability")).toBe("translate");
    expect(u.searchParams.get("q")).toBe("spanish");
    expect(u.searchParams.get("limit")).toBe("5");
  });

  it("returns an empty array when the directory has no matches", async () => {
    installMock([]);
    const agent = await AiFinPayAgent.new({ telemetry: false });
    const agents = await agent.search("nonexistent");
    expect(agents).toEqual([]);
  });
});
