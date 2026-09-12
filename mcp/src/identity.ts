import { readFileSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";
import { scryptSync, createDecipheriv } from "node:crypto";
import type { McpConfig } from "./config.js";

export type WalletIdentity = { source: string; seedHash?: string; secretB58?: string };

function seed(value: unknown): string {
  if (typeof value !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("SEED_HASH must contain a 32-byte hex seed (64 hex characters); no mnemonic or double hashing");
  }
  return value.replace(/^0x/, "");
}

function readJson(path: string): any {
  try { return JSON.parse(readFileSync(path, "utf8")); }
  catch { throw new Error(`Cannot read wallet JSON at ${path}; refusing to generate a replacement wallet`); }
}

/** Local inputs only. Never put the returned secrets in an MCP response/log. */
export function loadWalletIdentity(config: McpConfig): WalletIdentity | null {
  if (config.seedHash !== undefined) return { source: "SEED_HASH", seedHash: seed(config.seedHash) };
  const path = resolve(config.agentsFile || "./aifinpay/agents.json");
  if (existsSync(path)) {
    const document = readJson(path);
    const agents = document?.agents;
    if (!Array.isArray(agents) || agents.length === 0) throw new Error("agents.json requires a non-empty agents array");
    const matches = config.agentId
      ? agents.filter((a: any) => a?.id === config.agentId)
      : agents;
    if (matches.length !== 1) throw new Error("Select exactly one agents.json record with AIFINPAY_AGENT_ID; refusing an ambiguous wallet");
    return { source: "agents.json", seedHash: seed(matches[0]?.seed_hash) };
  }
  if (config.agentsFile) throw new Error("Configured AIFINPAY_AGENTS_FILE does not exist");
  if (config.agentSecretB58) return { source: "AIFINPAY_AGENT_SECRET", secretB58: config.agentSecretB58 };
  const legacyPath = join(config.walletHome || join(homedir(), ".aifinpay"), "agent.json");
  if (!existsSync(legacyPath)) return null;
  const legacy = readJson(legacyPath);
  try {
    const mode = statSync(legacyPath).mode & 0o777;
    if (mode & 0o077) {
      const message = `[aifinpay-mcp] ${legacyPath} is mode ${mode.toString(8)} — readable beyond your user. Run: chmod 600 ${legacyPath}`;
      if (config.logFn) config.logFn("warn", message);
      else process.stderr.write(`[warn] ${message}\n`);
    }
  } catch { /* A stat failure does not change which wallet was selected. */ }
  if (legacy.enc) {
    if (legacy.enc !== "scrypt-aes-256-gcm" || !config.walletPassphrase) {
      throw new Error("Encrypted keystore requires AIFINPAY_WALLET_PASSPHRASE and the supported encryption format");
    }
    try {
      const key = scryptSync(config.walletPassphrase, Buffer.from(legacy.salt, "base64"), 32,
        { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(legacy.iv, "base64"));
      decipher.setAuthTag(Buffer.from(legacy.tag, "base64"));
      return { source: "legacy-keystore", secretB58: Buffer.concat([
        decipher.update(Buffer.from(legacy.ct, "base64")), decipher.final(),
      ]).toString("utf8") };
    } catch { throw new Error("Cannot decrypt keystore; refusing to generate a replacement wallet"); }
  }
  if (typeof legacy.secretB58 !== "string" || !legacy.secretB58) throw new Error("Invalid legacy keystore");
  return { source: "legacy-keystore", secretB58: legacy.secretB58 };
}
