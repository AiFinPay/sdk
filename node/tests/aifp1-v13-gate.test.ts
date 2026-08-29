// The agent's AIFP-1 settlement is wired through the registry resolver and is
// closed until the registry opens it. No network: the gate throws before any
// client is built or any RPC is touched.
import { describe, expect, it } from "vitest";
import { AiFinPayAgent, SplitterRouteNotSettlingError } from "../src/index.js";

type Settle = (p: {
  merchantWallet: `0x${string}`; grossWei: bigint; merchantWei: bigint; treasuryWei: bigint;
  creatorWei: bigint; validUntil: bigint; orderId: string;
}) => Promise<`0x${string}`>;

describe("AIFP-1 v1.3 settlement gate", () => {
  it("refuses to settle while polygon:merchant-aifp1 is not enabled in the registry", async () => {
    const agent = await AiFinPayAgent.new({});
    const settle = (agent as unknown as { settleAifp1NativeV13: Settle }).settleAifp1NativeV13.bind(agent);
    await expect(settle({
      merchantWallet: "0x2222222222222222222222222222222222222222",
      grossWei: 10_000n, merchantWei: 9_900n, treasuryWei: 100n, creatorWei: 0n,
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 300), orderId: "q-1",
    })).rejects.toBeInstanceOf(SplitterRouteNotSettlingError);
  });

  it("names the reason: settlement is enabled only after a supervised paid settlement", async () => {
    const agent = await AiFinPayAgent.new({});
    const settle = (agent as unknown as { settleAifp1NativeV13: Settle }).settleAifp1NativeV13.bind(agent);
    await expect(settle({
      merchantWallet: "0x2222222222222222222222222222222222222222",
      grossWei: 10_000n, merchantWei: 9_900n, treasuryWei: 100n, creatorWei: 0n,
      validUntil: BigInt(Math.floor(Date.now() / 1000) + 300), orderId: "q-1",
    })).rejects.toThrow(/settlement is not enabled for this route yet/);
  });
});
