import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, randomBytes, scryptSync } from "node:crypto";
import { AiFinPayAgent, type EvmWalletClient } from "@aifinpay/agent";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { loadWalletIdentity } from "../src/identity.js";
import { createServer } from "../src/server.js";
import { loadConfigFromEnv } from "../src/config.js";

const dirs: string[] = [];
const seedA = "11".repeat(32),
  seedB = "22".repeat(32);
const externalEvmAddress = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;
function encrypt(plaintext: string, passphrase: string) {
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const key = scryptSync(passphrase, salt, 32, {
    N: 1 << 15,
    r: 8,
    p: 1,
    maxmem: 64 * 1024 * 1024,
  });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  return {
    enc: "scrypt-aes-256-gcm",
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ct: ct.toString("base64"),
  };
}
function externalWalletClient(chainId = 137, accountType: "local" | "json-rpc" = "local"): EvmWalletClient {
  return {
    account: {
      address: externalEvmAddress,
      type: accountType,
      ...(accountType === "local" ? { signTransaction: async () => "0x" } : {}),
    },
    chain: {
      id: chainId,
      name: "test",
      nativeCurrency: { name: "Test", symbol: "TST", decimals: 18 },
      rpcUrls: { default: { http: ["https://example.invalid"] } },
    },
    signMessage: async () => "0x",
    signTypedData: async () => "0x",
    getChainId: async () => chainId,
    writeContract: async () => "0x",
    sendTransaction: async () => "0x",
  } as unknown as EvmWalletClient;
}
function fixture() {
  const home = mkdtempSync(join(tmpdir(), "aifp-identity-"));
  dirs.push(home);
  const agentsFile = join(home, "agents.json");
  const write = (agents: unknown[]) => writeFileSync(agentsFile, JSON.stringify({ agents }), { mode: 0o600 });
  return { home, agentsFile, write };
}
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("persistent wallet identity", () => {
  it("uses a host-injected EVM WalletClient while retaining the local Solana identity", async () => {
    const f = fixture();
    const local = await AiFinPayAgent.fromSeed(seedA);
    const active = await createServer({
      seedHash: seedA,
      walletHome: f.home,
      evmWalletClient: externalWalletClient(),
      paymentsEnabled: true,
      maxAmountUsd: 0.1,
      dailyAmountUsd: 1,
      maxGasPol: "0.05",
      gatewayOrigins: ["https://merchant.example"],
      logFn: () => {},
    });
    try {
      expect(active.agent.evmAddress).toBe(externalEvmAddress);
      expect(active.agent.solanaAddress).toBe(local.solanaAddress);
      expect(existsSync(join(f.home, "payments", externalEvmAddress.toLowerCase()))).toBe(true);
      const client = new Client({ name: "external-wallet-surface-test", version: "1" });
      const [left, right] = InMemoryTransport.createLinkedPair();
      await active.server.connect(right);
      await client.connect(left);
      try {
        expect((await client.listTools()).tools.map((tool) => tool.name)).toContain("payable_fetch");
      } finally {
        await client.close();
      }
    } finally {
      await active.server.close();
    }
  });

  it("refuses an injected EVM wallet client bound to the wrong payment chain", async () => {
    const f = fixture();
    await expect(
      createServer({
        seedHash: seedA,
        walletHome: f.home,
        evmWalletClient: externalWalletClient(1),
        paymentsEnabled: true,
        maxAmountUsd: 0.1,
        dailyAmountUsd: 1,
        maxGasPol: "0.05",
        gatewayOrigins: ["https://merchant.example"],
        logFn: () => {},
      })
    ).rejects.toThrow(/configured for polygon/);
  });

  it("refuses JSON-RPC send-only signers before enabling payments", async () => {
    const f = fixture();
    await expect(
      createServer({
        seedHash: seedA,
        walletHome: f.home,
        evmWalletClient: externalWalletClient(137, "json-rpc"),
        paymentsEnabled: true,
        maxAmountUsd: 0.1,
        dailyAmountUsd: 1,
        maxGasPol: "0.05",
        gatewayOrigins: ["https://merchant.example"],
        logFn: () => {},
      })
    ).rejects.toThrow(/sign raw transactions/);
  });

  it("registers generic payment only with explicit owner limits and persistent wallet", async () => {
    const f = fixture();
    const config = {
      seedHash: seedA,
      walletHome: f.home,
      paymentsEnabled: true,
      maxAmountUsd: 0.1,
      dailyAmountUsd: 1,
      maxGasPol: "0.05",
      gatewayOrigins: ["https://merchant.example"],
      logFn: () => {},
    };
    const active = await createServer(config);
    const client = new Client({ name: "payment-surface-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await active.server.connect(right);
    await client.connect(left);
    try {
      const tools = (await client.listTools()).tools;
      const payment = tools.find((tool) => tool.name === "payable_fetch");
      expect(payment).toBeDefined();
      expect(payment?.annotations?.destructiveHint).toBe(true);
      expect(tools.some((tool) => tool.name === "agent_call")).toBe(false);
      expect(
        (await client.callTool({ name: "payable_fetch", arguments: { url: "https://unapproved.example/data" } }))
          .isError
      ).toBe(true);
    } finally {
      await client.close();
      await active.server.close();
    }
    await expect(createServer({ ...config, dailyAmountUsd: undefined })).rejects.toThrow(/DAILY_USD/);
    await expect(createServer({ ...config, seedHash: undefined })).rejects.toThrow(/persistent/);
  });

  it("reads SEED_HASH from the process configuration", () => {
    vi.stubEnv("SEED_HASH", seedA);
    expect(loadConfigFromEnv()).toMatchObject({ seedHash: seedA });
  });

  it("parses the optional wallet index from the environment", () => {
    vi.stubEnv("AIFINPAY_WALLET_INDEX", "0");
    expect(loadConfigFromEnv().walletIndex).toBe(0);
    vi.stubEnv("AIFINPAY_WALLET_INDEX", "-1");
    expect(() => loadConfigFromEnv()).toThrow(/AIFINPAY_WALLET_INDEX/);
  });

  it("derives the selected child identity from SEED_HASH consistently", async () => {
    const walletIndex = 7;
    const selected = loadWalletIdentity({ seedHash: seedA, walletIndex });
    expect(selected).toEqual({ source: "SEED_HASH", seedHash: seedA, derivationIndex: walletIndex });
    const expected = await AiFinPayAgent.fromSeed(seedA, { derivationIndex: walletIndex });
    const active = await createServer({ seedHash: seedA, walletIndex, logFn: () => {} });
    try {
      expect(active.agent.evmAddress).toBe(expected.evmAddress);
      expect(active.agent.solanaAddress).toBe(expected.solanaAddress);
      expect(active.agent.casperAddress).toBe(expected.casperAddress);
    } finally {
      await active.server.close();
    }
  });

  it("loads and derives the indexed wallet from a keystore", async () => {
    const f = fixture();
    const path = join(f.home, "agent.json");
    writeFileSync(
      path,
      JSON.stringify({ secretB58: "unused", seedHex: seedA, derivationMode: "legacy-solana", derivationIndex: 0 }),
      { mode: 0o600 }
    );
    expect(loadWalletIdentity({ walletHome: f.home })).toEqual({
      source: "legacy-keystore",
      seedHash: seedA,
      derivationIndex: 0,
    });
    const expected = await AiFinPayAgent.fromSeed(seedA, { derivationIndex: 0 });
    const active = await createServer({ walletHome: f.home, logFn: () => {} });
    try {
      expect(active.agent.solanaAddress).toBe(expected.solanaAddress);
      expect(active.agent.evmAddress).toBe(expected.evmAddress);
      expect(active.agent.casperAddress).toBe(expected.casperAddress);
    } finally {
      await active.server.close();
    }
    writeFileSync(
      path,
      JSON.stringify({ secretB58: "unused", seedHex: seedA, derivationMode: "standard", derivationIndex: 0 }),
      { mode: 0o600 }
    );
    expect(loadWalletIdentity({ walletHome: f.home })).toEqual({
      source: "legacy-keystore",
      seedHash: seedA,
      derivationIndex: 0,
    });
  });

  it("refuses an index when no seed or keystore is available", () => {
    const f = fixture();
    expect(() => loadWalletIdentity({ walletHome: f.home, walletIndex: 0 })).toThrow(
      /requires a configured seed or an indexed wallet keystore/
    );
  });

  it("decrypts the recovery seed for an indexed encrypted keystore", () => {
    const f = fixture();
    const passphrase = "fixture-passphrase";
    const index = 2;
    const secret = encrypt("encrypted solana secret", passphrase);
    const seedEnc = encrypt(seedA, passphrase);
    writeFileSync(
      join(f.home, "agent.json"),
      JSON.stringify({
        ...secret,
        seedEnc: {
          salt: seedEnc.salt,
          iv: seedEnc.iv,
          tag: seedEnc.tag,
          ct: seedEnc.ct,
        },
        derivationMode: "legacy-solana",
        derivationIndex: index,
      }),
      { mode: 0o600 }
    );
    expect(loadWalletIdentity({ walletHome: f.home, walletPassphrase: passphrase })).toEqual({
      source: "legacy-keystore",
      seedHash: seedA,
      derivationIndex: index,
    });
  });

  it("keeps SEED_HASH stable on restart and prioritizes it over file and legacy secret", async () => {
    const f = fixture();
    f.write([{ id: "one", seed_hash: seedB }]);
    const expected = await AiFinPayAgent.fromSeed(seedA);
    const legacy = await AiFinPayAgent.fromSeed(seedB);
    const secret = (legacy as unknown as { inner: { secretB58: string } }).inner.secretB58;
    for (const config of [
      { seedHash: seedA, walletHome: f.home },
      { seedHash: seedA, agentsFile: f.agentsFile, agentSecretB58: secret },
    ]) {
      for (let restart = 0; restart < 2; restart++) {
        const active = await createServer({ ...config, logFn: () => {} });
        try {
          expect(active.agent.evmAddress).toBe(expected.evmAddress);
        } finally {
          await active.server.close();
        }
      }
    }
  });

  it("loads the selected project agent before the legacy secret and fails on ambiguous or malformed files", async () => {
    const f = fixture();
    f.write([
      { id: "one", seed_hash: seedA },
      { id: "two", seed_hash: seedB },
    ]);
    const legacy = await AiFinPayAgent.fromSeed(seedA);
    const secret = (legacy as unknown as { inner: { secretB58: string } }).inner.secretB58;
    const active = await createServer({
      agentsFile: f.agentsFile,
      agentId: "two",
      agentSecretB58: secret,
      logFn: () => {},
    });
    try {
      expect(active.agent.evmAddress).toBe((await AiFinPayAgent.fromSeed(seedB)).evmAddress);
    } finally {
      await active.server.close();
    }
    await expect(createServer({ agentsFile: f.agentsFile, logFn: () => {} })).rejects.toThrow(/exactly one/);
    writeFileSync(f.agentsFile, "broken");
    await expect(createServer({ agentsFile: f.agentsFile, logFn: () => {} })).rejects.toThrow(/Cannot read/);
    await expect(createServer({ seedHash: "gg".repeat(32), logFn: () => {} })).rejects.toThrow(/32-byte/);
  });

  it("reloads local files within the same connection and preserves the current wallet on an invalid reload", async () => {
    const f = fixture();
    f.write([{ id: "one", seed_hash: seedA }]);
    const active = await createServer({ agentsFile: f.agentsFile, logFn: () => {} });
    const client = new Client({ name: "identity-test", version: "1" });
    const [left, right] = InMemoryTransport.createLinkedPair();
    await active.server.connect(right);
    await client.connect(left);
    try {
      const tools = (await client.listTools()).tools.map((tool) => tool.name);
      expect(tools).toContain("agent_reload");
      expect(tools).toContain("agent_passport_resolve");
      expect(tools).toContain("settlement_invoice");
      expect(tools).not.toContain("payable_fetch");
      const resources = await client.listResources();
      expect(resources.resources.map((resource) => resource.uri)).toContain("aifinpay://skill");
      const skill = await client.readResource({ uri: "aifinpay://skill" });
      expect(skill.contents[0]).toMatchObject({
        uri: "aifinpay://skill",
        mimeType: "text/markdown",
      });
      // The bundled skill must describe the payments this server ships. It used
      // to say MCP was read-only and payments were "release pending" — this line
      // asserted exactly that — and agents following it refused to pay.
      const skillText = String((skill.contents[0] as { text?: string }).text);
      expect(skillText).toBe(readFileSync(new URL("../skills/SKILL.md", import.meta.url), "utf8"));
      expect(skillText).toContain("payable_fetch");
      expect(skillText).toContain("agent_claim_self");
      expect(skillText).not.toMatch(/not yet released/);
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
    } finally {
      await client.close();
      await active.server.close();
    }
  });

  it.skip("init uses the configured seed without creating another wallet or printing the seed", async () => {
    const f = fixture();
    const bin = fileURLToPath(new URL("../bin/aifinpay-mcp.js", import.meta.url));
    const result = spawnSync(process.execPath, [bin, "init"], {
      encoding: "utf8",
      timeout: 10000,
      env: { PATH: process.env.PATH, SEED_HASH: seedA, AIFINPAY_HOME: f.home },
    });
    expect(result.status).toBe(0);
    expect(result.stdout).toContain((await AiFinPayAgent.fromSeed(seedA)).evmAddress);
    expect(result.stdout).toContain("Using SEED_HASH");
    expect(result.stdout + result.stderr).not.toContain(seedA);
    expect(existsSync(join(f.home, "agent.json"))).toBe(false);
  });

  it.skip("init and stdio use ./aifinpay/agents.json before an existing legacy keystore", async () => {
    const f = fixture();
    const legacy = await AiFinPayAgent.fromSeed(seedA);
    const secret = (legacy as unknown as { inner: { secretB58: string } }).inner.secretB58;
    const legacyPath = join(f.home, "agent.json");
    const before = JSON.stringify({ secretB58: secret });
    writeFileSync(legacyPath, before, { mode: 0o600 });
    mkdirSync(join(f.home, "aifinpay"));
    writeFileSync(
      join(f.home, "aifinpay", "agents.json"),
      JSON.stringify({ agents: [{ id: "one", seed_hash: seedB }] }),
      { mode: 0o600 }
    );
    const bin = fileURLToPath(new URL("../bin/aifinpay-mcp.js", import.meta.url));
    for (const args of [["init"], []]) {
      const result = spawnSync(process.execPath, [bin, ...args], {
        encoding: "utf8",
        timeout: 10000,
        input: "",
        cwd: f.home,
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
    await active.server.connect(right);
    await client.connect(left);
    try {
      writeFileSync(
        join(f.home, "agent.json"),
        JSON.stringify({
          secretB58: (expected as unknown as { inner: { secretB58: string } }).inner.secretB58,
        }),
        { mode: 0o600 }
      );
      expect((await client.callTool({ name: "agent_reload", arguments: {} })).isError).not.toBe(true);
      expect(active.agent.evmAddress).toBe(expected.evmAddress);
    } finally {
      await client.close();
      await active.server.close();
    }
  });

  it("does not replace the wallet when an explicit seed is empty or an explicit file is absent", async () => {
    const f = fixture();
    await expect(createServer({ seedHash: "", walletHome: f.home, logFn: () => {} })).rejects.toThrow(/32-byte/);
    await expect(createServer({ agentsFile: f.agentsFile, walletHome: f.home, logFn: () => {} })).rejects.toThrow(
      /does not exist/
    );
  });

  it("does not fall back to a saved wallet when SEED_HASH is explicitly empty in the environment", async () => {
    const f = fixture();
    const saved = await AiFinPayAgent.fromSeed(seedA);
    const path = join(f.home, "agent.json");
    const before = JSON.stringify({ secretB58: saved.inner.secretB58 });
    writeFileSync(path, before, { mode: 0o600 });
    vi.stubEnv("SEED_HASH", "");
    expect(() => loadWalletIdentity({ ...loadConfigFromEnv(), walletHome: f.home })).toThrow(/32-byte/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });
});
