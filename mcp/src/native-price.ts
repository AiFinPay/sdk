import { PAY_CHAINS, type PayChain } from "./pay-chains.js";

/**
 * Independent native/USD rate for payable_fetch: POL on Polygon, ETH on Base.
 *
 * payable_fetch values a v1.4 quote in USD with a rate it fetches itself —
 * never the quote API's own — so the owner's per-payment and daily USD limits
 * hold even if the quoting server is wrong. Until 2.2.4 that rate came only
 * from api.coinbase.com. An agent in a sandbox that allowlists hosts (a GPT
 * environment, 2026-09-23) could not reach it and every payment stopped before
 * it began, with nothing to try instead.
 *
 * Sources, in order; the first fresh, sane answer wins:
 *   1. Chainlink <native>/USD on the payment chain, read over the agent's own
 *      RPC for that chain — the host the payment already needs, so no extra
 *      allowlist entry.
 *   2. api.coinbase.com spot price.
 *   3. api.coingecko.com.
 * Feed addresses and ids live in pay-chains.ts.
 */

export const CHAINLINK_POL_USD_POLYGON = PAY_CHAINS.polygon.chainlinkNativeUsd;
const LATEST_ROUND_DATA = "0xfeaf968c"; // latestRoundData()
const CHAINLINK_DECIMALS = 8;
// The feed updates on a 0.5% deviation or its heartbeat; a quiet market can
// leave it for a while. Older than this and it is not trusted as "current".
const MAX_FEED_AGE_S = 3600;

export interface NativePrice {
  usd: number;
  observedAtMs: number;
  source: `chainlink-${string}` | "coinbase" | "coingecko";
}

type FetchImpl = (input: string, init?: RequestInit) => Promise<Response>;

const sane = (usd: number, chain: PayChain) => Number.isFinite(usd) && usd > 0 && usd < chain.maxSaneUsd;

async function boundedJson(response: Response, limit = 16 * 1024): Promise<unknown> {
  const text = await response.text();
  if (text.length > limit) throw new Error("price response exceeds limit");
  return JSON.parse(text);
}

async function fromChainlink(fetchImpl: FetchImpl, rpc: string, chain: PayChain): Promise<NativePrice> {
  const response = await fetchImpl(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "eth_call",
      params: [{ to: chain.chainlinkNativeUsd, data: LATEST_ROUND_DATA }, "latest"],
    }),
    signal: AbortSignal.timeout(10_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`rpc ${response.status}`);
  const body = (await boundedJson(response)) as { result?: string };
  const hex = typeof body.result === "string" ? body.result.replace(/^0x/, "") : "";
  // (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
  if (hex.length < 64 * 5) throw new Error("malformed latestRoundData");
  const word = (i: number) => BigInt("0x" + hex.slice(i * 64, (i + 1) * 64));
  const answer = word(1);
  const updatedAt = Number(word(3));
  if (answer <= 0n || answer >= 2n ** 255n) throw new Error("non-positive answer");
  const ageS = Math.floor(Date.now() / 1000) - updatedAt;
  if (ageS < -30 || ageS > MAX_FEED_AGE_S) throw new Error(`feed is ${ageS}s old`);
  const usd = Number(answer) / 10 ** CHAINLINK_DECIMALS;
  if (!sane(usd, chain)) throw new Error("implausible answer");
  return { usd, observedAtMs: Date.now(), source: `chainlink-${chain.name}` };
}

async function fromCoinbase(fetchImpl: FetchImpl, chain: PayChain): Promise<NativePrice> {
  const response = await fetchImpl(`https://api.coinbase.com/v2/prices/${chain.coinbasePair}/spot`, {
    signal: AbortSignal.timeout(10_000),
    redirect: "manual",
  });
  if (!response.ok) throw new Error(`http ${response.status}`);
  const data = (await boundedJson(response)) as { data?: { base?: string; currency?: string; amount?: string } };
  const usd = Number(data.data?.amount);
  if (data.data?.base !== chain.native || data.data?.currency !== "USD" || !sane(usd, chain)) {
    throw new Error("invalid response");
  }
  return { usd, observedAtMs: Date.now(), source: "coinbase" };
}

async function fromCoinGecko(fetchImpl: FetchImpl, chain: PayChain): Promise<NativePrice> {
  const response = await fetchImpl(
    `https://api.coingecko.com/api/v3/simple/price?ids=${chain.coingeckoId}&vs_currencies=usd&include_last_updated_at=true`,
    { signal: AbortSignal.timeout(10_000), redirect: "manual" }
  );
  if (!response.ok) throw new Error(`http ${response.status}`);
  const data = (await boundedJson(response)) as Record<string, { usd?: number; last_updated_at?: number } | undefined>;
  const entry = data[chain.coingeckoId];
  const usd = Number(entry?.usd);
  const ageS = Math.floor(Date.now() / 1000) - Number(entry?.last_updated_at ?? 0);
  if (!sane(usd, chain)) throw new Error("invalid response");
  if (!(ageS >= -30 && ageS <= MAX_FEED_AGE_S)) throw new Error(`price is ${ageS}s old`);
  return { usd, observedAtMs: Date.now(), source: "coingecko" };
}

/**
 * The first independent native/USD rate any source gives for the payment
 * chain. Throws one error naming every source tried, so an agent in a
 * restricted sandbox knows what to allow.
 */
export async function independentNativeUsd(opts: {
  fetchImpl: FetchImpl;
  chain: PayChain;
  rpc?: string;
}): Promise<NativePrice> {
  const { chain } = opts;
  const attempts: Array<[string, () => Promise<NativePrice>]> = [];
  const rpc = opts.rpc;
  if (rpc && chain.chainlinkNativeUsd)
    attempts.push([`Chainlink on ${chain.label} via ${hostOf(rpc)}`, () => fromChainlink(opts.fetchImpl, rpc, chain)]);
  attempts.push(["api.coinbase.com", () => fromCoinbase(opts.fetchImpl, chain)]);
  attempts.push(["api.coingecko.com", () => fromCoinGecko(opts.fetchImpl, chain)]);

  const failures: string[] = [];
  for (const [label, attempt] of attempts) {
    try {
      return await attempt();
    } catch (e) {
      failures.push(`${label}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  throw new Error(
    `Independent ${chain.native}/USD price unavailable — nothing was paid. Tried ` +
      failures.join("; ") +
      ". Allow outbound access to one of these hosts."
  );
}

/** The Polygon rate, as before chains were configurable. */
export function independentPolUsd(opts: { fetchImpl: FetchImpl; polygonRpc?: string }): Promise<NativePrice> {
  return independentNativeUsd({ fetchImpl: opts.fetchImpl, chain: PAY_CHAINS.polygon, rpc: opts.polygonRpc });
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "the configured RPC";
  }
}
