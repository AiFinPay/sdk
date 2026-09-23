import { describe, expect, it } from "vitest";
import { verifyMessage } from "viem";
import { AiFinPayAgent } from "../src/index.js";

// The owner links an agent in My Agents by pasting a signature over the
// dashboard's challenge. The helper must sign that challenge and nothing else.
describe("signDashboardClaim", () => {
  it("signs the dashboard's challenge for this agent, verifiable as EIP-191", async () => {
    const agent = await AiFinPayAgent.fromSeed("44".repeat(32));
    const message = `AiFinPay-claim:polygon:${agent.evmAddress.toLowerCase()}:${"a1".repeat(16)}`;
    const signature = await agent.signDashboardClaim(message);
    expect(await verifyMessage({ address: agent.evmAddress as `0x${string}`, message, signature })).toBe(true);
  });

  it("refuses another address, another shape, or arbitrary text", async () => {
    const agent = await AiFinPayAgent.fromSeed("44".repeat(32));
    const other = "0x" + "55".repeat(20);
    await expect(agent.signDashboardClaim(`AiFinPay-claim:polygon:${other}:${"a1".repeat(16)}`)).rejects.toThrow(
      /not a dashboard claim challenge/
    );
    await expect(
      agent.signDashboardClaim(`AiFinPay-claim:polygon:${agent.evmAddress.toLowerCase()}:not-hex`)
    ).rejects.toThrow();
    await expect(agent.signDashboardClaim("Transfer 100 POL to 0xattacker")).rejects.toThrow();
  });
});
