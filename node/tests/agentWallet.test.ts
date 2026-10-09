import { describe, expect, it } from "vitest";
import { verifyMessage, stringToHex, type WalletClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { polygon } from "viem/chains";
import { Agent } from "../src/agent.js";
import { AiFinPayAgent } from "../src/unifiedAgent.js";
import {
  eip1193Wallet,
  evmPrivateKeyWallet,
  viemWalletClientWallet,
  type AgentWallet,
  type Eip1193Provider,
} from "../src/agentWallet.js";

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
      true
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
  function localWalletClient(chain = polygon): WalletClient {
    const account = privateKeyToAccount(PRIVATE_KEY);
    return {
      account,
      chain,
      signMessage: account.signMessage,
      signTypedData: account.signTypedData,
      getChainId: async () => chain.id,
      writeContract: async () => FAKE_SIG,
      sendTransaction: async () => FAKE_SIG,
    } as WalletClient;
  }

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

  it("uses an injected WalletClient for EVM transactions on its configured chain", async () => {
    const walletClient = localWalletClient();
    const agent = await AiFinPayAgent.fromSeed("11".repeat(32), { evmWalletClient: walletClient });
    const clients = (agent as unknown as { evmClients(name: string): { walletClient: WalletClient } }).evmClients(
      "polygon"
    );
    expect(clients.walletClient).toBe(walletClient);
    expect(agent.evmAddress).toBe(EXPECTED_ADDRESS);
  });

  it("supports a host-injected WalletClient with AiFinPayAgent.new", async () => {
    const agent = await AiFinPayAgent.new({ evmWalletClient: localWalletClient() });
    expect(agent.evmAddress).toBe(EXPECTED_ADDRESS);
  });

  it("refuses an injected WalletClient configured for another chain", async () => {
    const walletClient = localWalletClient({ ...polygon, id: 1 });
    const agent = await AiFinPayAgent.fromSeed("11".repeat(32), { evmWalletClient: walletClient });
    expect(() => (agent as unknown as { evmClients(name: string): unknown }).evmClients("polygon")).toThrow(
      /configured for Polygon/
    );
  });

  it("rejects ambiguous external EVM wallet configuration", async () => {
    const walletClient = {
      account: { address: EXPECTED_ADDRESS },
      chain: polygon,
    } as WalletClient;
    await expect(
      AiFinPayAgent.fromSeed("11".repeat(32), {
        evmWalletClient: walletClient,
        evmPrivateKey: PRIVATE_KEY,
      })
    ).rejects.toThrow(/Set only one/);
  });

  it("rejects a JSON-RPC send-only account before exposing it as an EVM signer", async () => {
    const walletClient = {
      account: { address: EXPECTED_ADDRESS, type: "json-rpc" },
      chain: polygon,
    } as unknown as WalletClient;
    await expect(AiFinPayAgent.fromSeed("11".repeat(32), { evmWalletClient: walletClient })).rejects.toThrow(
      /sign raw transactions/
    );
  });
});

// In-memory EIP-1193 stand-in: records calls, never touches the network.
function fakeEip1193(address: string, signature: `0x${string}`) {
  const calls: { method: string; params?: unknown }[] = [];
  const provider: Eip1193Provider = {
    request: async ({ method, params }) => {
      calls.push({ method, params });
      if (method === "eth_requestAccounts") return [address];
      return signature;
    },
  };
  return { provider, calls };
}

const FAKE_SIG = "0x5b73f5d8a9c4a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1c1d" as `0x${string}`;

describe("eip1193Wallet", () => {
  it("reads the address via eth_requestAccounts", async () => {
    const { provider, calls } = fakeEip1193(EXPECTED_ADDRESS, FAKE_SIG);
    const wallet = await eip1193Wallet(provider);
    expect(wallet.address).toBe(EXPECTED_ADDRESS);
    expect(calls[0]?.method).toBe("eth_requestAccounts");
  });

  it("signs messages via personal_sign with hex payload", async () => {
    const { provider, calls } = fakeEip1193(EXPECTED_ADDRESS, FAKE_SIG);
    const wallet = await eip1193Wallet(provider);
    const signature = await wallet.signMessage({ message: "aifp payment authorization" });
    expect(signature).toBe(FAKE_SIG);
    expect(calls[1]).toEqual({
      method: "personal_sign",
      params: [stringToHex("aifp payment authorization"), EXPECTED_ADDRESS],
    });
  });

  it("signs typed data via eth_signTypedData_v4 with a JSON payload", async () => {
    const { provider, calls } = fakeEip1193(EXPECTED_ADDRESS, FAKE_SIG);
    const wallet = await eip1193Wallet(provider);
    const typedData = { domain: { chainId: 137 }, message: { amount: "1" } };
    await wallet.signTypedData(typedData);
    expect(calls[1]).toEqual({
      method: "eth_signTypedData_v4",
      params: [EXPECTED_ADDRESS, JSON.stringify(typedData)],
    });
  });

  it("rejects when the provider returns no accounts", async () => {
    const provider: Eip1193Provider = { request: async () => [] };
    await expect(eip1193Wallet(provider)).rejects.toThrow("no accounts");
  });

  it("plugs into Agent.new like any other AgentWallet", async () => {
    const { provider } = fakeEip1193(EXPECTED_ADDRESS, FAKE_SIG);
    const agent = Agent.new({ evmWallet: await eip1193Wallet(provider) });
    expect((await agent.evmAddress()).toLowerCase()).toBe(EXPECTED_ADDRESS.toLowerCase());
  });
});

describe("viemWalletClientWallet", () => {
  // Hand-rolled WalletClient stand-in (Privy/Crossmint/ZeroDev-shaped):
  // records calls, never touches a transport.
  function fakeWalletClient() {
    const calls: { kind: string; args: unknown }[] = [];
    const client = {
      account: { address: EXPECTED_ADDRESS },
      signMessage: async (args: unknown) => {
        calls.push({ kind: "signMessage", args });
        return FAKE_SIG;
      },
      signTypedData: async (args: unknown) => {
        calls.push({ kind: "signTypedData", args });
        return FAKE_SIG;
      },
    } as unknown as WalletClient;
    return { client, calls };
  }

  it("exposes the client account address", () => {
    const { client } = fakeWalletClient();
    expect(viemWalletClientWallet(client).address).toBe(EXPECTED_ADDRESS);
  });

  it("delegates signing to the client with the account attached", async () => {
    const { client, calls } = fakeWalletClient();
    const wallet = viemWalletClientWallet(client);
    await wallet.signMessage({ message: "aifp payment authorization" });
    const typedData = { domain: { chainId: 137 } };
    await wallet.signTypedData(typedData);
    expect(calls).toEqual([
      {
        kind: "signMessage",
        args: { message: "aifp payment authorization", account: { address: EXPECTED_ADDRESS } },
      },
      { kind: "signTypedData", args: { ...typedData, account: { address: EXPECTED_ADDRESS } } },
    ]);
  });

  it("throws a clear error when the client has no account", () => {
    const client = { signMessage: async () => FAKE_SIG } as unknown as WalletClient;
    expect(() => viemWalletClientWallet(client)).toThrow("no account");
  });
});
