import { describe, expect, it, vi } from "vitest";
import { settlementHttp } from "../src/settlementHttp.js";

describe("bounded payment API transport", () => {
  it("bounds a stalled response body even if fetch ignores abort", async () => {
    const cancel = vi.fn();
    const fetchImpl = vi.fn().mockResolvedValue(new Response(new ReadableStream({ cancel })));
    await expect(settlementHttp(fetchImpl, "https://api.aifinpay.io/v1/pay", { method: "POST" }, 10)).rejects.toThrow(
      /timed out/
    );
    expect(cancel).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1].signal.aborted).toBe(true);
  });

  it("bounds a transport that never resolves or honors AbortSignal", async () => {
    await expect(
      settlementHttp(() => new Promise(() => {}), "https://api.aifinpay.io/v1/quote", {}, 10)
    ).rejects.toThrow(/timed out/);
  });

  it("refuses redirect responses and never follows signed POSTs", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValue(new Response(null, { status: 307, headers: { location: "https://other.invalid" } }));
    await expect(
      settlementHttp(fetchImpl, "https://api.aifinpay.io/v1/pay", {
        method: "POST",
        body: "synthetic-proof",
      })
    ).rejects.toThrow(/redirect/);
    expect(fetchImpl).toHaveBeenCalledOnce();
    expect(fetchImpl.mock.calls[0][1].redirect).toBe("error");
  });

  it("accepts a URL without a path, which fetch reports with a trailing slash", async () => {
    const answer = (url: string) => {
      const response = new Response('{"result":"ok"}');
      Object.defineProperty(response, "url", { value: url });
      return response;
    };
    const ok = vi.fn().mockResolvedValue(answer("https://api.devnet.solana.com/"));
    await expect(settlementHttp(ok, "https://api.devnet.solana.com", { method: "POST" })).resolves.toMatchObject({
      text: '{"result":"ok"}',
    });
    const moved = vi.fn().mockResolvedValue(answer("https://other.invalid/"));
    await expect(settlementHttp(moved, "https://api.devnet.solana.com", { method: "POST" })).rejects.toMatchObject({
      code: "redirect_refused",
    });
  });

  it("rejects an oversized body instead of buffering without a limit", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response("x".repeat(1_048_577)));
    await expect(settlementHttp(fetchImpl, "https://api.aifinpay.io/v1/quote")).rejects.toThrow(/limit/);
  });
});
