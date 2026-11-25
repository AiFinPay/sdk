import { vi } from "vitest";
import { paymentStableAsset } from "@aifinpay/agent";
import { PAY_CHAINS, pinnedStablecoins } from "../src/pay-chains.js";

type Chain = keyof typeof PAY_CHAINS;

/** Offline safeFetch: `url` answers a 402, public RPCs the "chain:ASSET" balances (absent 0, null fails), Coinbase `nativeUsd`. */
export function payableNetwork(opts: {
  url: string;
  balances?: Record<string, bigint | null>;
  merchantChains?: string[];
  priceUsd?: number;
  nativeUsd?: number;
}) {
  const balance = (chain: string, asset: string) => {
    const value = opts.balances?.[`${chain}:${asset}`];
    return value === null
      ? Response.json({ jsonrpc: "2.0", id: 1, error: { message: "rpc down" } })
      : Response.json({ jsonrpc: "2.0", id: 1, result: "0x" + (value ?? 0n).toString(16).padStart(64, "0") });
  };
  return vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const href = String(input);
    if (href === opts.url)
      return Response.json(
        {
          error: "AIFP-402",
          protocol: "AIFP-1",
          merchant_id: "mrch_offline",
          resource: new URL(opts.url).pathname,
          unit_weight: 1,
          base_unit_price_usd: "0.0005",
          min_units: Math.round((opts.priceUsd ?? 0.02) / 0.0005),
        },
        { status: 402 }
      );
    if (href.includes("/v1/merchants/mrch_offline"))
      return opts.merchantChains
        ? Response.json({ merchant_id: "mrch_offline", site_verified: true, settlement_chains: opts.merchantChains })
        : new Response("not found", { status: 404 });
    const coinbase = /^https:\/\/api\.coinbase\.com\/v2\/prices\/([A-Z]+)-USD\/spot$/.exec(href);
    if (coinbase) return Response.json({ data: { base: coinbase[1], currency: "USD", amount: String(opts.nativeUsd ?? 0.2) } });
    const chain = (Object.keys(PAY_CHAINS) as Chain[]).find((name) => PAY_CHAINS[name].defaultRpc === href);
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (chain && body?.method === "eth_getBalance") return balance(chain, PAY_CHAINS[chain].native);
    if (chain && body?.method === "eth_call") {
      const to = String(body.params[0].to).toLowerCase();
      const asset = pinnedStablecoins(chain).find((symbol) => paymentStableAsset(chain, symbol)?.address.toLowerCase() === to);
      // Anything else (the Chainlink feed): an empty answer, which no reader accepts as a price.
      return asset ? balance(chain, asset) : Response.json({ jsonrpc: "2.0", id: 1, result: "0x" });
    }
    return new Response("not found", { status: 404 });
  });
}
