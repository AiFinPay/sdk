import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCipheriv, scryptSync } from "node:crypto";
import { AiFinPayAgent } from "../src/unifiedAgent.js";
import { privateKeyToAccount } from "viem/accounts";

const run = promisify(execFile);
const sdkUrl = new URL("../dist/index.js", import.meta.url).href;
const child = `
import { AiFinPayAgent } from ${JSON.stringify(sdkUrl)};
const fetchImpl = async () => { throw new Error("Network access forbidden in wallet loading test"); };
try {
  const agent = await AiFinPayAgent.fromEnvironment({
    fetchImpl,
    ...(process.env.FIXTURE_EVM_OVERRIDE ? { evmPrivateKey: process.env.FIXTURE_EVM_OVERRIDE } : {}),
  });
  console.log(JSON.stringify({ evm: agent.evmAddress, solana: agent.solanaAddress,
    innerEvm: await agent.inner.evmAddress(), casper: agent.casperAddress }));
} catch (error) {
  console.log(JSON.stringify({ error: error.message }));
}
`;

let dir: string;
let walletHome: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "aifp-env-wallet-"));
  walletHome = join(dir, "wallet");
  mkdirSync(walletHome);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function load(env: Record<string, string> = {}) {
  const result = await run(process.execPath, ["--input-type=module", "-e", child], {
    cwd: dir,
    // Do not inherit real wallet inputs or read any real home directory.
    env: { AIFINPAY_HOME: walletHome, ...env },
  });
  return { ...result, value: JSON.parse(result.stdout) };
}
async function fixture(seed = "11".repeat(32)) {
  const agent = await AiFinPayAgent.fromSeed(seed);
  return { seed, secret: agent.inner.secretB58, evm: agent.evmAddress, solana: agent.solanaAddress };
}
function store(value: unknown) {
  const path = join(walletHome, "agent.json");
  writeFileSync(path, JSON.stringify(value), { mode: 0o600 });
  return path;
}
function project(agents: unknown[]) {
  mkdirSync(join(dir, "aifinpay"), { recursive: true });
  const path = join(dir, "aifinpay", "agents.json");
  writeFileSync(path, JSON.stringify({ agents }), { mode: 0o600 });
  return path;
}
function encrypted(secret: string, passphrase: string) {
  const salt = Buffer.alloc(16, 3);
  const iv = Buffer.alloc(12, 4);
  const key = scryptSync(passphrase, salt, 32, { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(secret, "utf8"), cipher.final()]);
  return { enc: "scrypt-aes-256-gcm", salt: salt.toString("base64"), iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

describe("load-only environment wallet", () => {
  it("reuses the test5-shaped configured wallet across separate processes without replacing it", async () => {
    const wallet = await fixture();
    const path = store({ secretB58: wallet.secret });
    const before = readFileSync(path);
    const env = { SEED_HEX: "", AIFINPAY_AGENT_SECRET: wallet.secret };
    const first = await load(env);
    const second = await load(env);
    expect(first.value).toMatchObject({ evm: wallet.evm, innerEvm: wallet.evm, solana: wallet.solana });
    expect(second.value).toEqual(first.value);
    expect(readFileSync(path)).toEqual(before);
    expect(first.stdout + second.stdout + first.stderr + second.stderr).not.toContain(wallet.secret);
    expect(first.stdout + second.stdout).not.toContain(wallet.seed);
  });

  it("loads the existing keystore without an environment secret", async () => {
    const wallet = await fixture();
    store({ secretB58: wallet.secret });
    expect((await load()).value).toMatchObject({ evm: wallet.evm, innerEvm: wallet.evm });
  });

  it("uses SEED_HASH before the project file, secret and keystore", async () => {
    const wallet = await fixture();
    const other = await fixture("22".repeat(32));
    project([{ id: "other", seed_hash: other.seed }]);
    store({ secretB58: other.secret });
    expect((await load({ SEED_HASH: wallet.seed, AIFINPAY_AGENT_SECRET: other.secret })).value.evm).toBe(wallet.evm);
  });

  it("uses the project wallet before the legacy environment secret", async () => {
    const wallet = await fixture();
    const other = await fixture("22".repeat(32));
    project([{ id: "existing", seed_hash: wallet.seed }]);
    expect((await load({ AIFINPAY_AGENT_SECRET: other.secret })).value.evm).toBe(wallet.evm);
  });

  it("uses the legacy environment secret before the keystore", async () => {
    const wallet = await fixture();
    const other = await fixture("22".repeat(32));
    store({ secretB58: other.secret });
    expect((await load({ AIFINPAY_AGENT_SECRET: wallet.secret })).value.evm).toBe(wallet.evm);
  });

  it("selects one record in an explicitly configured project file", async () => {
    const wallet = await fixture();
    const path = join(dir, "agents.json");
    writeFileSync(path, JSON.stringify({ agents: [
      { id: "other", seed_hash: "22".repeat(32) }, { id: "chosen", seed_hash: wallet.seed },
    ] }));
    expect((await load({ AIFINPAY_AGENTS_FILE: path, AIFINPAY_AGENT_ID: "chosen" })).value.evm).toBe(wallet.evm);
  });

  it("keeps explicit imported EVM identity on both payment surfaces", async () => {
    const wallet = await fixture();
    const key = `0x${"33".repeat(32)}` as `0x${string}`;
    const expected = privateKeyToAccount(key).address;
    expect((await load({ SEED_HASH: wallet.seed, FIXTURE_EVM_OVERRIDE: key })).value)
      .toMatchObject({ evm: expected, innerEvm: expected, solana: wallet.solana });
  });

  it.each(["", "gg".repeat(32), "11".repeat(32) + "f"])("refuses invalid supplied seed without falling through (%s)", async (seed) => {
    const wallet = await fixture();
    const result = await load({ SEED_HASH: seed, AIFINPAY_AGENT_SECRET: wallet.secret });
    expect(result.value.error).toMatch(/SEED_HASH.*32-byte hex/);
    expect(result.stdout + result.stderr).not.toContain(wallet.secret);
  });

  it("refuses ambiguous project selection despite an available legacy secret", async () => {
    const wallet = await fixture();
    project([{ id: "one", seed_hash: wallet.seed }, { id: "two", seed_hash: "22".repeat(32) }]);
    expect((await load({ AIFINPAY_AGENT_SECRET: wallet.secret })).value.error).toMatch(/exactly one/);
  });

  it("refuses an explicit missing wallet file despite an available legacy secret", async () => {
    const wallet = await fixture();
    expect((await load({ AIFINPAY_AGENTS_FILE: join(dir, "missing.json"), AIFINPAY_AGENT_SECRET: wallet.secret })).value.error)
      .toMatch(/AIFINPAY_AGENTS_FILE.*does not exist/);
  });

  it("does not overwrite an invalid stored wallet or expose its contents", async () => {
    const path = join(walletHome, "agent.json");
    const content = '{"secretB58":"synthetic-private-content';
    writeFileSync(path, content);
    const result = await load();
    expect(result.value.error).toMatch(/Cannot read wallet JSON/);
    expect(readFileSync(path, "utf8")).toBe(content);
    expect(result.stdout + result.stderr).not.toContain("synthetic-private-content");
  });

  it("loads an encrypted wallet and rejects a wrong passphrase without replacement", async () => {
    const wallet = await fixture();
    const passphrase = "synthetic-passphrase-only";
    const path = store(encrypted(wallet.secret, passphrase));
    const before = readFileSync(path);
    expect((await load({ AIFINPAY_WALLET_PASSPHRASE: passphrase })).value.evm).toBe(wallet.evm);
    const rejected = await load({ AIFINPAY_WALLET_PASSPHRASE: "wrong-synthetic-passphrase" });
    expect(rejected.value.error).toMatch(/Cannot decrypt keystore/);
    expect(readFileSync(path)).toEqual(before);
    expect(rejected.stdout + rejected.stderr).not.toContain(wallet.secret);
    expect(rejected.stdout + rejected.stderr).not.toContain(passphrase);
  });

  it("does not create a wallet or read .env when no identity is configured", async () => {
    writeFileSync(join(dir, ".env"), `SEED_HASH=${"11".repeat(32)}\n`);
    const result = await load();
    expect(result.value.error).toMatch(/No persistent wallet configured/);
    expect(readdirSync(walletHome)).toEqual([]);
    expect(readdirSync(dir).sort()).toEqual([".env", "wallet"]);
  });
});
