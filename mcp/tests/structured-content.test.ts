import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

// The MCP client refuses a tool that declares outputSchema and answers without
// structuredContent; Claude Desktop showed every agent_quota call as failed.
vi.mock("../src/safe-fetch.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/safe-fetch.js")>()),
  makeSafeFetch: () => (async () => Response.json({ receipts: [] })) as typeof fetch,
}));
const { createServer } = await import("../src/server.js");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function connect() {
  const home = mkdtempSync(join(tmpdir(), "aifp-structured-"));
  dirs.push(home);
  const active = await createServer({ seedHash: "44".repeat(32), walletHome: home, logFn: () => {} });
  const client = new Client({ name: "structured-content-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await active.server.connect(right);
  await client.connect(left);
  return { client, close: async () => (await client.close(), await active.server.close()) };
}

const invoice = { route_class: "AIFP-1", gross_amount: "1000000", order_id: "order-1" };
const CALLS: Record<string, Record<string, unknown>> = {
  agent_address: {},
  agent_quota: {},
  agent_passport_resolve: { identifier: "@demo" },
  settlement_routes: {},
  settlement_invoice: { ...invoice, chain: "polygon", asset: "USDC", merchant_wallet: "0x" + "ab".repeat(20) },
  settlement_solana: { ...invoice, chain: "solana", asset: "USDC", merchant_wallet: "1".repeat(32) },
  settlement_casper: { ...invoice, chain: "casper", asset: "CSPR", merchant_wallet: "account-hash-" + "a".repeat(64) },
};

describe("where an agent gets a price", () => {
  it("from funding and the 402 of the exact URL, never the merchant's site or web search", async () => {
    const { client, close } = await connect();
    try {
      const instructions = client.getInstructions() ?? "";
      expect(instructions).toContain("funding.amount from payment_setup_status");
      expect(instructions).toContain("AIFP-1 402 of that exact URL");
      expect(instructions).toMatch(/never from browsing the merchant's site or searching the web/);
      expect(instructions).toMatch(/ask the user/);
      const tools = (await client.listTools()).tools;
      const description = (name: string) => tools.find((tool) => tool.name === name)?.description ?? "";
      expect(description("payment_setup_status")).toMatch(/endpoint URL from the user/);
      expect(description("payable_fetch")).toMatch(/ask the user for it instead of browsing the site/);
    } finally {
      await close();
    }
  });
});

describe("tools with an outputSchema", () => {
  it("agent_quota with no batches returns an empty list the client accepts", async () => {
    const { client, close } = await connect();
    try {
      await client.listTools();
      const result = await client.callTool({ name: "agent_quota", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(result.structuredContent).toMatchObject({ batches: [], totals: {} });
    } finally {
      await close();
    }
  });

  it("every one answers a successful call with structuredContent", async () => {
    const { client, close } = await connect();
    try {
      const declared = (await client.listTools()).tools.filter((tool) => tool.outputSchema).map((tool) => tool.name);
      // agent_claim_self needs a claim exchange: claim-self-family.test.ts covers it.
      expect(declared.filter((name) => name !== "agent_claim_self").sort()).toEqual(Object.keys(CALLS).sort());
      for (const [name, args] of Object.entries(CALLS)) {
        const result = await client.callTool({ name, arguments: args });
        expect(result.isError, name).toBeFalsy();
        expect(result.structuredContent, name).toBeTypeOf("object");
      }
    } finally {
      await close();
    }
  });
});
