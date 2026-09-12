import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
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
import { loadConfigFromEnv } from "../src/config.js";

const dirs: string[] = [];
const seedA = "11".repeat(32), seedB = "22".repeat(32);
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "aifp-identity-")); dirs.push(home);
  const agentsFile = join(home, "agents.json");
  const write = (agents: unknown[]) => writeFileSync(agentsFile, JSON.stringify({ agents }), { mode: 0o600 });
  return { home, agentsFile, write };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persistent wallet identity", () => {
  it("reads SEED_HASH from the process configuration", () => {
    vi.stubEnv("SEED_HASH", seedA);
    expect(loadConfigFromEnv()).toMatchObject({ seedHash: seedA });
  });

  it("keeps SEED_HASH stable on restart and prioritizes it over file and legacy secret", async () => {
    const f = fixture(); f.write([{ id: "one", seed_hash: seedB }]);
    const expected = await AiFinPayAgent.fromSeed(seedA);
    const legacy = await AiFinPayAgent.fromSeed(seedB);
    const secret = (legacy as unknown as { inner: { secretB58: string } }).inner.secretB58;
    for (const config of [
      { seedHash: seedA, walletHome: f.home },
      { seedHash: seedA, agentsFile: f.agentsFile, agentSecretB58: secret },
    ]) {
      for (let restart = 0; restart < 2; restart++) {
        const active = await createServer({ ...config, logFn: () => {} });
        try { expect(active.agent.evmAddress).toBe(expected.evmAddress); }
        finally { await active.server.close(); }
      }
    }
  });

  it("loads the selected project agent before the legacy secret and fails on ambiguous or malformed files", async () => {
    const f = fixture(); f.write([{ id: "one", seed_hash: seedA }, { id: "two", seed_hash: seedB }]);
    const legacy = await AiFinPayAgent.fromSeed(seedA);
    const secret = (legacy as unknown as { inner: { secretB58: string } }).inner.secretB58;
    const active = await createServer({ agentsFile: f.agentsFile, agentId: "two", agentSecretB58: secret, logFn: () => {} });
    try { expect(active.agent.evmAddress).toBe((await AiFinPayAgent.fromSeed(seedB)).evmAddress); }
    finally { await active.server.close(); }
    await expect(createServer({ agentsFile: f.agentsFile, logFn: () => {} })).rejects.toThrow(/exactly one/);
    writeFileSync(f.agentsFile, "broken");
    await expect(createServer({ agentsFile: f.agentsFile, logFn: () => {} })).rejects.toThrow(/Cannot read/);
    await expect(createServer({ seedHash: "gg".repeat(32), logFn: () => {} })).rejects.toThrow(/32-byte/);
  });

  it("reloads local files within the same connection and preserves the current wallet on an invalid reload", async () => {
    const f = fixture(); f.write([{ id: "one", seed_hash: seedA }]);
    const active = await createServer({ agentsFile: f.agentsFile, logFn: () => {} });
    const client = new Client({ name: "identity-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await active.server.connect(right); await client.connect(left);
    try {
      const tools = (await client.listTools()).tools.map(tool => tool.name);
      expect(tools).toContain("agent_reload");
      expect(tools).toContain("agent_passport_resolve");
      expect(tools).toContain("settlement_invoice");
      expect(tools).not.toContain("payable_fetch");
      const resources = await client.listResources();
      expect(resources.resources.map(resource => resource.uri)).toContain("aifinpay://skill");
      const skill = await client.readResource({ uri: "aifinpay://skill" });
      expect(skill.contents[0]).toMatchObject({ uri: "aifinpay://skill", mimeType: "text/markdown" });
      expect(String((skill.contents[0] as { text?: string }).text)).toContain("does not register payable_fetch");
      f.write([{ id: "one", seed_hash: seedB }]);
      const result = await client.callTool({ name: "agent_reload", arguments: {} });
      expect(result.isError).not.toBe(true);
      const address = (await AiFinPayAgent.fromSeed(seedB)).evmAddress;
      expect(JSON.stringify(result)).toContain(address);
      expect(JSON.stringify(result)).not.toContain(seedB);
      expect(active.agent.evmAddress).toBe(address);
      expect(JSON.stringify(await client.callTool({ name: "agent_address", arguments: {} }))).toContain(address);
      writeFileSync(f.agentsFile, "broken");
      expect((await client.callTool({ name: "agent_reload", arguments: {} })).isError).toBe(true);
      expect(active.agent.evmAddress).toBe(address);
    } finally { await client.close(); await active.server.close(); }
  });

  it("init uses the configured seed without creating another wallet or printing the seed", async () => {
    const f = fixture();
    const bin = fileURLToPath(new URL("../bin/aifinpay-mcp.js", import.meta.url));
    const result = spawnSync(process.execPath, [bin, "init"], {
      encoding: "utf8", timeout: 10000,
      env: { PATH: process.env.PATH, SEED_HASH: seedA, AIFINPAY_HOME: f.home },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain((await AiFinPayAgent.fromSeed(seedA)).evmAddress);
    expect(result.stdout).toContain("Using SEED_HASH");
    expect(result.stdout + result.stderr).not.toContain(seedA);
    expect(existsSync(join(f.home, "agent.json"))).toBe(false);
  });

  it("init and stdio use ./aifinpay/agents.json before an existing legacy keystore", async () => {
    const f = fixture();
    const legacy = await AiFinPayAgent.fromSeed(seedA);
    const secret = (legacy as unknown as { inner: { secretB58: string } }).inner.secretB58;
    const legacyPath = join(f.home, "agent.json");
    const before = JSON.stringify({ secretB58: secret });
    writeFileSync(legacyPath, before, { mode: 0o600 });
    mkdirSync(join(f.home, "aifinpay"));
    writeFileSync(join(f.home, "aifinpay", "agents.json"), JSON.stringify({ agents: [{ id: "one", seed_hash: seedB }] }), { mode: 0o600 });
    const bin = fileURLToPath(new URL("../bin/aifinpay-mcp.js", import.meta.url));
    for (const args of [["init"], []]) {
      const result = spawnSync(process.execPath, [bin, ...args], {
        encoding: "utf8", timeout: 10000, input: "", cwd: f.home,
        env: { PATH: process.env.PATH, AIFINPAY_HOME: f.home },
      });
      expect(result.status).toBe(0);
      expect(result.stdout + result.stderr).toContain((await AiFinPayAgent.fromSeed(seedB)).evmAddress);
      expect(result.stdout + result.stderr).not.toContain(seedB);
      expect(result.stdout + result.stderr).not.toContain(secret);
      expect(readFileSync(legacyPath, "utf8")).toBe(before);
    }
  });

  it("picks up a newly initialized keystore without reconnecting", async () => {
    const f = fixture();
    const active = await createServer({ walletHome: f.home, logFn: () => {} });
    const expected = await AiFinPayAgent.fromSeed(seedA);
    const client = new Client({ name: "init-reload-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await active.server.connect(right); await client.connect(left);
    try {
      writeFileSync(join(f.home, "agent.json"), JSON.stringify({
        secretB58: (expected as unknown as { inner: { secretB58: string } }).inner.secretB58,
      }), { mode: 0o600 });
      expect((await client.callTool({ name: "agent_reload", arguments: {} })).isError).not.toBe(true);
      expect(active.agent.evmAddress).toBe(expected.evmAddress);
    } finally { await client.close(); await active.server.close(); }
  });

  it("does not replace the wallet when an explicit seed is empty or an explicit file is absent", async () => {
    const f = fixture();
    await expect(createServer({ seedHash: "", walletHome: f.home, logFn: () => {} })).rejects.toThrow(/32-byte/);
    await expect(createServer({ agentsFile: f.agentsFile, walletHome: f.home, logFn: () => {} })).rejects.toThrow(/does not exist/);
  });

  it("does not fall back to a saved wallet when SEED_HASH is explicitly empty in the environment", async () => {
    const f = fixture();
    const saved = await AiFinPayAgent.fromSeed(seedA);
    const path = join(f.home, "agent.json");
    const before = JSON.stringify({ secretB58: saved.inner.secretB58 });
    writeFileSync(path, before, { mode: 0o600 });
    vi.stubEnv("SEED_HASH", "");
    expect(() => loadWalletIdentity({ ...loadConfigFromEnv(), walletHome: f.home }))
      .toThrow(/32-byte/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
