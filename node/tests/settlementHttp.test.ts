import { describe, expect, it, vi } from "vitest";
import { settlementHttp } from "../src/settlementHttp.js";

describe("bounded payment API transport", () => {
  it("bounds a stalled response body even if fetch ignores abort", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    await expect(settlementHttp(fetchImpl, "https://api.aifinpay.io/v1/pay", { method: "POST" }, 10)).rejects.toThrow(/timed out/);
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("bounds a transport that never resolves or honors AbortSignal", async () => {
    await expect(settlementHttp(() => new Promise(() => {}), "https://api.aifinpay.io/v1/quote", {}, 10)).rejects.toThrow(/timed out/);
  });

  it("refuses redirect responses and never follows signed POSTs", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://other.invalid" } }));
    await expect(settlementHttp(fetchImpl, "https://api.aifinpay.io/v1/pay", { method: "POST", body: "synthetic-proof" })).rejects.toThrow(/redirect/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("error");
  });

  it("rejects an oversized body instead of buffering without a limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("x".repeat(1_048_577)));
    await expect(settlementHttp(fetchImpl, "https://api.aifinpay.io/v1/quote")).rejects.toThrow(/limit/);
  });
});
