import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

// An agent that has just been given a wallet should be able to offer its owner
// the dashboard. agent_claim_self existed but was never registered, and
// agent_address told the agent payments were absent — so a tester's agent
// created a wallet, said nothing about the dashboard, and believed it could not pay.

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function connect() {
  const home = mkdtempSync(join(tmpdir(), "aifp-dash-"));
  dirs.push(home);
  const active = await createServer({ seedHash: "33".repeat(32), walletHome: home, logFn: () => {} });
  const client = new Client({ name: "dashboard-link-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await active.server.connect(right);
  await client.connect(left);
  return { client, close: async () => (await client.close(), await active.server.close()) };
}

describe("linking an agent to its owner's dashboard", () => {
  it("registers agent_claim_self, described by where the owner gets the URL", async () => {
    const { client, close } = await connect();
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === "agent_claim_self");
      expect(tool).toBeDefined();
      expect(tool?.description).toContain("https://dash.aifinpay.io");
      expect(tool?.description).toContain("My Agents");
      expect(tool?.annotations?.destructiveHint).toBe(false);
    } finally {
      await close();
    }
  });

  it("agent_address offers the dashboard and no longer says payments are absent", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({ name: "agent_address", arguments: {} });
      const text = JSON.stringify(result);
      expect(text).toContain("dash.aifinpay.io");
      expect(text).toContain("agent_claim_self");
      expect(text).toContain("payable_fetch");
      expect(text).not.toMatch(/intentionally absent/i);
    } finally {
      await close();
    }
  });

  it("refuses a claim URL on a host that is not AiFinPay, before any request", async () => {
    const { client, close } = await connect();
    try {
      const result = await client.callTool({
        name: "agent_claim_self",
        arguments: { magic_link_url: "https://evil.example/api/auth/verify?token=abc" },
      });
      expect(result.isError).toBe(true);
      expect(JSON.stringify(result)).toContain("not an allowed AiFinPay origin");
    } finally {
      await close();
    }
  });
});
