import { afterEach, describe, expect, it, vi } from "vitest";
import { sendBatch, type Batch } from "../src/transport.js";

const batch: Batch = {
  schema_version: 1,
  install_id: "00000000-0000-4000-8000-000000000000",
  mode: "on",
  events: [{ name: "unified_call_succeeded", ts: 1792000000, payload: {} }],
};
const options = { url: "https://telemetry.example.com/v1/agent", timeoutMs: 50, maxRetries: 1 };

afterEach(() => vi.unstubAllGlobals());

describe("transport", () => {
  it("posts the batch with the schema/install/mode/user-agent headers and refuses redirects", async () => {
    const fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendBatch(batch, options)).toBe(true);
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(url).toBe(options.url);
    expect(init.method).toBe("POST");
    expect(init.redirect).toBe("error");
    expect(headers["AIFP-Telemetry-Schema"]).toBe("1");
    expect(headers["AIFP-Telemetry-Install"]).toBe(batch.install_id);
    expect(headers["AIFP-Telemetry-Mode"]).toBe("on");
    expect(headers["AIFP-Telemetry-User-Agent"]).toMatch(/^@aifinpay\/analytics\/\d+\.\d+\.\d+ /);
    expect(JSON.parse(init.body as string)).toEqual(batch);
  });

  it("retries once on a network error, then gives up without throwing", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    vi.stubGlobal("fetch", fetchMock);
    expect(await sendBatch(batch, options)).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries 429/5xx but never a 4xx", async () => {
    for (const [status, calls] of [
      [503, 2],
      [429, 2],
      [400, 1],
      [413, 1],
    ] as const) {
      const fetchMock = vi.fn(async () => new Response(null, { status }));
      vi.stubGlobal("fetch", fetchMock);
      expect(await sendBatch(batch, options)).toBe(false);
      expect(fetchMock).toHaveBeenCalledTimes(calls);
    }
  });

  it("times out a hung gateway", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        (_url: string, init: RequestInit) =>
          new Promise((_resolve, reject) =>
            init.signal?.addEventListener("abort", () => reject(new DOMException("timeout", "TimeoutError")))
          )
      )
    );
    const started = Date.now();
    expect(await sendBatch(batch, { ...options, maxRetries: 0 })).toBe(false);
    expect(Date.now() - started).toBeLessThan(1000);
  });
});
