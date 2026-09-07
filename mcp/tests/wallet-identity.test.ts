import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { AiFinPayAgent } from "@aifinpay/agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadWalletIdentity } from "../src/identity.js";
import { createServer } from "../src/server.js";

const dirs: string[] = [];
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "aifp-identity-")); dirs.push(home);
  const agentsFile = join(home, "agents.json");
  const seedA = randomBytes(32).toString("hex"), seedB = randomBytes(32).toString("hex");
  const write = (agents: unknown[]) => writeFileSync(agentsFile, JSON.stringify({ agents }));
  return { home, agentsFile, seedA, seedB, write };
}
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("persistent identity selection", () => {
  it("SEED_HASH wins over file and legacy env; file wins over legacy env", () => {
    const f = fixture(); f.write([{ id: "one", seed_hash: f.seedB }]);
    expect(loadWalletIdentity({ seedHash: f.seedA, agentsFile: f.agentsFile, agentSecretB58: "ignored" }))
      .toEqual({ source: "SEED_HASH", seedHash: f.seedA });
    expect(loadWalletIdentity({ agentsFile: f.agentsFile, agentSecretB58: "ignored" }))
      .toEqual({ source: "agents.json", seedHash: f.seedB });
  });
  it("does not fall through malformed seeds/files or ambiguous selection", () => {
    const f = fixture(); f.write([{ id: "one", seed_hash: f.seedA }, { id: "two", seed_hash: f.seedB }]);
    expect(() => loadWalletIdentity({ seedHash: "bad", agentsFile: f.agentsFile })).toThrow(/32-byte/);
    expect(() => loadWalletIdentity({ agentsFile: f.agentsFile })).toThrow(/exactly one/);
    expect(loadWalletIdentity({ agentsFile: f.agentsFile, agentId: "two" })?.seedHash).toBe(f.seedB);
    writeFileSync(f.agentsFile, "broken secret JSON");
    expect(() => loadWalletIdentity({ agentsFile: f.agentsFile })).toThrow(/Cannot read/);
  });
  it("keeps the SDK's exact derivation and reloads files within one MCP connection", async () => {
    const f = fixture(); f.write([{ id: "one", seed_hash: f.seedA }]);
    const expectedA = await AiFinPayAgent.fromSeed(f.seedA);
    const expectedB = await AiFinPayAgent.fromSeed(f.seedB);
    const active = await createServer({ agentsFile: f.agentsFile, logFn: () => {} });
    const client = new Client({ name: "identity-test", version: "1" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await active.server.connect(serverTransport); await client.connect(clientTransport);
    try {
      expect(active.agent.evmAddress).toBe(expectedA.evmAddress);
      f.write([{ id: "one", seed_hash: f.seedB }]);
      const loaded = await client.callTool({ name: "agent_reload", arguments: {} });
      expect(loaded.isError).not.toBe(true);
      expect(JSON.stringify(loaded)).toContain(expectedB.evmAddress);
      expect(JSON.stringify(loaded)).not.toContain(f.seedB);
      expect(active.agent.solanaAddress).toBe(expectedB.solanaAddress);
      const address = await client.callTool({ name: "agent_address", arguments: {} });
      expect(JSON.stringify(address)).toContain(expectedB.evmAddress);
      writeFileSync(f.agentsFile, "broken");
      expect((await client.callTool({ name: "agent_reload", arguments: {} })).isError).toBe(true);
      expect(active.agent.evmAddress).toBe(expectedB.evmAddress);
    } finally { await client.close(); await active.server.close(); }
  });
});

it('ships the skill as an MCP resource and lists only implemented tools', async () => {
  const f = fixture(); f.write([{ id: 'one', seed_hash: f.seedA }]);
  const active = await createServer({ agentsFile: f.agentsFile, logFn: () => {} });
  const client = new Client({ name: 'skill-test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await active.server.connect(right); await client.connect(left);
  try {
    const names = (await client.listTools()).tools.map(tool => tool.name);
    expect(names).toContain('agent_history');
    expect(names).toContain('agent_reload');
    expect(names).not.toContain('payable_fetch');
    expect(names).not.toContain('dev_payment_quote');
    const resource = await client.readResource({ uri: 'aifinpay://skill' });
    expect(resource.contents[0].text).toContain('/v1/agents/:address/transactions');
    expect(resource.contents[0].text).toContain('SEED_HASH');
    expect(resource.contents[0].text).toBe(readFileSync(new URL('../../skills/SKILL.md', import.meta.url), 'utf8'));
    expect((await client.listResources()).resources[0].uri).toBe('aifinpay://skill');
  } finally { await client.close(); await active.server.close(); }
});

it('init honors the selected seed without creating a different legacy wallet or printing the seed', () => {
  const f = fixture();
  const bin = fileURLToPath(new URL('../bin/aifinpay-mcp.js', import.meta.url));
  const result = spawnSync(process.execPath, [bin, 'init'], { encoding: 'utf8',
    env: { ...process.env, SEED_HASH: f.seedA, AIFINPAY_HOME: f.home }, timeout: 10000 });
  expect(result.status).toBe(0);
  expect(result.stdout).toContain('Using SEED_HASH');
  expect(result.stdout + result.stderr).not.toContain(f.seedA);
  expect(existsSync(join(f.home, 'agent.json'))).toBe(false);
});
