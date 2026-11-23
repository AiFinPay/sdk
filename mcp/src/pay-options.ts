import { paymentStableAsset } from "@aifinpay/agent";
import type { ToolContext } from "./server.js";
import { optionGasCap, type McpConfig, type PayOption } from "./config.js";
import { PAY_CHAINS, type PayChain } from "./pay-chains.js";
import { independentNativeUsd } from "./native-price.js";

// Choosing only orders the owner's options; the SDK still checks the balance before signing and the USD caps still apply.
const BALANCE_TTL_MS = 60_000;
const BALANCE_OF = "0x70a08231";
const balances = new Map<string, Balance>();

export interface Balance {
  /** In the asset's smallest units. */
  units: bigint;
  decimals: number;
  at: number;
}

export interface OptionState extends PayOption {
  /** The merchant settles on this chain (true when it was not asked). */
  accepted: boolean;
  balance?: Balance;
  /** The chain's native coin, which pays the gas. */
  native?: Balance;
  gasCap: bigint;
  covers: boolean;
  error?: string;
}

/** The owner's RPC serves the pay chain only; another chain uses its public default, as the SDK does. */
export function rpcFor(config: McpConfig, chain: PayChain): string {
  return config.rpcUrl && chain.name === (config.payChain ?? "polygon") ? config.rpcUrl : chain.defaultRpc;
}

/** One balance, reused for 60 s unless maxAgeMs asks for a newer read. */
export async function readBalance(
  ctx: ToolContext,
  chain: PayChain,
  asset: string,
  maxAgeMs = BALANCE_TTL_MS
): Promise<Balance> {
  const rpc = rpcFor(ctx.config, chain);
  const owner = ctx.agent.evmAddress;
  const key = JSON.stringify([rpc, owner.toLowerCase(), chain.name, asset]);
  const hit = balances.get(key);
  if (hit && Date.now() - hit.at <= maxAgeMs) return hit;
  const token = asset === chain.native ? undefined : paymentStableAsset(chain.name as PayOption["chain"], asset);
  if (asset !== chain.native && !token) throw new Error(`${asset} is not pinned on ${chain.name}`);
  const units = await rpcQuantity(
    ctx,
    rpc,
    token
      ? ["eth_call", [{ to: token.address, data: BALANCE_OF + owner.slice(2).toLowerCase().padStart(64, "0") }, "latest"]]
      : ["eth_getBalance", [owner, "latest"]]
  );
  const balance = { units, decimals: token?.decimals ?? 18, at: Date.now() };
  balances.set(key, balance);
  return balance;
}

/** After a payment the balances it spent from are stale. */
export function forgetBalances(): void {
  balances.clear();
}

/** A read over the chain's RPC, through the same guarded fetch as every other request. */
async function rpcQuantity(ctx: ToolContext, rpc: string, [method, params]: [string, unknown[]]): Promise<bigint> {
  const response = await ctx.agent.inner.fetchImpl(rpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: AbortSignal.timeout(ctx.config.timeoutMs ?? 10_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body = (await response.json()) as { result?: unknown; error?: { message?: string } };
  if (typeof body.result !== "string" || !/^0x[0-9a-fA-F]{1,64}$/.test(body.result))
    throw new Error(body.error?.message ?? `malformed ${method} result`);
  return BigInt(body.result);
}

/** Every option in the owner's order: accepted by the merchant, read, and whether it covers priceUsd plus gas. */
export async function readOptions(
  ctx: ToolContext,
  options: PayOption[],
  opts: { priceUsd: number; merchantChains?: string[]; nativeUsd?: Record<string, number>; maxAgeMs?: number }
): Promise<OptionState[]> {
  const accepted = (o: PayOption) => !opts.merchantChains || opts.merchantChains.includes(o.chain);
  const reads = new Map<string, Promise<Balance | Error>>();
  const read = (chain: PayChain, asset: string) => {
    const key = `${chain.name}:${asset}`;
    if (!reads.has(key))
      reads.set(key, readBalance(ctx, chain, asset, opts.maxAgeMs).catch((e: unknown) => e as Error));
    return reads.get(key)!;
  };
  const prices = new Map<string, Promise<number | Error>>();
  const price = (chain: PayChain) => {
    if (!prices.has(chain.name))
      prices.set(
        chain.name,
        opts.nativeUsd?.[chain.name] !== undefined
          ? Promise.resolve(opts.nativeUsd[chain.name])
          : independentNativeUsd({
              fetchImpl: (input, init) => ctx.agent.inner.fetchImpl(input, init),
              chain,
              rpc: rpcFor(ctx.config, chain),
            }).then((p) => p.usd, (e: unknown) => e as Error)
      );
    return prices.get(chain.name)!;
  };
  return Promise.all(
    options.map(async (option): Promise<OptionState> => {
      const chain = PAY_CHAINS[option.chain];
      const gasCap = optionGasCap(ctx.config, option.chain);
      const state: OptionState = { ...option, accepted: accepted(option), gasCap, covers: false };
      if (!state.accepted) return state;
      const native = option.asset === chain.native;
      const [balance, gas, usd] = await Promise.all([
        read(chain, option.asset),
        read(chain, chain.native),
        native ? price(chain) : Promise.resolve(1),
      ]);
      if (!(balance instanceof Error)) state.balance = balance;
      if (!(gas instanceof Error)) state.native = gas;
      const failed = [balance, gas, usd].find((v): v is Error => v instanceof Error);
      if (failed) return { ...state, error: failed.message };
      const need = toUnits(opts.priceUsd / (usd as number), (balance as Balance).decimals);
      state.covers = native
        ? (gas as Balance).units >= need + gasCap
        : (balance as Balance).units >= need && (gas as Balance).units >= gasCap;
      return state;
    })
  );
}

/** The remembered option while it still covers, else the first in the owner's order that does. */
export function chooseOption(states: OptionState[], remembered?: PayOption): OptionState | undefined {
  const fits = states.filter((s) => s.accepted && s.covers);
  return fits.find((s) => s.chain === remembered?.chain && s.asset === remembered?.asset) ?? fits[0];
}

/** Rounded up: never choose an option that holds a fraction less than the price. */
function toUnits(amount: number, decimals: number): bigint {
  const nano = BigInt(Math.ceil(amount * 1e9));
  const scale = 10n ** BigInt(decimals);
  return (nano * scale + 999_999_999n) / 1_000_000_000n;
}

/** "1.5", "0", "0.000012": exact up to 6 decimals, rounded down. */
export function formatUnits(balance: Pick<Balance, "units" | "decimals">, places = 6): string {
  const scale = 10n ** BigInt(balance.decimals);
  const whole = balance.units / scale;
  const fraction = (balance.units % scale).toString().padStart(balance.decimals, "0").slice(0, places).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : `${whole}`;
}
