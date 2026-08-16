import { describe, expect, it } from "vitest";
import {
  AgentPassportError,
  agentPassportWallet,
  normalizeAgentPassportIdentifier,
  type AgentPassportIdentity,
} from "../src/agentPassport.js";

function passport(overrides: Partial<AgentPassportIdentity> = {}): AgentPassportIdentity {
  return {
    agent_id: `aifp_agent_${"1".repeat(32)}`,
    agent_number: 42,
    agent_number_display: "AIFP-000000042",
    username: "@research_bot",
    display_name: "Research Bot",
    status: "active",
    verification_level: "self_verified",
    created_at: 1,
    updated_at: 1,
    wallets: [
      {
        network: "polygon",
        chain_family: "evm",
        address: "0x1111111111111111111111111111111111111111",
        is_primary: true,
        verified_at: 1,
      },
      {
        network: "solana",
        chain_family: "solana",
        address: "11111111111111111111111111111111",
        is_primary: true,
        verified_at: 1,
      },
    ],
    ...overrides,
  };
}

describe("Agent Passport v2", () => {
  it("normalizes usernames without changing immutable IDs", () => {
    expect(normalizeAgentPassportIdentifier("Research_Bot")).toBe("@research_bot");
    expect(normalizeAgentPassportIdentifier("@Research_Bot")).toBe("@research_bot");
    expect(normalizeAgentPassportIdentifier(`aifp_agent_${"a".repeat(32)}`))
      .toBe(`aifp_agent_${"a".repeat(32)}`);
    expect(normalizeAgentPassportIdentifier("aifp-42")).toBe("AIFP-42");
  });

  it("rejects malformed or too-short usernames", () => {
    expect(() => normalizeAgentPassportIdentifier("ab")).toThrow(AgentPassportError);
    expect(() => normalizeAgentPassportIdentifier("1bad")).toThrow(AgentPassportError);
    expect(() => normalizeAgentPassportIdentifier("bad-name")).toThrow(AgentPassportError);
  });

  it("selects the exact requested network rather than silently crossing chains", () => {
    const p = passport();
    expect(agentPassportWallet(p, "polygon").address).toMatch(/^0x/);
    expect(agentPassportWallet(p, "solana").chain_family).toBe("solana");
    expect(() => agentPassportWallet(p, "base")).toThrow(/no verified base wallet/);
  });

  it("refuses wallet resolution for suspended or revoked agents", () => {
    expect(() => agentPassportWallet(passport({ status: "suspended" }), "polygon"))
      .toThrow(/suspended/);
    expect(() => agentPassportWallet(passport({ status: "revoked" }), "polygon"))
      .toThrow(/revoked/);
  });
});
