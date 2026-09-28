import { describe, expect, it } from "vitest";
import { verifyMessage } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { Agent } from "../src/agent.js";
import { AiFinPayAgent } from "../src/unifiedAgent.js";
import { evmPrivateKeyWallet, type AgentWallet } from "../src/agentWallet.js";

// Well-known test key — never a real wallet.
const PRIVATE_KEY = "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as const;
const EXPECTED_ADDRESS = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8" as const;

describe("evmPrivateKeyWallet", () => {
  it("returns the same address privateKeyToAccount produces", () => {
    const wallet = evmPrivateKeyWallet(PRIVATE_KEY);
    expect(wallet.address.toLowerCase()).toBe(EXPECTED_ADDRESS.toLowerCase());
    expect(wallet.address).toBe(privateKeyToAccount(PRIVATE_KEY).address);
  });

  it("produces signatures that verify against its address", async () => {
    const wallet = evmPrivateKeyWallet(PRIVATE_KEY);
    const signature = await wallet.signMessage({ message: "aifp payment authorization" });
    expect(await verifyMessage({ address: wallet.address, message: "aifp payment authorization", signature })).toBe(
      true,
    );
  });
});

describe("AgentOptions.evmWallet", () => {
  it("Agent uses the injected wallet instead of deriving from the seed", async () => {
    const agent = Agent.new({ evmWallet: evmPrivateKeyWallet(PRIVATE_KEY) });
    expect((await agent.evmAddress()).toLowerCase()).toBe(EXPECTED_ADDRESS.toLowerCase());
  });

  it("injected wallet takes priority over evmPrivateKey", async () => {
    const otherKey = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80" as const;
    const agent = Agent.new({ evmWallet: evmPrivateKeyWallet(PRIVATE_KEY), evmPrivateKey: otherKey });
    expect((await agent.evmAddress()).toLowerCase()).toBe(EXPECTED_ADDRESS.toLowerCase());
  });

  it("an external LocalAccount-shaped signer works without any private key in the SDK", async () => {
    // Minimal hand-rolled AgentWallet: proves the interface is the contract,
    // not the concrete viem account.
    const backing = privateKeyToAccount(PRIVATE_KEY);
    const external: AgentWallet = {
      address: backing.address,
      signMessage: (args) => backing.signMessage(args),
      signTypedData: (args) => backing.signTypedData(args),
    };
    const agent = Agent.new({ evmWallet: external });
    expect((await agent.evmAddress()).toLowerCase()).toBe(EXPECTED_ADDRESS.toLowerCase());
  });
});

describe("AiFinPayAgentOptions.evmWallet", () => {
  it("AiFinPayAgent.fromSeed uses the injected wallet for the EVM side", async () => {
    const agent = await AiFinPayAgent.fromSeed("11".repeat(32), { evmWallet: evmPrivateKeyWallet(PRIVATE_KEY) });
    expect(agent.evmAccount.address.toLowerCase()).toBe(EXPECTED_ADDRESS.toLowerCase());
  });

  it("AiFinPayAgent.fromSolanaSecret keeps the injected wallet", async () => {
    const seedOnly = await AiFinPayAgent.fromSeed("11".repeat(32));
    const agent = await AiFinPayAgent.fromSolanaSecret(seedOnly.inner.secretB58, {
      evmWallet: evmPrivateKeyWallet(PRIVATE_KEY),
    });
    expect(agent.evmAccount.address.toLowerCase()).toBe(EXPECTED_ADDRESS.toLowerCase());
  });
});
