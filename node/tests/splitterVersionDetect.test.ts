// Legacy splitter version detection remains read-only, but no reported
// splitter version may re-enable the retired signing path.

import { describe, it, expect } from "vitest";
import { AiFinPayAgent } from "../src/unifiedAgent.js";

describe("legacy splitter settlement safety", () => {
  it.each(["1.1", "1.2"] as const)(
    "refuses settlement regardless of the bridge-reported version (%s)",
    async (splitterVersion) => {
      const agent = await AiFinPayAgent.fromSeed("11".repeat(32));
      await expect((agent as any).settleSplitterNative({
        chain: "polygon",
        splitter: "0x1111111111111111111111111111111111111111",
        splitterVersion,
        merchantWallet: "0x2222222222222222222222222222222222222222",
        totalWei: 1n,
        orderId: "legacy-refusal",
      })).rejects.toThrow(/legacy splitter settlement is disabled/i);
    },
  );

  it("refuses legacy Solana settlement before constructing a transaction", async () => {
    const agent = await AiFinPayAgent.fromSeed("22".repeat(32));
    await expect((agent as any).submitSolanaB2BPayWithSplit({
      program_id: "11111111111111111111111111111111",
      merchant_wallet: "11111111111111111111111111111111",
      treasury: "11111111111111111111111111111111",
      merchant_amount_lamports: "1",
      order_id: "legacy-refusal",
    })).rejects.toThrow(/legacy Solana settlement is disabled/i);
  });
});
