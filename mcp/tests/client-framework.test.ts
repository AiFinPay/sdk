import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { clientFrameworkLine, frameworkForClient } from "../src/client-framework.js";

// Every request the server makes goes through safeFetch: record what the real
// agent puts on the wire there, and answer the merchant with free content so
// no quote, signature or chain is involved.
const requests = vi.hoisted(() => [] as Array<{ url: string; framework: string | null }>);
vi.mock("../src/safe-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/safe-fetch.js")>()),
  makeSafeFetch: () =>
    (async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), framework: new Headers(init?.headers).get("AIFP-Agent-Framework") });
      return new Response("content", { headers: { "content-type": "text/plain" } });
    }) as typeof fetch,
}));
const { createServer } = await import("../src/server.js");

describe("clientInfo.name → AIFP-Agent-Framework", () => {
  it.each([
    ["claude-ai", "claude"],
    ["claude-code", "claude"],
    ["cursor", "cursor"],
    ["cursor-vscode", "cursor"],
    ["windsurf", "windsurf"],
    ["chatgpt", "chatgpt"],
    ["openai", "chatgpt"],
    // openai/codex codex-rs/codex-mcp/src/rmcp_client.rs: Implementation::new("codex-mcp-client", …)
    ["codex-mcp-client", "codex"],
    ["gemini", "gemini"],
    ["perplexity", "perplexity"],
  ])("maps %s to %s", (name, framework) => {
    expect(frameworkForClient(name)).toBe(framework);
  });

  it("Codex is its own framework, not ChatGPT", () => {
    expect(frameworkForClient("codex-mcp-client")).not.toBe("chatgpt");
    expect(frameworkForClient("codex")).toBeUndefined();
  });

  it.each([
    ["codex-mcp-client", '[aifinpay-mcp] client "codex-mcp-client" → framework codex'],
    ["my-agent", '[aifinpay-mcp] client "my-agent" → framework none'],
    [undefined, "[aifinpay-mcp] client (unnamed) → framework none"],
  ])("the initialize log line for %j names the client and the framework", (name, line) => {
    expect(clientFrameworkLine(name)).toBe(line);
  });

  it.each(["my-agent", "Claude-AI", "claude", "claude-code ", "", "constructor", "__proto__", undefined, 7])(
    "sends nothing for an unknown client %j",
    (name) => {
      expect(frameworkForClient(name)).toBeUndefined();
    }
  );
});

describe("a connected client's name reaches the payment flow", () => {
  const dirs: string[] = [];
  afterEach(() => {
    requests.length = 0;
    logged.length = 0;
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });
  const origin = "https://merchant.example";

  const logged: string[] = [];
  async function payAs(clientName: string) {
    const home = mkdtempSync(join(tmpdir(), "aifp-framework-"));
    dirs.push(home);
    const active = await createServer({
      seedHash: "44".repeat(32),
      walletHome: home,
      logFn: (_level, msg) => logged.push(msg),
      paymentsEnabled: true,
      maxAmountUsd: 0.2,
      dailyAmountUsd: 0.3,
      maxGasPol: "0.05",
      gatewayOrigins: [origin],
      gatewayPathMode: "direct",
    });
    const client = new Client({ name: clientName, version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await active.server.connect(right);
    await client.connect(left);
    try {
      const result = await client.callTool({ name: "payable_fetch", arguments: { url: `${origin}/data` } });
      expect(result.isError).not.toBe(true);
    } finally {
      await client.close();
      await active.server.close();
    }
  }

  it("sends the mapped framework on the merchant request", async () => {
    await payAs("claude-code");
    expect(requests).toEqual([{ url: `${origin}/data`, framework: "claude" }]);
    expect(logged).toContain('[aifinpay-mcp] client "claude-code" → framework claude');
  });

  // Needs @aifinpay/agent 2.9.0 (the first with "codex" in AGENT_FRAMEWORKS):
  // against the registry 2.8.0 the agent refuses the value before any request.
  it("a Codex client pays as codex", async () => {
    await payAs("codex-mcp-client");
    expect(requests).toEqual([{ url: `${origin}/data`, framework: "codex" }]);
    expect(logged).toContain('[aifinpay-mcp] client "codex-mcp-client" → framework codex');
  });

  it("sends no header for a client outside the table, and logs the name it received", async () => {
    await payAs("my-agent");
    expect(requests).toEqual([{ url: `${origin}/data`, framework: null }]);
    expect(logged).toContain('[aifinpay-mcp] client "my-agent" → framework none');
  });
});
