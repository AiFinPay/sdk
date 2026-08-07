import { describe, expect, it, vi } from "vitest";
import { runAgentCall } from "../src/tools/agent-call.js";
import { runPayableFetch } from "../src/tools/payable-fetch.js";
import type { ToolContext } from "../src/server.js";

function makeCtx(maxAmountUsd?: number) {
  const call = vi.fn(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  const pay = vi.fn(async () => new Response("ok", { status: 200 }));

  const ctx = {
    config: { maxAmountUsd },
    log: vi.fn(),
    agent: {
      call,
      inner: { pay },
      evmAddress: "0x0000000000000000000000000000000000000001",
      solanaAddress: "11111111111111111111111111111111",
    },
  } as unknown as ToolContext;

  return { ctx, call, pay };
}

describe("mandatory operator spend cap", () => {
  it("refuses every MCP tool that can autonomously broadcast payment when no positive cap is configured", async () => {
    const { ctx, call, pay } = makeCtx(undefined);

    const agentCall = await runAgentCall(ctx, { provider: "exa" });
    const payableFetch = await runPayableFetch(ctx, { url: "https://example.com/paid" });

    expect(agentCall.isError).toBe(true);
    expect(payableFetch.isError).toBe(true);
    expect(call).not.toHaveBeenCalled();
    expect(pay).not.toHaveBeenCalled();
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])(
    "fails closed for invalid operator cap %s",
    async (cap) => {
      const { ctx, call, pay } = makeCtx(cap);
      expect((await runAgentCall(ctx, { provider: "exa" })).isError).toBe(true);
      expect((await runPayableFetch(ctx, { url: "https://example.com/paid" })).isError).toBe(true);
      expect(call).not.toHaveBeenCalled();
      expect(pay).not.toHaveBeenCalled();
    },
  );

  it("agent_call uses the operator cap when the model omits cost", async () => {
    const { ctx, call } = makeCtx(0.25);
    await runAgentCall(ctx, { provider: "exa" });

    expect(call).toHaveBeenCalledTimes(1);
    expect(call.mock.calls[0]?.[0]).toMatchObject({ cost: 0.25 });
  });

  it("agent_call lets model input tighten but never widen the operator cap", async () => {
    const tighter = makeCtx(0.25);
    await runAgentCall(tighter.ctx, { provider: "exa", cost: 0.1 });
    expect(tighter.call.mock.calls[0]?.[0]).toMatchObject({ cost: 0.1 });

    const wider = makeCtx(0.25);
    await runAgentCall(wider.ctx, { provider: "exa", cost: 100 });
    expect(wider.call.mock.calls[0]?.[0]).toMatchObject({ cost: 0.25 });
  });

  it("payable_fetch lets model input tighten but never widen the operator cap", async () => {
    const tighter = makeCtx(0.25);
    await runPayableFetch(tighter.ctx, {
      url: "https://example.com/paid",
      max_amount_usd: 0.1,
    });
    expect(tighter.pay.mock.calls[0]?.[1]).toMatchObject({ options: { maxAmountUsd: 0.1 } });

    const wider = makeCtx(0.25);
    await runPayableFetch(wider.ctx, {
      url: "https://example.com/paid",
      max_amount_usd: 100,
    });
    expect(wider.pay.mock.calls[0]?.[1]).toMatchObject({ options: { maxAmountUsd: 0.25 } });
  });
});
