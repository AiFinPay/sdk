import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createDecipheriv, scryptSync } from "node:crypto";
import { AiFinPayError } from "./errors.js";

type LocalWalletIdentity =
  | { source: "SEED_HASH" | "agents.json"; seedHash: string; secretB58?: never }
  | { source: "AIFINPAY_AGENT_SECRET" | "legacy-keystore"; secretB58: string; seedHash?: never };

function seed(value: unknown): string {
  if (typeof value !== "string" || !/^(0x)?[0-9a-fA-F]{64}$/.test(value)) {
    throw new AiFinPayError("SEED_HASH must contain a 32-byte hex seed (64 hex characters); no mnemonic or double hashing");
  }
  return value.replace(/^0x/, "");
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJson(path: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (object(parsed)) return parsed;
  } catch { /* File contents and parse errors may contain private material. */ }
  throw new AiFinPayError(`Cannot read wallet JSON at ${path}; refusing to generate a replacement wallet`);
}

/**
 * Internal load-only adapter for the same identity files used by MCP.
 * Keep source precedence and encryption format aligned with mcp/src/identity.ts.
 * No file is created, changed or logged; returned key material stays local.
 */
export function loadLocalWalletIdentity(): LocalWalletIdentity {
  const env = process.env;
  if (env.SEED_HASH !== undefined) return { source: "SEED_HASH", seedHash: seed(env.SEED_HASH) };

  const projectPath = resolve(env.AIFINPAY_AGENTS_FILE || "./aifinpay/agents.json");
  if (existsSync(projectPath)) {
    const document = readJson(projectPath);
    const agents = document.agents;
    if (!Array.isArray(agents) || agents.length === 0) {
      throw new AiFinPayError("agents.json requires a non-empty agents array");
    }
    const matches = env.AIFINPAY_AGENT_ID
      ? agents.filter((agent: unknown) => object(agent) && agent.id === env.AIFINPAY_AGENT_ID)
      : agents;
    if (matches.length !== 1) {
      throw new AiFinPayError("Select exactly one agents.json record with AIFINPAY_AGENT_ID; refusing an ambiguous wallet");
    }
    return { source: "agents.json", seedHash: seed(object(matches[0]) ? matches[0].seed_hash : undefined) };
  }
  if (env.AIFINPAY_AGENTS_FILE) throw new AiFinPayError("Configured AIFINPAY_AGENTS_FILE does not exist");
  if (env.AIFINPAY_AGENT_SECRET) {
    return { source: "AIFINPAY_AGENT_SECRET", secretB58: env.AIFINPAY_AGENT_SECRET };
  }

  const legacyPath = join(env.AIFINPAY_HOME || join(homedir(), ".aifinpay"), "agent.json");
  if (!existsSync(legacyPath)) {
    throw new AiFinPayError("No persistent wallet configured; configure SEED_HASH, aifinpay/agents.json, AIFINPAY_AGENT_SECRET or an existing MCP keystore before loading an agent");
  }
  const legacy = readJson(legacyPath);
  if (legacy.enc) {
    if (legacy.enc !== "scrypt-aes-256-gcm" || !env.AIFINPAY_WALLET_PASSPHRASE) {
      throw new AiFinPayError("Encrypted keystore requires AIFINPAY_WALLET_PASSPHRASE and the supported encryption format");
    }
    try {
      if (![legacy.salt, legacy.iv, legacy.tag, legacy.ct].every((value) => typeof value === "string")) {
        throw new Error("Invalid encrypted fields");
      }
      const key = scryptSync(env.AIFINPAY_WALLET_PASSPHRASE, Buffer.from(legacy.salt as string, "base64"), 32,
        { N: 1 << 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(legacy.iv as string, "base64"));
      decipher.setAuthTag(Buffer.from(legacy.tag as string, "base64"));
      return { source: "legacy-keystore", secretB58: Buffer.concat([
        decipher.update(Buffer.from(legacy.ct as string, "base64")), decipher.final(),
      ]).toString("utf8") };
    } catch {
      throw new AiFinPayError("Cannot decrypt keystore; refusing to generate a replacement wallet");
    }
  }
  if (typeof legacy.secretB58 !== "string" || !legacy.secretB58) throw new AiFinPayError("Invalid legacy keystore");
  return { source: "legacy-keystore", secretB58: legacy.secretB58 };
}
