// ──────────────────────────────────────────────────────────────────────────
// Cross-chain orchestration via LiFi.
//
// We do NOT depend on @lifi/sdk. We call their public REST API (li.quest/v1)
// directly so the SDK footprint stays tiny and the flow is easy to mock in
// tests. The same approach used by their own quote endpoint examples.
//
// Architectural note — `Obsidian/21 - Unified Agent Economy.md` non-goal:
//   "We do not move funds ourselves. Cross-chain settlement is delegated to
//    established bridges (LiFi, Jupiter, Wormhole) — we orchestrate the
//    sequence and the agent signs every step."
//
// This file is the orchestration layer for EVM↔EVM. Solana↔EVM will live
// in `crossChainSolana.ts` (Phase 1.5b: Wormhole/deBridge + Jupiter swap).
// ──────────────────────────────────────────────────────────────────────────
import type { PublicClient, WalletClient } from "viem";
import { AiFinPayError } from "./errors.js";

const LIFI_API = "https://li.quest/v1";

// ── Supported EVM chains for cross-chain settlement ──────────────────────
// EVM chain IDs (canonical, used by both viem and LiFi).
export const EVM_CHAINS = {
  ethereum:  1,
  polygon:   137,
  bsc:       56,
  arbitrum:  42161,
  optimism:  10,
  base:      8453,
} as const;

export type EvmChainName = keyof typeof EVM_CHAINS;

// USDC token addresses per chain. Native (Circle CCTP) variant where it
// exists; bridged USDC.e listed in `USDC_BRIDGED` for legacy compatibility.
export const USDC_NATIVE: Record<EvmChainName, `0x${string}`> = {
  ethereum: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48",
  polygon:  "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  bsc:      "0x8AC76a51cc950d9822D68b83fE1Ad97B32Cd580d", // Binance-Peg BSC-USD; closest analogue
  arbitrum: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831",
  optimism: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  base:     "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
};

export const USDC_BRIDGED: Partial<Record<EvmChainName, `0x${string}`>> = {
  polygon:  "0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174", // USDC.e PoS bridged (deprecated, kept for legacy merchants)
  arbitrum: "0xFF970A61A04b1cA14834A43f5dE4533eBDDB5CC8", // USDC.e (deprecated)
};

// ── Quote types ──────────────────────────────────────────────────────────

export interface BridgeQuoteOptions {
  fromChain:    EvmChainName;
  toChain:      EvmChainName;
  fromToken:    `0x${string}`;         // ERC-20 address on source chain
  toToken:      `0x${string}`;         // ERC-20 address on dest chain
  fromAmount:   string;                 // base units as string (USDC is 6 decimals)
  fromAddress:  `0x${string}`;          // agent's EVM address
  toAddress?:   `0x${string}`;          // defaults to fromAddress
  slippage?:    number;                 // 0.005 = 0.5%
  // LiFi accepts `integrator` for analytics + revenue share with project
  // partners. We pass "aifinpay" so all our agent-driven volume is tagged.
  integrator?:  string;
}

// Subset of LiFi's quote response shape. Their full schema is large; we
// only type-pin the fields we read. Unknown fields stay accessible via
// `raw_quote.<anything>` for partners who want the full route detail.
export interface BridgeQuote {
  // Human-readable summary
  from: { chain: EvmChainName; token: `0x${string}`; amount: string };
  to:   { chain: EvmChainName; token: `0x${string}`; amount: string; amount_min: string };
  fees: { bridge_usd: number; gas_usd: number; total_usd: number };
  eta_seconds:  number;
  bridge_tool:  string; // "stargate", "across", "circle-cctp", etc.
  // Raw LiFi response. Pass straight to `bridgeExecute()`.
  raw_quote:    unknown;
}

interface LifiQuoteResponse {
  estimate: {
    fromAmount:    string;
    toAmount:      string;
    toAmountMin:   string;
    feeCosts?:     Array<{ amountUSD?: string; name?: string }>;
    gasCosts?:     Array<{ amountUSD?: string }>;
    executionDuration?: number;
  };
  transactionRequest: {
    to:        `0x${string}`;
    data:      `0x${string}`;
    value:     string;            // hex (e.g. "0x0")
    gasLimit:  string;            // hex
    chainId:   number;
  };
  tool:        string;
  toolDetails?: { name?: string };
  action: {
    fromChainId: number;
    toChainId:   number;
    fromToken:   { address: `0x${string}` };
    toToken:     { address: `0x${string}` };
  };
}

// ── Quote ────────────────────────────────────────────────────────────────

export async function bridgeQuote(opts: BridgeQuoteOptions): Promise<BridgeQuote> {
  const fromChainId = EVM_CHAINS[opts.fromChain];
  const toChainId   = EVM_CHAINS[opts.toChain];

  const url = new URL(`${LIFI_API}/quote`);
  url.searchParams.set("fromChain",   String(fromChainId));
  url.searchParams.set("toChain",     String(toChainId));
  url.searchParams.set("fromToken",   opts.fromToken);
  url.searchParams.set("toToken",     opts.toToken);
  url.searchParams.set("fromAmount",  opts.fromAmount);
  url.searchParams.set("fromAddress", opts.fromAddress);
  if (opts.toAddress) url.searchParams.set("toAddress", opts.toAddress);
  if (opts.slippage !== undefined) url.searchParams.set("slippage", String(opts.slippage));
  url.searchParams.set("integrator", opts.integrator ?? "aifinpay");

  const r = await fetch(url.toString());
  if (!r.ok) {
    const detail = await r.text().catch(() => "<unreadable>");
    throw new AiFinPayError(
      `bridgeQuote: LiFi /quote returned ${r.status} for ${opts.fromChain}→${opts.toChain}: ${detail.slice(0, 300)}`,
    );
  }
  const j = (await r.json()) as LifiQuoteResponse;

  const bridgeUsd = (j.estimate.feeCosts ?? []).reduce((s, f) => s + Number(f.amountUSD ?? 0), 0);
  const gasUsd    = (j.estimate.gasCosts ?? []).reduce((s, g) => s + Number(g.amountUSD ?? 0), 0);

  return {
    from: { chain: opts.fromChain, token: opts.fromToken, amount: j.estimate.fromAmount },
    to:   {
      chain:      opts.toChain,
      token:      opts.toToken,
      amount:     j.estimate.toAmount,
      amount_min: j.estimate.toAmountMin,
    },
    fees: { bridge_usd: bridgeUsd, gas_usd: gasUsd, total_usd: bridgeUsd + gasUsd },
    eta_seconds: j.estimate.executionDuration ?? 0,
    bridge_tool: j.toolDetails?.name ?? j.tool,
    raw_quote:   j,
  };
}

// ── Execute ──────────────────────────────────────────────────────────────

export interface BridgeReceipt {
  source_tx:     `0x${string}`;
  source_chain:  EvmChainName;
  dest_chain:    EvmChainName;
  bridge_tool:   string;
  status:        "submitted" | "pending" | "done" | "failed";
  // dest_tx is populated only after polling status until completion.
  // Call `bridgeWaitForArrival()` separately if you need it inline.
  dest_tx?:      string;
}

/**
 * Submit the source-chain transaction returned by `bridgeQuote()`.
 * Caller supplies a viem walletClient connected to the SOURCE chain (the
 * agent's wallet on `opts.fromChain`). We don't switch chains for the
 * caller — that's an explicit choice to keep this primitive small.
 *
 * The agent signs and submits. AiFinPay never touches the funds.
 */
// LiFi's sentinel for "the chain's own coin", plus the zero address some
// integrators use for the same thing.
const NATIVE_SENTINELS = new Set([
  "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
  "0x0000000000000000000000000000000000000000",
]);

// A bridge of this size should never need more than this much gas. The cap is
// generous — real LiFi routes land far below it — and exists so a quote cannot
// name a number that empties the wallet through the fee alone.
const MAX_BRIDGE_GAS = 3_000_000n;

/**
 * Refuse to sign a transaction that does not match the quote it came with.
 *
 * bridgeExecute() previously took `to`, `data`, `value` and `gasLimit` straight
 * from `raw_quote.transactionRequest` and checked only the chain id. Since
 * bridgeExecute() accepts any object shaped like a BridgeQuote, and since
 * raw_quote is whatever an HTTP response said, the effect was that an
 * attacker-supplied or tampered quote could have the agent sign a transfer of
 * its own funds to any address.
 *
 * The calldata is not something this SDK can meaningfully validate — it is a
 * router's business. What it can do is refuse the shapes that move money in
 * ways the quote never described:
 *
 *   Bridging an ERC-20 sends no native value at all. Any value on such a quote
 *   is money leaving by a route the human-readable summary does not mention.
 *
 *   Bridging the native coin sends exactly the amount quoted. More than that
 *   is, again, unquoted.
 *
 *   The destination must be a contract. A router is one; an attacker's wallet
 *   is not, and a plain transfer to an address is the simplest form of this
 *   attack.
 */
async function assertQuoteMatchesTransaction(
  quote: BridgeQuote,
  tx: { to: `0x${string}`; value?: string; gasLimit?: string },
  publicClient: PublicClient,
): Promise<void> {
  const value = BigInt(tx.value || "0x0");
  const fromToken = String(quote.from?.token ?? "").toLowerCase();
  const quotedAmount = BigInt(quote.from?.amount ?? "0");
  const bridgingNative = NATIVE_SENTINELS.has(fromToken);

  if (!bridgingNative && value !== 0n) {
    throw new AiFinPayError(
      `bridgeExecute: quote bridges token ${quote.from?.token} but the transaction sends ` +
        `${value} native units. A token bridge sends no native value — refusing to sign.`,
    );
  }
  if (bridgingNative && value > quotedAmount) {
    throw new AiFinPayError(
      `bridgeExecute: transaction sends ${value} native units but the quote is for ` +
        `${quotedAmount} — refusing to sign for more than was quoted.`,
    );
  }

  const gas = tx.gasLimit ? BigInt(tx.gasLimit) : 0n;
  if (gas > MAX_BRIDGE_GAS) {
    throw new AiFinPayError(
      `bridgeExecute: quote asks for ${gas} gas, above the ${MAX_BRIDGE_GAS} ceiling — refusing to sign.`,
    );
  }

  let code: string | undefined;
  try {
    code = await publicClient.getBytecode({ address: tx.to });
  } catch {
    // An RPC that will not answer is not evidence of an attack; let the send
    // fail on its own terms rather than inventing a security verdict.
    return;
  }
  if (!code || code === "0x") {
    throw new AiFinPayError(
      `bridgeExecute: quote sends funds to ${tx.to}, which has no code. Bridge routers are ` +
        `contracts — refusing to sign a transfer to a plain address.`,
    );
  }
}

export async function bridgeExecute(
  quote:          BridgeQuote,
  walletClient:   WalletClient,
  publicClient:   PublicClient,
): Promise<BridgeReceipt> {
  const raw = quote.raw_quote as LifiQuoteResponse;
  const tx  = raw.transactionRequest;
  if (!tx) {
    throw new AiFinPayError(
      `bridgeExecute: quote has no transactionRequest — likely returned by /quote/toAmount which we don't use`,
    );
  }

  // Sanity-check that the wallet client is on the source chain.
  const chainId = await walletClient.getChainId();
  if (chainId !== tx.chainId) {
    throw new AiFinPayError(
      `bridgeExecute: walletClient is on chain ${chainId}, quote requires ${tx.chainId} (${quote.from.chain})`,
    );
  }

  const account = walletClient.account;
  if (!account) {
    throw new AiFinPayError(`bridgeExecute: walletClient has no account — pass account: at creation`);
  }

  await assertQuoteMatchesTransaction(quote, tx, publicClient);

  const hash = await walletClient.sendTransaction({
    account,
    to:       tx.to,
    data:     tx.data,
    value:    BigInt(tx.value || "0x0"),
    gas:      tx.gasLimit ? BigInt(tx.gasLimit) : undefined,
    chain:    null,
  });

  // Wait for source-chain inclusion only. Dest-chain arrival is async —
  // caller polls via `bridgeWaitForArrival(hash)` if they care.
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") {
    return {
      source_tx:    hash,
      source_chain: quote.from.chain,
      dest_chain:   quote.to.chain,
      bridge_tool:  quote.bridge_tool,
      status:       "failed",
    };
  }

  return {
    source_tx:    hash,
    source_chain: quote.from.chain,
    dest_chain:   quote.to.chain,
    bridge_tool:  quote.bridge_tool,
    status:       "submitted",
  };
}

// ── Status polling ───────────────────────────────────────────────────────

/**
 * Poll LiFi's /v1/status for cross-chain arrival. Stargate/Across typically
 * finalise in 30s-3min; Circle CCTP can take 15-25min on Polygon side.
 *
 * Returns once status is "DONE" or "FAILED", or throws on timeout.
 */
export async function bridgeWaitForArrival(
  sourceTxHash:  `0x${string}`,
  opts: {
    pollIntervalMs?: number;
    timeoutMs?:      number;
  } = {},
): Promise<{ status: "done" | "failed"; dest_tx?: string; raw: unknown }> {
  const pollMs = opts.pollIntervalMs ?? 5000;
  const timeoutMs = opts.timeoutMs   ?? 30 * 60 * 1000; // 30 min ceiling
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    const url = `${LIFI_API}/status?txHash=${sourceTxHash}`;
    const r = await fetch(url);
    if (r.ok) {
      const j = (await r.json()) as {
        status?:    string;
        receiving?: { txHash?: string };
      };
      if (j.status === "DONE") {
        return { status: "done", dest_tx: j.receiving?.txHash, raw: j };
      }
      if (j.status === "FAILED" || j.status === "INVALID") {
        return { status: "failed", raw: j };
      }
    }
    await new Promise((resolve) => setTimeout(resolve, pollMs));
  }
  throw new AiFinPayError(
    `bridgeWaitForArrival: timeout after ${timeoutMs}ms — source tx ${sourceTxHash} did not finalise on dest`,
  );
}
