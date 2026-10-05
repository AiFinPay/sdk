import { describe, expect, it } from "vitest";
import { AiFinPayAgent } from "../src/unifiedAgent.js";
import { PAYMENT_CHAINS, paymentStableAsset, type PaymentChain } from "../src/paymentChains.js";
import { V14_DEPLOYMENTS } from "../src/generated/v14Deployments.generated.js";

describe("canonical chain names select the matching owner RPC and signer context", () => {
  it.each(Object.keys(PAYMENT_CHAINS) as PaymentChain[])("selects %s without a network request", async (chain) => {
    const rpc = `https://${chain}.owner.example`;
    const agent = await AiFinPayAgent.fromSeed("07".repeat(32), {
      evmRpcUrls: { [chain]: rpc },
    });
    const clients = chain === "polygon" ? (agent as any).polygonClients() : (agent as any).evmClients(chain);
    expect(clients.publicClient.chain.id).toBe(PAYMENT_CHAINS[chain].chainId);
    expect(clients.walletClient.chain.id).toBe(PAYMENT_CHAINS[chain].chainId);
    expect(clients.publicClient.chain.nativeCurrency.symbol).toBe(PAYMENT_CHAINS[chain].native);
    expect(clients.publicClient.transport.url).toBe(rpc);
    expect(clients.walletClient.account.address.toLowerCase()).toBe(agent.evmAddress.toLowerCase());
  });
  it("every generated token has independent decimals and unknown symbols/addresses fail closed", () => {
    for (const chain of Object.keys(PAYMENT_CHAINS) as PaymentChain[]) {
      for (const asset of V14_DEPLOYMENTS[chain].splitter.assets) {
        expect(paymentStableAsset(chain, asset.symbol)?.address.toLowerCase()).toBe(asset.address.toLowerCase());
        expect([6, 18]).toContain(paymentStableAsset(chain, asset.symbol)?.decimals);
      }
      expect(paymentStableAsset(chain, "unknown")).toBeUndefined();
    }
    expect(paymentStableAsset("xrplevm", "USDC")).toBeUndefined();
  });
});
