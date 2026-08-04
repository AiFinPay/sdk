import { describe, expect, it } from "vitest";
import { bridgeExecute } from "../src/index.js";

// bridgeExecute() took `to`, `data`, `value` and `gasLimit` straight from
// `raw_quote.transactionRequest` and checked only the chain id before signing.
//
// raw_quote is whatever an HTTP response said, and bridgeExecute accepts any
// object shaped like a BridgeQuote, so a tampered or hand-built quote could
// have the agent sign a transfer of its own funds anywhere. The human-readable
// half of the quote — "bridge 1 USDC from Base to Polygon" — was never
// compared against the transaction that half described.
//
// These tests are the attacks. The calldata itself is a router's business and
// is not validated; what is refused are the shapes that move money in ways the
// quote never mentioned.

const ROUTER = "0x1231deb6f5749ef6ce6943a275a1d3e7486f4eae" as const;
const USDC_BASE = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" as const;
const NATIVE = "0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE" as const;

const walletClient = {
  account: { address: "0x5Df154283588623aa23c770c1521F7835861255e" },
  getChainId: async () => 8453,
  sendTransaction: async () => {
    throw new Error("SIGNED — the guard let this through");
  },
} as never;

// Answers as if every destination were a deployed contract, so the tests below
// fail on the money checks rather than on the code check.
const publicClient = {
  getBytecode: async () => "0x6080604052",
  waitForTransactionReceipt: async () => ({ status: "success" }),
} as never;

const quote = (over: Record<string, unknown> = {}, txOver: Record<string, unknown> = {}) => ({
  from: { chain: "base", token: USDC_BASE, amount: "1000000", ...(over.from as object ?? {}) },
  to: { chain: "polygon", token: USDC_BASE, amount: "993100", amount_min: "988135" },
  fees: { bridge_usd: 0.007, gas_usd: 0.002, total_usd: 0.009 },
  eta_seconds: 60,
  bridge_tool: "stargate",
  ...over,
  raw_quote: {
    transactionRequest: {
      to: ROUTER, data: "0xabcdef", value: "0x0", gasLimit: "0x7a120", chainId: 8453,
      ...txOver,
    },
  },
}) as never;

describe("a quote that does not describe the transaction it carries", () => {
  it("refuses native value on a token bridge", async () => {
    // The drain: the summary says "bridge 1 USDC", the transaction says
    // "send 1 ETH". Only the second one moves the agent's own coin.
    await expect(
      bridgeExecute(quote({}, { value: "0xde0b6b3a7640000" }), walletClient, publicClient),
    ).rejects.toThrow(/sends 1000000000000000000 native units/);
  });

  it("refuses more native value than the quote is for", async () => {
    await expect(
      bridgeExecute(
        quote({ from: { chain: "base", token: NATIVE, amount: "1000000000000000" } },
              { value: "0xde0b6b3a7640000" }),
        walletClient, publicClient,
      ),
    ).rejects.toThrow(/more than was quoted/);
  });

  it("refuses a gas limit that would drain the wallet through the fee", async () => {
    await expect(
      bridgeExecute(quote({}, { gasLimit: "0x5f5e100" }), walletClient, publicClient), // 100M
    ).rejects.toThrow(/above the .* ceiling/);
  });

  it("refuses a destination with no code", async () => {
    // A plain transfer to someone's wallet is the simplest form of this.
    const noCode = { ...publicClient, getBytecode: async () => "0x" } as never;
    await expect(
      bridgeExecute(quote({ from: { chain: "base", token: NATIVE, amount: "1000" } },
                          { value: "0x3e8" }), walletClient, noCode),
    ).rejects.toThrow(/no code/);
  });

  it("still refuses a mismatched chain before anything else", async () => {
    await expect(
      bridgeExecute(quote({}, { chainId: 137 }), walletClient, publicClient),
    ).rejects.toThrow(/walletClient is on chain/);
  });

  it("lets a consistent quote through to signing", async () => {
    // Reaching sendTransaction is the pass condition: the guard must not be
    // refusing everything, which would make the tests above meaningless.
    await expect(
      bridgeExecute(quote(), walletClient, publicClient),
    ).rejects.toThrow(/SIGNED/);
  });

  it("lets a native bridge of exactly the quoted amount through", async () => {
    await expect(
      bridgeExecute(
        quote({ from: { chain: "base", token: NATIVE, amount: "1000" } }, { value: "0x3e8" }),
        walletClient, publicClient,
      ),
    ).rejects.toThrow(/SIGNED/);
  });

  it("does not turn an unreadable RPC into a security verdict", async () => {
    const broken = { ...publicClient, getBytecode: async () => { throw new Error("RPC down"); } } as never;
    await expect(bridgeExecute(quote(), walletClient, broken)).rejects.toThrow(/SIGNED/);
  });
});
