// A fresh install: `npx @aifinpay/mcp` with no wallet and no owner settings.
//
// This is the state the 2026-10-19 agent test started from. tools/list is
// pinned here as the exact inventory, so the two tools an agent needs first
// — payment_setup_status and payable_fetch — cannot silently drop out again.
// payable_fetch in this state must do exactly one thing: explain, without
// a single network request and without signing.

import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";

const dirs: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

async function freshInstall() {
  const home = mkdtempSync(join(tmpdir(), "aifp-mcp-fresh-"));
  dirs.push(home);
  const active = await createServer({ walletHome: home, logFn: () => {} });
  const client = new Client({ name: "fresh-install-test", version: "1" });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await active.server.connect(right);
  await client.connect(left);
  return {
    active,
    client,
    close: async () => {
      await client.close();
      await active.server.close();
    },
  };
}

describe("fresh install", () => {
  it("tools/list with no configuration", async () => {
    const f = await freshInstall();
    try {
      expect((await f.client.listTools()).tools.map((tool) => tool.name)).toEqual([
        "agent_address",
        "agent_claim_self",
        "agent_reload",
        "payment_setup_status",
        "payable_fetch",
        "agent_quota",
        "agent_history",
        "agent_passport_resolve",
        "settlement_routes",
        "settlement_invoice",
        "settlement_solana",
        "settlement_casper",
        "deployment_info",
      ]);
    } finally {
      await f.close();
    }
  });

  it("payable_fetch without configuration explains the setup and makes no request and no signature", async () => {
    const f = await freshInstall();
    const network = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network must not be used"));
    const signing = vi.spyOn(f.active.agent, "fetchPaid").mockRejectedValue(new Error("must not sign"));
    try {
      const result = await f.client.callTool({
        name: "payable_fetch",
        arguments: { url: "https://dev.ratersapp.com/api/agent/genres/list" },
      });
      expect(result.isError).toBe(true);
      const text = String((result.content as Array<{ text: string }>)[0].text);
      const status = JSON.parse(text);
      expect(status.error).toContain("nothing was signed or paid");
      expect(status.wallet).toEqual({ persistent: false, source: "ephemeral", evm_address: f.active.agent.evmAddress });
      expect(status.payments_enabled).toBe(false);
      expect(status.next_step).toContain("npx @aifinpay/mcp init");
      expect(network).not.toHaveBeenCalled();
      expect(signing).not.toHaveBeenCalled();
      // The same checklist, from the read-only tool.
      const direct = await f.client.callTool({ name: "payment_setup_status", arguments: {} });
      expect(direct.isError).not.toBe(true);
      const { error: _omitted, ...fromRefusal } = status;
      expect(JSON.parse(String((direct.content as Array<{ text: string }>)[0].text))).toEqual(fromRefusal);
      expect(network).not.toHaveBeenCalled();
    } finally {
      await f.close();
    }
  });
});
