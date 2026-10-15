import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Analytics = typeof import("../src/index.js");

let home: string;
let fetchMock: ReturnType<typeof vi.fn>;
const savedHome = process.env.HOME;

async function load(env: Record<string, string | undefined>): Promise<Analytics> {
  vi.resetModules();
  for (const [key, value] of Object.entries(env)) vi.stubEnv(key, value as string);
  return import("../src/index.js");
}

function sentBatches(): Array<{ install_id: string; mode: string; events: Array<{ name: string; ts: number }> }> {
  return fetchMock.mock.calls.map(([, init]) => JSON.parse((init as RequestInit).body as string));
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "aifp-emitter-"));
  process.env.HOME = home;
  fetchMock = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  process.env.HOME = savedHome;
  rmSync(home, { recursive: true, force: true });
});

describe("emitter", () => {
  it("is silent by default: no network, no file", async () => {
    const a = await load({ AIFINPAY_TELEMETRY: undefined });
    expect(a.isEnabled()).toBe(false);
    a.emit("unified_call_started", {});
    await a.shutdown();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(existsSync(join(home, ".aifinpay"))).toBe(false);
  });

  it("is synchronous for the caller and sends on a later microtask", async () => {
    const a = await load({ AIFINPAY_TELEMETRY: "on" });
    expect(a.emit("unified_call_started", { network: "polygon" })).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();
    await a.shutdown();
    const [batch] = sentBatches();
    expect(batch.mode).toBe("on");
    expect(batch.events[0].name).toBe("unified_call_started");
    expect(Number.isInteger(batch.events[0].ts)).toBe(true);
    expect(existsSync(join(home, ".aifinpay", ".telemetry-id"))).toBe(true);
  });

  it("drops unknown event names and sanitizes payloads", async () => {
    const a = await load({ AIFINPAY_TELEMETRY: "on" });
    a.emit("made_up_event", {});
    a.emit("settlement_execute_failed", { privateKey: "0xabc", url: "https://x.example.com/a/b?c=d" });
    await a.shutdown();
    const events = sentBatches().flatMap((b) => b.events) as Array<{ name: string; payload: unknown }>;
    expect(events.map((e) => e.name)).toEqual(["settlement_execute_failed"]);
    expect(events[0].payload).toEqual({ privateKey: "[redacted:field]", url: "https://x.example.com" });
  });

  it("splits into batches of at most 64 and drops beyond the 256-deep queue", async () => {
    const a = await load({ AIFINPAY_TELEMETRY: "on" });
    for (let i = 0; i < 300; i++) a.emit("aifp1_pay_succeeded", { i });
    await a.shutdown();
    const sizes = sentBatches().map((b) => b.events.length);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(a.MAX_BATCH);
    expect(sizes.reduce((x, y) => x + y, 0)).toBe(256);
  });

  it("drops an event larger than 4 KB", async () => {
    const a = await load({ AIFINPAY_TELEMETRY: "on" });
    const big = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`k${i}`, "x".repeat(250)]));
    a.emit("unified_call_failed", big);
    await a.shutdown();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("read-only sends but writes nothing to disk", async () => {
    const a = await load({ AIFINPAY_TELEMETRY: "read-only" });
    a.emit("agent_history_fetched", {});
    await a.shutdown();
    expect(sentBatches()[0].mode).toBe("read-only");
    expect(existsSync(join(home, ".aifinpay"))).toBe(false);
  });

  it("install mode sends only the install event; on mode never sends it", async () => {
    const install = await load({ AIFINPAY_TELEMETRY: "install" });
    install.emit("unified_call_started", {});
    install.emit("agent_sdk_install_completed", { os: "linux" });
    await install.shutdown();
    expect(sentBatches().flatMap((b) => b.events.map((e) => e.name))).toEqual(["agent_sdk_install_completed"]);

    fetchMock.mockClear();
    const on = await load({ AIFINPAY_TELEMETRY: "on" });
    on.emit("agent_sdk_install_completed", {});
    await on.shutdown();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("an invalid URL override disables sending", async () => {
    const a = await load({ AIFINPAY_TELEMETRY: "on", AIFINPAY_TELEMETRY_URL: "http://evil.example.com/" });
    expect(a.isEnabled()).toBe(false);
    a.emit("unified_call_started", {});
    await a.shutdown();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("never throws into the host, even when fetch does", async () => {
    fetchMock.mockImplementation(() => {
      throw new Error("boom");
    });
    const a = await load({ AIFINPAY_TELEMETRY: "on" });
    expect(() => a.emit("unified_call_started", {})).not.toThrow();
    await expect(a.shutdown()).resolves.toBeUndefined();
  });
});
