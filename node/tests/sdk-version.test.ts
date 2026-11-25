// The SDK names its exact version on every request to the AiFinPay API.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { Agent, SDK_USER_AGENT, SDK_VERSION, getAgentHistory, getQuota, resolveAgentPassport } from "../src/index.js";

function recording() {
  const agents: string[] = [];
  const fetchImpl = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    agents.push(new Headers(init?.headers).get("User-Agent") ?? "");
    return Response.json({ error: "not_found" }, { status: 404 });
  }) as typeof fetch;
  return { agents, fetchImpl };
}

describe("SDK version", () => {
  it("equals the package manifest", () => {
    const manifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(SDK_VERSION).toBe(manifest.version);
    expect(SDK_USER_AGENT).toBe(`aifinpay-agent-node/${manifest.version}`);
  });

  it("is the User-Agent of the low-level Agent", async () => {
    const { agents, fetchImpl } = recording();
    const agent = Agent.new({ baseUrl: "https://aifinpay.io", fetchImpl });
    await agent.manifesto().catch(() => {});
    await agent.pay("https://aifinpay.io/v1/data").catch(() => {});
    expect(agents).toEqual([SDK_USER_AGENT, SDK_USER_AGENT]);
  });

  it("is the User-Agent of history, quota and passport lookups", async () => {
    const { agents, fetchImpl } = recording();
    const address = "0x" + "12".repeat(20);
    await expect(getAgentHistory({ address, fetchImpl })).rejects.toThrow();
    await expect(getQuota({ address, fetchImpl })).rejects.toThrow();
    await expect(resolveAgentPassport("@someone", "https://aifinpay.io", fetchImpl)).rejects.toThrow();
    expect(agents).toEqual([SDK_USER_AGENT, SDK_USER_AGENT, SDK_USER_AGENT]);
  });
});
