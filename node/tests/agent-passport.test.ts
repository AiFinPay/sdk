import { describe, expect, it } from "vitest";
import { generateKeyPairSync, sign } from "node:crypto";
import {
  agentPassportWallet,
  generateAgentPassportHolderKeypair,
  normalizeAgentPassportIdentifier,
  signAgentPassportHolderMessage,
  verifyAgentPassportIssuerSignature,
  type AgentPassportIdentity,
} from "../src/agentPassport.js";

function canonicalize(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;
  const rec = value as Record<string, unknown>;
  return `{${Object.keys(rec).sort().map((k) => `${JSON.stringify(k)}:${canonicalize(rec[k])}`).join(",")}}`;
}

function passport(overrides: Partial<AgentPassportIdentity> = {}): AgentPassportIdentity {
  const holder = generateAgentPassportHolderKeypair();
  return {
    schema: "aifp3.passport.vnext",
    agent_id: `aifp_agent_${"1".repeat(32)}`,
    agent_number: 42,
    agent_number_display: "AIFP-000000042",
    username: "@research_bot",
    display_name: "Research Bot",
    status: "active",
    verification_level: "self_verified",
    holder_public_key: holder.public_key_b64,
    issuer: { key_id: "issuer-test", public_key: "", signature: "" },
    protected_payload_hash: "unused-in-local-test",
    integrity_state: "ok",
    version: 1,
    created_at: 1,
    updated_at: 1,
    wallets: [
      { network: "polygon", chain_family: "evm", chain_ref: "eip155:137", address: "0x1111111111111111111111111111111111111111", public_key: null, is_primary: true, status: "active", verified_at: 1 },
      { network: "solana", chain_family: "solana", chain_ref: "solana:mainnet", address: "11111111111111111111111111111111", public_key: "11111111111111111111111111111111", is_primary: true, status: "active", verified_at: 1 },
    ],
    ...overrides,
  };
}

describe("AIFP-3 global Agent Passport vNext", () => {
  it("normalizes usernames without changing immutable IDs", () => {
    expect(normalizeAgentPassportIdentifier("Research_Bot")).toBe("@research_bot");
    expect(normalizeAgentPassportIdentifier(`aifp_agent_${"a".repeat(32)}`)).toBe(`aifp_agent_${"a".repeat(32)}`);
    expect(normalizeAgentPassportIdentifier("aifp-42")).toBe("AIFP-42");
  });

  it("keeps one global passport while selecting exact chain binding", () => {
    const p = passport();
    expect(agentPassportWallet(p, "polygon").address).toMatch(/^0x/);
    expect(agentPassportWallet(p, "solana").chain_family).toBe("solana");
    expect(() => agentPassportWallet(p, "base")).toThrow(/no verified base wallet/);
  });

  it("does not use blocked wallets or compromised passport state", () => {
    const p = passport({ wallets: [{ network: "polygon", chain_family: "evm", chain_ref: "eip155:137", address: "0x1111111111111111111111111111111111111111", public_key: null, is_primary: true, status: "blocked", verified_at: 1 }] });
    expect(() => agentPassportWallet(p, "polygon")).toThrow(/no verified polygon wallet/);
    expect(() => agentPassportWallet(passport({ integrity_state: "failed" }), "polygon")).toThrow(/integrity_failed/);
  });

  it("generates holder key locally and signs challenge", () => {
    const holder = generateAgentPassportHolderKeypair();
    expect(holder.public_key_b64.length).toBeGreaterThan(20);
    expect(holder.private_key_b64.length).toBeGreaterThan(20);
    expect(signAgentPassportHolderMessage(holder.private_key_b64, "challenge").length).toBeGreaterThan(20);
  });

  it("verifies issuer only against caller-pinned AiFinPay public key", () => {
    const issuer = generateKeyPairSync("ed25519");
    const pub = issuer.publicKey.export({ format: "der", type: "spki" }).toString("base64");
    const p = passport();
    p.issuer = { key_id: "issuer-test", public_key: pub, signature: "" };
    const payload = {
      schema: "aifp3.passport.vnext", agent_id: p.agent_id, agent_number: p.agent_number,
      agent_number_display: p.agent_number_display, username: p.username, display_name: p.display_name,
      status: p.status, verification_level: p.verification_level, holder_public_key: p.holder_public_key,
      issuer_key_id: p.issuer.key_id, version: p.version, created_at: p.created_at, updated_at: p.updated_at,
      wallets: p.wallets.map((w) => ({ network: w.network, chain_family: w.chain_family, chain_ref: w.chain_ref, address: w.address, public_key: w.public_key, is_primary: w.is_primary, status: w.status, verified_at: w.verified_at })).sort((a, b) => `${a.network}:${a.address}`.localeCompare(`${b.network}:${b.address}`)),
    };
    p.issuer.signature = sign(null, Buffer.from(canonicalize(payload)), issuer.privateKey).toString("base64");
    expect(verifyAgentPassportIssuerSignature(p, pub)).toBe(true);
    const other = generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" }).toString("base64");
    expect(verifyAgentPassportIssuerSignature(p, other)).toBe(false);
    expect(verifyAgentPassportIssuerSignature({ ...p, verification_level: "enhanced_verified" }, pub)).toBe(false);
  });
});
