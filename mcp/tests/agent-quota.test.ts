// agent_quota — "how many requests do I have left" must be a number the
// developer can trust, which mostly means: honest about what it is NOT.
// The endpoint strips the bearer JWT server-side; this tool must never see
// or emit one, and `remaining` carries a caveat for self-metered merchants.
import { describe, it, expect } from "vitest";
import { runAgentQuota } from "../src/tools/agent-quota.js";
import type { ToolContext } from "../src/server.js";

const NOW = Math.floor(Date.now() / 1000);

function ctxWith(receipts: unknown[], opts: { status?: number } = {}) {
  const calls: string[] = [];
  const ctx = {
    agent: {
      evmAddress: "0x748DE415D6C197b0EA3cDe8c4e602eA05CeA8139",
      inner: {
        fetchImpl: (async (url: RequestInfo | URL) => {
          calls.push(String(url));
          return new Response(JSON.stringify({ receipts }), {
            status: opts.status ?? 200,
          });
        }) as typeof fetch,
      },
    },
    config: { baseUrl: "https://api.example.test" },
    log: () => {},
  } as unknown as ToolContext;
  return { ctx, calls };
}

const batch = (over: Record<string, unknown> = {}) => ({
  receipt_id: "rcpt_aaaaaaaaaaaaaaaa",
  merchant_id: "mrch_ratersapp",
  resource: "/api/ratings",
  tier: "standard",
  quota: 200,
  used: 50,
  remaining: 150,
  amount: "0.10",
  currency: "USD",
  exp: NOW + 3600,
  ...over,
});

function parse(result: { content: Array<{ text: string }> }) {
  return JSON.parse(result.content[0].text);
}

describe("agent_quota", () => {
  it("answers the founder's question: remaining per service, one line", async () => {
    const { ctx } = ctxWith([
      batch(),
      batch({ receipt_id: "rcpt_bbbbbbbbbbbbbbbb", remaining: 30, used: 170 }),
      batch({ receipt_id: "rcpt_cccccccccccccccc", merchant_id: "mrch_other", remaining: 5 }),
    ]);
    const out = parse(await runAgentQuota(ctx, {}));

    expect(out.totals.mrch_ratersapp).toEqual({ remaining: 180, batches: 2 });
    expect(out.totals.mrch_other).toEqual({ remaining: 5, batches: 1 });
    // Most spendable first — the number the developer is actually asking about.
    expect(out.batches[0].remaining).toBe(150);
  });

  it("filters to one merchant when asked about a specific service", async () => {
    const { ctx } = ctxWith([batch(), batch({ merchant_id: "mrch_other" })]);
    const out = parse(await runAgentQuota(ctx, { merchant_id: "mrch_other" }));

    expect(out.batches).toHaveLength(1);
    expect(out.batches[0].merchant_id).toBe("mrch_other");
    expect(out.totals.mrch_ratersapp).toBeUndefined();
  });

  it("drops expired and exhausted batches by default — they are not spendable", async () => {
    const { ctx } = ctxWith([
      batch({ exp: NOW - 10 }),
      batch({ receipt_id: "rcpt_dddddddddddddddd", remaining: 0, used: 200 }),
    ]);
    const out = parse(await runAgentQuota(ctx, {}));
    expect(out.batches).toHaveLength(0);
    expect(out.note).toContain("no active quota");
  });

  it("include_exhausted shows the spent-but-retained batches", async () => {
    const { ctx } = ctxWith([batch({ remaining: 0, used: 200 })]);
    const out = parse(await runAgentQuota(ctx, { include_exhausted: true }));
    expect(out.batches).toHaveLength(1);
    expect(out.batches[0].remaining).toBe(0);
  });

  it("NEVER emits a bearer JWT, even if the endpoint someday leaked one", async () => {
    // The server strips `receipt`; this pins that the tool would strip it too
    // rather than trusting the wire — a quota report must not be a credential.
    const { ctx } = ctxWith([{ ...batch(), receipt: "eyJhbGciOi.FAKE.JWT" }]);
    const out = await runAgentQuota(ctx, {});
    expect(out.content[0].text).not.toContain("eyJhbGciOi");
  });

  it("carries the honesty caveat about self-metered merchants", async () => {
    const { ctx } = ctxWith([batch()]);
    const out = parse(await runAgentQuota(ctx, {}));
    expect(out.note).toContain("meters locally");
  });

  it("asks the configured backend for THIS agent's address, nothing else", async () => {
    const { ctx, calls } = ctxWith([]);
    await runAgentQuota(ctx, {});
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      "https://api.example.test/v1/agents/0x748DE415D6C197b0EA3cDe8c4e602eA05CeA8139/receipts",
    );
  });

  it("a backend error is an error result, not an empty quota", async () => {
    // "You have nothing left" and "I could not check" are different answers,
    // and an agent that treats the second as the first stops paying merchants.
    const { ctx } = ctxWith([], { status: 503 });
    const out = await runAgentQuota(ctx, {});
    expect((out as { isError?: boolean }).isError).toBe(true);
  });
});
