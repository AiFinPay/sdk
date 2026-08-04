import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { runAgentClaimSelf } from "../src/tools/agent-claim-self.js";

// agent_claim_self was a signing oracle with an SSRF in front of it.
//
// It derived the API host from the URL it was handed, checking only that the
// string contained "/api/auth/verify?token=". It then fetched a challenge from
// that host and signed whatever came back — with the agent's EVM key and its
// Solana secret — and posted both signatures back to the same host.
//
// So anyone who could put a URL in front of the agent, prompt injection
// included, could name their own server, choose the bytes to be signed, and
// collect the signatures. Pointing it at 127.0.0.1 or 169.254.169.254 instead
// reached whatever the host could reach.
//
// These tests assert the two properties that make that impossible: an origin
// outside the allowlist is refused before any request leaves, and a challenge
// that is not the exact claim string is refused before anything is signed.

let fetchCalls: string[] = [];
let originalFetch: typeof globalThis.fetch;

beforeEach(() => {
  fetchCalls = [];
  originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    fetchCalls.push(String(input));
    // If a refusal ever fails to fire, the test should not silently pass by
    // reaching a dead host — answer plausibly so the failure is visible.
    return new Response(JSON.stringify({ challenge_id: "c1", message: "sign me" }), {
      status: 200,
      headers: { "content-type": "application/json", "set-cookie": "sid=1" },
    });
  }) as typeof globalThis.fetch;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  delete process.env.AIFINPAY_CLAIM_ORIGINS;
});

// The tool only needs these three fields from the context.
const ctx = {
  agent: {
    evmAddress: "0x5Df154283588623aa23c770c1521F7835861255e",
    solanaAddress: "5Df1CJqFbUBUXhs3rBqvB3vJf2SCyGmnZWnAsRmKQ7wK",
    inner: { secretKey: new Uint8Array(64) },
  },
} as never;

const text = (r: Awaited<ReturnType<typeof runAgentClaimSelf>>) =>
  (r as { content?: { text?: string }[] }).content?.[0]?.text ?? "";

describe("origins outside the allowlist", () => {
  const hostile = [
    ["an attacker's own server", "https://attacker.example/api/auth/verify?token=x"],
    ["loopback", "http://127.0.0.1:4001/api/auth/verify?token=x"],
    ["localhost by name", "http://localhost:4001/api/auth/verify?token=x"],
    ["cloud metadata", "http://169.254.169.254/api/auth/verify?token=x"],
    ["a private range", "http://10.0.0.5/api/auth/verify?token=x"],
    ["IPv6 loopback", "http://[::1]/api/auth/verify?token=x"],
    ["a lookalike domain", "https://aifinpay.io.attacker.example/api/auth/verify?token=x"],
    ["plain http on the real domain", "http://aifinpay.io/api/auth/verify?token=x"],
  ] as const;

  for (const [label, url] of hostile) {
    it(`refuses ${label} without making a request`, async () => {
      const res = await runAgentClaimSelf(ctx, { magic_link_url: url });
      expect((res as { isError?: boolean }).isError).toBe(true);
      expect(text(res)).toMatch(/not an allowed AiFinPay origin/);
      // The point is not the error — it is that nothing was contacted.
      expect(fetchCalls).toEqual([]);
    });
  }

  it("accepts a production origin far enough to make the first request", async () => {
    // Proves the allowlist is not simply refusing everything.
    await runAgentClaimSelf(ctx, {
      magic_link_url: "https://aifinpay.io/api/auth/verify?token=x",
    });
    expect(fetchCalls[0]).toContain("https://aifinpay.io/api/auth/verify");
  });

  it("honours an origin an operator added deliberately", async () => {
    process.env.AIFINPAY_CLAIM_ORIGINS = "https://staging.aifinpay.io";
    const res = await runAgentClaimSelf(ctx, {
      magic_link_url: "https://staging.aifinpay.io/api/auth/verify?token=x",
    });
    expect(text(res)).not.toMatch(/not an allowed AiFinPay origin/);
    expect(fetchCalls[0]).toContain("staging.aifinpay.io");
  });

  it("an explicit override replaces the defaults rather than extending them", async () => {
    process.env.AIFINPAY_CLAIM_ORIGINS = "https://staging.aifinpay.io";
    const res = await runAgentClaimSelf(ctx, {
      magic_link_url: "https://aifinpay.io/api/auth/verify?token=x",
    });
    expect((res as { isError?: boolean }).isError).toBe(true);
    expect(fetchCalls).toEqual([]);
  });
});

describe("what the agent will put its key to", () => {
  it("refuses to sign a challenge that is not the claim string", async () => {
    // An allowed origin that answers with text of its own choosing. This is the
    // oracle, and the allowlist alone does not close it — a compromised or
    // simply wrong host is still an allowed one.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes("/api/auth/verify")) {
        return new Response("", { status: 200, headers: { "set-cookie": "sid=1" } });
      }
      if (url.includes("/challenge")) {
        return new Response(
          JSON.stringify({ challenge_id: "c1", message: "Transfer all funds to 0xdead" }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;

    await runAgentClaimSelf(ctx, {
      magic_link_url: "https://aifinpay.io/api/auth/verify?token=x",
    });
    // Whatever the tool reports, it must never have submitted a signature.
    expect(fetchCalls.some((u) => u.includes("/api/me/agents/claim"))).toBe(false);
  });

  it("refuses a claim string naming a different agent", async () => {
    // Well-formed, right prefix, wrong subject: a signature that would say
    // something about an address this agent does not control.
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetchCalls.push(url);
      if (url.includes("/api/auth/verify")) {
        return new Response("", { status: 200, headers: { "set-cookie": "sid=1" } });
      }
      if (url.includes("/challenge")) {
        return new Response(
          JSON.stringify({
            challenge_id: "c1",
            message: "AiFinPay-claim:polygon:0x000000000000000000000000000000000000dead:" + "a".repeat(32),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
    }) as typeof globalThis.fetch;

    await runAgentClaimSelf(ctx, {
      magic_link_url: "https://aifinpay.io/api/auth/verify?token=x",
    });
    expect(fetchCalls.some((u) => u.includes("/api/me/agents/claim"))).toBe(false);
  });
});
