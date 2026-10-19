// AIFP-Agent-Framework on the low-level Agent: every request that carries the
// SDK user-agent also names the configured AI client, and nothing is guessed
// when none is configured. The fetchPaid (AIFP-1) flow is covered in aifp1.test.ts.
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Agent, AiFinPayAgent, AiFinPayError, AGENT_FRAMEWORKS } from "../src/index.js";

const challenge = {
  protocol: "AiFinPay v5.3",
  agreement_hash: "test",
  treasury_vault: "test",
  "x-nonce": "nonce-issued-by-the-server",
  "x-nonce-expires-at": String(Date.now() + 60_000),
  "x-aifinpay-auth-version": 2,
  "x-aifinpay-body-sha256": createHash("sha256").update("").digest("hex"),
};

function recordingAgent(opts: Record<string, unknown> = {}) {
  const seen: Array<{ url: string; framework: string | null }> = [];
  const agent = Agent.new({
    baseUrl: "https://aifinpay.io",
    ...opts,
    fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input).split("?")[0];
      seen.push({ url, framework: new Headers(init?.headers).get("AIFP-Agent-Framework") });
      if (url === "https://aifinpay.io/v1/data" && seen.length === 1) return Response.json(challenge, { status: 402 });
      return Response.json({ ok: true });
    }) as typeof fetch,
  });
  return { agent, seen };
}

async function everyRequest(agent: Agent) {
  await agent.pay("https://aifinpay.io/v1/data");
  await agent.manifesto();
  await agent.quoteSplit({ chain: "polygon", merchantAmount: 1 });
  await agent.payWithSplitInvoice({ chain: "polygon", merchantWallet: "0x1", merchantAmount: 1, orderId: "o1" });
}

describe("Agent framework option", () => {
  it("accepts exactly the values the backend records", () => {
    expect([...AGENT_FRAMEWORKS]).toEqual([
      "chatgpt",
      "claude",
      "perplexity",
      "gemini",
      "cursor",
      "openai-agents",
      "windsurf",
      "custom",
    ]);
    for (const framework of AGENT_FRAMEWORKS) expect(Agent.new({ framework }).framework).toBe(framework);
  });

  it("sends AIFP-Agent-Framework on the 402 probe, the paid retry and every other SDK request", async () => {
    const { agent, seen } = recordingAgent({ framework: "openai-agents" });
    await everyRequest(agent);
    expect(seen.map((r) => r.url)).toEqual([
      "https://aifinpay.io/v1/data",
      "https://aifinpay.io/v1/data",
      "https://aifinpay.io/manifesto.json",
      "https://aifinpay.io/api/b2b/quote-split",
      "https://aifinpay.io/api/b2b/pay-with-split",
    ]);
    expect(seen.every((r) => r.framework === "openai-agents")).toBe(true);
  });

  it("replaces a caller's own copy instead of sending two values", async () => {
    const { agent, seen } = recordingAgent({ framework: "gemini" });
    await agent.pay("https://aifinpay.io/v1/data", { headers: new Headers({ "AIFP-Agent-Framework": "custom" }) });
    expect(seen.map((r) => r.framework)).toEqual(["gemini", "gemini"]);
  });

  it("sends no header when not configured", async () => {
    const { agent, seen } = recordingAgent();
    expect(agent.framework).toBeUndefined();
    await everyRequest(agent);
    expect(seen).toHaveLength(5);
    expect(seen.every((r) => r.framework === null)).toBe(true);
  });

  it.each(["ChatGPT", "claude-code", "openai", " claude", "", 1, null])(
    "refuses %j with a clear error",
    (framework) => {
      expect(() => Agent.new({ framework: framework as unknown as "claude" })).toThrow(AiFinPayError);
      expect(() => Agent.new({ framework: framework as unknown as "claude" })).toThrow(
        "framework must be one of chatgpt, claude, perplexity, gemini, cursor, openai-agents, windsurf, custom"
      );
    }
  );

  it("is refused by every AiFinPayAgent constructor before any request", async () => {
    const bad = { framework: "gpt" as unknown as "claude", telemetry: false };
    await expect(AiFinPayAgent.new(bad)).rejects.toThrow(/framework must be one of/);
    await expect(AiFinPayAgent.fromSeed("11".repeat(32), bad)).rejects.toThrow(/framework must be one of/);
    const secret = (await AiFinPayAgent.fromSeed("11".repeat(32))).inner.secretB58;
    await expect(AiFinPayAgent.fromSolanaSecret(secret, bad)).rejects.toThrow(/framework must be one of/);
    expect((await AiFinPayAgent.fromSeed("11".repeat(32), { framework: "perplexity" })).inner.framework).toBe(
      "perplexity"
    );
  });
});
