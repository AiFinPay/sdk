// Directory profile — the surface submitted to the OpenAI ChatGPT App
// Directory. OpenAI reviews it as a read-only app, so the tool list is a
// contract: exactly these nine tools, every one read-only, no payment tool.
import { afterEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createDirectoryServer } from "../src/index.js";

const DIRECTORY_TOOLS = [
  "agent_profile",
  "leaderboard",
  "list_providers",
  "network_stats",
  "provider_info",
  "provider_status",
  "quote_cost",
  "service_coverage",
  "verify_passport",
];

async function connect() {
  const { server } = await createDirectoryServer({ apiBase: "https://api.example.test", log: () => {} });
  const client = new Client({ name: "directory-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(left), client.connect(right)]);
  return client;
}

function stubFetch(body: unknown = { ok: true }, status = 200) {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: RequestInfo | URL) => {
      calls.push(String(url));
      return new Response(JSON.stringify(body), { status });
    })
  );
  return calls;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createDirectoryServer", () => {
  it("lists exactly the nine read-only directory tools", async () => {
    const client = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(DIRECTORY_TOOLS);
    for (const tool of tools) {
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(true);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(false);
      expect(tool.outputSchema, tool.name).toBeDefined();
    }
  });

  it("states the read-only contract in its instructions", async () => {
    const client = await connect();
    expect(client.getInstructions()).toContain("does NOT move money");
  });

  it("wraps a public GET and returns structuredContent", async () => {
    const calls = stubFetch({ providers: [{ name: "exa" }] });
    const client = await connect();
    const res = await client.callTool({ name: "list_providers", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toEqual({ providers: [{ name: "exa" }] });
    expect(calls).toEqual(["https://api.example.test/providers"]);
  });

  it("encodes path arguments instead of letting them change the route", async () => {
    const calls = stubFetch({});
    const client = await connect();
    await client.callTool({ name: "provider_info", arguments: { name: "../admin?x=1" } });
    expect(calls).toEqual(["https://api.example.test/providers/..%2Fadmin%3Fx%3D1"]);
  });

  it("maps quote_cost to the quote-split units of each chain and asset", async () => {
    const calls = stubFetch({});
    const client = await connect();
    await client.callTool({ name: "quote_cost", arguments: { chain: "solana", amount: "1000" } });
    await client.callTool({ name: "quote_cost", arguments: { chain: "polygon", amount: "2000", asset: "usdc" } });
    await client.callTool({ name: "quote_cost", arguments: { chain: "polygon", amount: "3000" } });
    expect(calls).toEqual([
      "https://api.example.test/b2b/quote-split?merchant_amount_lamports=1000",
      "https://api.example.test/b2b/quote-split?merchant_amount_units=2000&asset=USDC",
      "https://api.example.test/b2b/quote-split?merchant_amount_wei=3000",
    ]);
  });

  it("refuses an unknown chain without calling upstream", async () => {
    const calls = stubFetch({});
    const client = await connect();
    const res = await client.callTool({ name: "quote_cost", arguments: { chain: "base", amount: "1" } });
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });

  it("reports an upstream error as a tool error", async () => {
    stubFetch({ error: "nope" }, 503);
    const client = await connect();
    const res = await client.callTool({ name: "network_stats", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("upstream 503");
  });

  it("refuses a tool outside the directory set, such as payable_fetch", async () => {
    const calls = stubFetch({});
    const client = await connect();
    const res = await client.callTool({ name: "payable_fetch", arguments: { url: "https://example.test" } });
    expect(res.isError).toBe(true);
    expect(calls).toEqual([]);
  });
});
