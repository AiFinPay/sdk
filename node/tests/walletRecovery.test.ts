// Wallet recoverability — the invariant that keeps funded agents spendable.
//
// `AiFinPayAgent.new()` once generated an EVM key independent of the Solana
// key. Every recovery path derives the EVM key from the Solana seed, so
// restoring an agent produced a DIFFERENT EVM address and any balance funded
// on the original became unreachable. These tests fail if that regresses.
import { describe, it, expect } from "vitest";
import { AiFinPayAgent } from "../src/unifiedAgent.js";
import { privateKeyToAccount } from "viem/accounts";
import { verifyMessage } from "viem";

describe("wallet recovery", () => {
  it("new() produces an agent recoverable from its Solana secret alone", async () => {
    const agent = await AiFinPayAgent.new();
    // The Solana secret is what operators are told to back up (and what the
    // CLI keystore and AIFINPAY_AGENT_SECRET hold), so it must be sufficient.
    const restored = await AiFinPayAgent.fromSolanaSecret(
      (agent as unknown as { inner: { secretB58: string } }).inner.secretB58,
    );
    expect(restored.solanaAddress).toBe(agent.solanaAddress);
    expect(restored.evmAddress).toBe(agent.evmAddress);
  });

  it("fromSeed is deterministic across restores", async () => {
    const seed = "22".repeat(32);
    const a = await AiFinPayAgent.fromSeed(seed);
    const b = await AiFinPayAgent.fromSeed(seed);
    expect(b.solanaAddress).toBe(a.solanaAddress);
    expect(b.evmAddress).toBe(a.evmAddress);
  });

  it("matches the Python SDK for a fixed seed (cross-SDK parity)", async () => {
    // Same fixture asserted in python/tests/test_wallet_recovery.py. The two
    // SDKs must derive identical addresses or an agent created with one is
    // unrecoverable with the other.
    const agent = await AiFinPayAgent.fromSeed("11".repeat(32));
    expect(agent.evmAddress).toBe("0x467aeE37983Eb1d4aa98e837e7D621bD71Af0F48");
    expect(agent.solanaAddress).toBe("F25s3DdjXdCxYBhh2z8FBusVEMT4b9bGNFVKJi3wFoF4");
  });

  it("distinct agents still get distinct keys", async () => {
    const a = await AiFinPayAgent.new();
    const b = await AiFinPayAgent.new();
    expect(a.solanaAddress).not.toBe(b.solanaAddress);
    expect(a.evmAddress).not.toBe(b.evmAddress);
  });

  it("an explicitly supplied EVM key is honoured over derivation", async () => {
    // Importing a pre-existing EVM wallet must keep working; such an agent is
    // NOT recoverable from the Solana secret, which is the caller's choice.
    const evmPrivateKey = `0x${"33".repeat(32)}` as `0x${string}`;
    const agent = await AiFinPayAgent.new({ evmPrivateKey });
    const derived = await AiFinPayAgent.fromSeed("44".repeat(32));
    expect(agent.evmAddress).not.toBe(derived.evmAddress);
  });

  it("fromSeed honours the same explicit EVM key as fromSolanaSecret", async () => {
    const evmPrivateKey = `0x${"33".repeat(32)}` as `0x${string}`;
    const agent = await AiFinPayAgent.fromSeed("11".repeat(32), { evmPrivateKey });
    const restored = await AiFinPayAgent.fromSolanaSecret(
      (agent as unknown as { inner: { secretB58: string } }).inner.secretB58,
      { evmPrivateKey },
    );
    expect(agent.evmAddress).toBe(privateKeyToAccount(evmPrivateKey).address);
    expect(restored.evmAddress).toBe(agent.evmAddress);
    expect(restored.solanaAddress).toBe(agent.solanaAddress);
  });

  it.each(["gg".repeat(32), "1z".repeat(32), "11".repeat(32) + "f", "f".repeat(63), "  " + "11".repeat(31)])(
    "rejects malformed seeds instead of deriving a different fundable wallet (%s)",
    async (seed) => {
      await expect(AiFinPayAgent.fromSeed(seed)).rejects.toThrow(/32 bytes.*64 hex/);
    },
  );

  it("keeps prefixed and uppercase valid seed addresses unchanged", async () => {
    const plain = await AiFinPayAgent.fromSeed("ab".repeat(32));
    const prefixed = await AiFinPayAgent.fromSeed(`0x${"AB".repeat(32)}`);
    expect(prefixed.evmAddress).toBe(plain.evmAddress);
    expect(prefixed.solanaAddress).toBe(plain.solanaAddress);
  });

  it.each([
    ["fromSeed", false], ["fromSeed", true],
    ["fromSolanaSecret", false], ["fromSolanaSecret", true],
    ["new", false], ["new", true],
  ] as const)("%s uses one EVM signer for native and standard x402 (override=%s)", async (factory, imported) => {
    const seed = "11".repeat(32);
    const evmPrivateKey = `0x${"33".repeat(32)}` as `0x${string}`;
    const opts = imported ? { evmPrivateKey } : {};
    type Inner = { secretB58: string; evmAddress(): Promise<string>; evmAccount(): ReturnType<import("../src/agent.js").Agent["evmAccount"]> };
    const fixture = await AiFinPayAgent.fromSeed(seed);
    const secret = (fixture as unknown as { inner: Inner }).inner.secretB58;
    const agent = factory === "new" ? await AiFinPayAgent.new(opts)
      : factory === "fromSolanaSecret" ? await AiFinPayAgent.fromSolanaSecret(secret, opts)
      : await AiFinPayAgent.fromSeed(seed, opts);
    const inner = (agent as unknown as { inner: Inner }).inner;
    const expected = imported ? privateKeyToAccount(evmPrivateKey).address : agent.evmAddress;
    expect(await inner.evmAddress()).toBe(expected);
    expect(agent.evmAddress).toBe(expected);
    const message = "synthetic x402 wallet identity regression";
    const signature = await (await inner.evmAccount()).signMessage({ message });
    expect(await verifyMessage({ address: agent.evmAddress as `0x${string}`, message, signature })).toBe(true);
  });
});
