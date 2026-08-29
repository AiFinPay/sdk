// ──────────────────────────────────────────────────────────────────────────
// AiFinPayAgent — unified, chain-opaque developer surface.
//
// Wraps the legacy chain-aware Agent (Solana keypair + native methods) and
// adds an EVM signer plus high-level call/openSession/balance/verify flows.
// Chain selection happens inside the SDK via the provider registry +
// cost-band heuristics.
//
// This is the Phase 1 skeleton. Methods marked `// TODO(phase-N)` will be
// wired up as the migration progresses (see Obsidian/22 - Migration Roadmap).
// ──────────────────────────────────────────────────────────────────────────
import nacl from "tweetnacl";
import { blake2b } from "@noble/hashes/blake2b";
import bs58 from "bs58";
import { createHash, randomBytes } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  keccak256,
  toHex,
  type PublicClient,
  type WalletClient,
  toFunctionSelector,
  formatEther,
} from "viem";
import {
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import { polygon, base, arbitrum, optimism, bsc, mainnet, unichain, type Chain } from "viem/chains";
import { botchain, xrplevm } from "./chains.js";
import {
  V13_ABI,
  trustedPinFromRegistry,
  verifySettlementRouteOnChain,
  type TrustedSettlementRoutePin,
} from "./settlement.js";
import { resolveSettlingSplitterRoute, type SplitterRouteDeployment } from "./splitterRoutes.js";
import {
  Connection,
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  sendAndConfirmTransaction,
} from "@solana/web3.js";
import {
  AiFinPayError,
  X402Error,
} from "./errors.js";
import { Agent, type AgentOptions } from "./agent.js";
import { type SpendLedger, MemorySpendLedger, FileSpendLedger } from "./spendLedger.js";
import {
  aifp1Fetch,
  Aifp1ReceiptCache,
  type Aifp1Deps,
  type Aifp1FetchOptions,
} from "./aifp1.js";
import {
  bridgeQuote     as crossChainQuote,
  bridgeExecute   as crossChainExecute,
  bridgeWaitForArrival,
  EVM_CHAINS,
  USDC_NATIVE,
  type BridgeQuote,
  type BridgeReceipt,
  type BridgeQuoteOptions,
  type EvmChainName,
} from "./crossChain.js";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Chains the unified agent can settle on. "solana" uses the Anchor
 * b2b_pay_with_split program; every other value is an EVM chain with a
 * verified B2BSplitter deployment (see SPLITTER_DEPLOYMENTS below).
 * Additive union — "polygon" remains the EVM default.
 */
export type ChainId = "solana" | SplitterChainName;

export interface ProviderEntry {
  name:            string;
  display_name?:   string;
  preferred_chain: ChainId;
  accepted_chains: ChainId[];
  price_usd:       number;
  mode:            "per_call" | "session" | "both";
  bridge_url:      string;
  merchant_wallet: string;
  service_type?:   string;
  url?:            string;
}

export interface CallOptions {
  provider:    string;
  cost?:       number;
  chain?:      ChainId;
  bridgeUrl?:  string;
  body?:       unknown;
  method?:     string;
  timeoutMs?:  number;
  signal?:     AbortSignal;
}

export interface BalanceSnapshot {
  agent_balance_usd: number;
  chains: {
    solana: {
      sol:            number;
      usdc:           number;
      msecco_balance: number;
    };
    polygon: {
      matic:          number;
      usdc:           number;
      msecco_balance: number;
    };
  };
  spend_24h_usd: number;
  budget_caps: {
    daily_usd?:    number;
    per_call_usd?: number;
  };
  priced_at: number;
}

export interface ReputationSnapshot {
  trust_score:    number;
  spend_score:    number;
  tenure_days:    number;
  verified:       boolean;
  flags:          string[];
}

export interface BudgetCaps {
  daily_usd?:    number;
  per_call_usd?: number;
  /**
   * Behaviour when a cap is hit during call():
   *   "throw"  (default) — raise BudgetCapExceededError, caller decides
   *   "skip"            — call() resolves to null without paying;
   *                        useful in loops where you'd rather drop an
   *                        agent task than spike the daily envelope
   */
  on_limit_exceeded?: "throw" | "skip";
}

export interface SessionHandle {
  id:           string;
  provider:     string;
  chain:        ChainId;
  budget_usd:   number;
  spent_usd:    number;
  remaining_usd: number;
  expires_at:   number;
  call(body: unknown): Promise<Response>;
  close(): Promise<SessionReceipt>;
  abandon(): Promise<void>;
}

export interface SessionReceipt {
  session_id:    string;
  spent_usd:     number;
  refund_usd:    number;
  settlement_tx: string;
  block:         number | string;
}

export interface AiFinPayAgentOptions extends AgentOptions {
  registryUrl?:  string;     // default: ${baseUrl}/api/providers,
                             // falling back to /providers
  evmPrivateKey?: `0x${string}`; // optional override; otherwise derived/generated
  budgetCaps?:   BudgetCaps;
  telemetry?:    boolean;    // default true
  polygonRpc?:   string;     // default: https://polygon.drpc.org
  /**
   * Where the daily cap is remembered.
   *
   * Omit it and the SDK picks: a file under ~/.aifinpay (or AIFINPAY_STATE_DIR)
   * once a daily cap is set, memory otherwise. Pass your own when the agent
   * runs on more than one host — a lock file cannot answer for a fleet.
   */
  spendLedger?:  SpendLedger;
  solanaRpc?:    string;     // default: env AIFINPAY_SOLANA_RPC or mainnet-beta
  /** RPC overrides for non-Polygon EVM chains — both bridge-flow chains
   *  and splitter-settlement chains (base, optimism, unichain, botchain,
   *  xrplevm). Splitter chains fall back to the public RPC listed in
   *  SPLITTER_DEPLOYMENTS when no override is given. */
  evmRpcUrls?:   Partial<Record<AnyEvmChainName, string>>;
}

// ── 402 challenge body shape returned by AiFinPay paid-proxy bridges ─────

/** The native-token payment block of a bridge 402. One shape, two key names —
 *  see EvmBridgeChallenge below for why both exist. */
interface PayNativeBlock {
    /** EVM chain the quote is denominated for. Legacy bridges emit
     *  "polygon"; newer bridges may emit any SplitterChainName. */
    chain:                 string;
    splitter:              string;
    /** Which B2BSplitter the address above is. Absent on older bridges, which
     *  is treated as "1.1" — the shape the entrypoint had before 2026-07-31. */
    splitter_version?:     "1.1" | "1.2";
    merchant_wallet:       string;
    total_wei:             string;
    merchant_amount_wei?:  string;
    treasury_amount_wei?:  string;
    ip_creator_amount_wei?: string;
    /** Optional royalty recipient. When absent the SDK routes the slot to
     *  the splitter's treasury (zero-address would strand the 1bp in the
     *  contract — B2BSplitter has no sweep function). */
    ip_creator?:           string;
    order_id:              string;
    function_signature?:   string;
    ttl_seconds?:          number;
    /** v1.2 bridges precompute keccak(order_id); the SDK derives it anyway. */
    payment_id?:           string;
}

interface PayMaticChallenge {
  error:    string;
  protocol: string;
  service:  string;
  facilitator?: string;
  /** The production bridges renamed this block to `pay_native` on 2026-08-04
   *  when payMatic became payNative on-chain — and every SDK branch kept
   *  reading only `pay_matic`, so agent.call() failed against every live
   *  bridge with an error blaming facilitator wiring (AIFINP-118). Both names
   *  are accepted; `pay_native` wins when a bridge sends both. */
  pay_native?: PayNativeBlock;
  pay_matic?:  PayNativeBlock;
  pay_solana?: {
    chain:                       "solana";
    program_id:                  string;
    instruction:                 string;     // expected "b2b_pay_with_split"
    merchant_wallet:             string;     // base58
    treasury:                    string;     // base58
    merchant_amount_lamports:    string;
    treasury_amount_lamports?:   string;
    ip_creator_amount_lamports?: string;
    total_lamports?:             string;
    order_id:                    string;
    asset?:                      string;
    ttl_seconds?:                number;
  };
  retry?: unknown;
  instructions?: string[];
}

/**
 * The native-token payment block of a bridge 402, whichever key it arrived
 * under.
 *
 * Both names, newest first. The production bridges renamed the block
 * `pay_matic` → `pay_native` on 2026-08-04 when the on-chain entrypoint became
 * `payNative` — and no SDK branch followed, so `agent.call()` failed against
 * every live bridge with an error blaming facilitator wiring (AIFINP-118).
 * Exported so the captured-fixture test drives this exact function; the
 * original bug survived because the tests built their 402s in the SDK's own
 * vocabulary and never met a real one.
 */
export function nativePayBlock(
  challenge: PayMaticChallenge,
): PayNativeBlock | undefined {
  return challenge.pay_native ?? challenge.pay_matic;
}

// ── B2BSplitter contract ABI ─────────────────────────────────────────────
// `payMatic` is the splitter's generic NATIVE-token payment entrypoint —
// the name is a Polygon-era legacy. On Base/Optimism/Unichain it settles
// ETH, on BOT Chain BOT, on XRPL EVM XRP. There is no ERC-20/USDC path in
// the deployed splitter payment flow yet — native-token only.

const SPLITTER_PAY_MATIC_ABI = [
  {
    type: "function",
    name: "payMatic",
    stateMutability: "payable",
    inputs: [
      { type: "address", name: "merchant" },
      { type: "address", name: "ipCreator" },
      { type: "string",  name: "orderId" },
    ],
    outputs: [],
  },
] as const;

// v1.2 entrypoint. The signature was read off the deployed contract rather than
// from a spec: selector 0x8f0122bb, confirmed against the mainnet proof payment
// 0xbffcdbd2…72d3. The redeploy note describes it as "payNative taking a
// bytes32 paymentId", which is true but incomplete — it takes four arguments,
// and calling it with one produces a revert that looks like a contract fault.
const SPLITTER_PAY_NATIVE_ABI = [
  {
    type: "function",
    name: "payNative",
    stateMutability: "payable",
    inputs: [
      { type: "bytes32", name: "paymentId" },
      { type: "address", name: "merchant" },
      { type: "address", name: "ipCreator" },
      { type: "string",  name: "memo" },
    ],
    outputs: [],
  },
] as const;

/**
 * Derive the on-chain paymentId from the quote's order id.
 *
 * Deliberately deterministic. v1.2 rejects a paymentId it has already settled,
 * and that guarantee is only worth something if the id is bound to the order:
 * a random id would let the same order be paid twice, which is precisely what
 * the guard exists to prevent. A retry after a *reverted* transaction is still
 * fine — a revert consumes nothing on-chain.
 */
export function paymentIdFor(orderId: string): `0x${string}` {
  return keccak256(toHex(orderId));
}

// ── B2BSplitter multi-chain deployment registry ──────────────────────────
//
// Chains where the fee-on-top B2BSplitter contract is DEPLOYED AND VERIFIED
// on-chain (eth_getCode returned bytecode for every address below,
// 2026-07-15). Do NOT add chains here without re-running that check.
//
// BOT Chain (677) and XRPL EVM (1440000) are not shipped with viem/chains.
// They live in ./chains.js so this module and splitterRoutes.ts cannot drift
// apart on a chain id or RPC.

/** EVM chains with a live, on-chain-verified B2BSplitter deployment. */
export type SplitterChainName =
  | "polygon"
  | "base"
  | "optimism"
  | "unichain"
  | "botchain"
  | "xrplevm";

export interface SplitterDeployment {
  chainId:    number;
  /** viem chain object used for tx signing on this chain. */
  chain:      Chain;
  /** Public RPC used when no evmRpcUrls override is supplied. */
  defaultRpc: string;
  /**
   * Deployed B2BSplitter version. v1.2 added a bytes32 paymentId replay guard
   * and renamed the native entrypoint, so the ABI differs per chain — Base and
   * Unichain were not part of the 2026-07-31 rollout and still run v1.1.
   */
  version: "1.1" | "1.2";
  /** B2BSplitter contract address (native-token entrypoint). */
  splitter:   `0x${string}`;
  /**
   * Circle-native USDC on this chain, when one exists. Informational for
   * now: the splitter payment path is native-token only (payMatic) — no
   * ERC-20 settlement path is implemented in the SDK or deployed splitter.
   */
  usdc?:      `0x${string}`;
  explorer:   string;
  /** Env var consulted for the native-token USD price used by the
   *  pre-sign challenge guard. An operator who sets it means it, so it wins.
   *
   *  `nativeUsdDefault` is NOT consulted by the guard any more — see
   *  nativeUsdFor(). It survives as published reference data only. A constant
   *  in a blocking guard is what made this SDK reject valid payments: POL sat
   *  at 0.70 here while trading near 0.073, so every quote looked ten times
   *  its cost and BudgetCapExceededError fired before any money moved. */
  nativeUsdEnv:     string;
  nativeUsdDefault: number;
}

export const SPLITTER_DEPLOYMENTS: Record<SplitterChainName, SplitterDeployment> = {
  polygon: {
    version:    "1.2",
    chainId:    137,
    chain:      polygon,
    defaultRpc: "https://polygon.drpc.org",
    splitter:   "0xbD1fa5453f212F096c0213788a645eC597FB4DDe",
    usdc:       "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
    explorer:   "https://polygonscan.com",
    nativeUsdEnv: "AIFINPAY_MATIC_USD", // legacy name kept for back-compat
    nativeUsdDefault: 0.073, // reference only; ~$0.073 on 2026-08-03
  },
  base: {
    version:    "1.1",
    chainId:    8453,
    chain:      base,
    defaultRpc: "https://mainnet.base.org",
    splitter:   "0x8Ad9830D16b1f10333866a3f38C949CbB19f4BAD",
    usdc:       "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
    explorer:   "https://basescan.org",
    nativeUsdEnv: "AIFINPAY_ETH_USD",
    nativeUsdDefault: 1870, // reference only; ~$1870 on 2026-08-03
  },
  optimism: {
    version:    "1.2",
    chainId:    10,
    chain:      optimism,
    defaultRpc: "https://mainnet.optimism.io",
    splitter:   "0xF03B3387415D557b6ab709D06E8aF0b4ABD6Eb74",
    usdc:       "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
    explorer:   "https://optimistic.etherscan.io",
    nativeUsdEnv: "AIFINPAY_ETH_USD",
    nativeUsdDefault: 1870, // reference only; ~$1870 on 2026-08-03
  },
  unichain: {
    version:    "1.1",
    chainId:    130,
    chain:      unichain,
    defaultRpc: "https://mainnet.unichain.org",
    splitter:   "0xeE92807decAa3A02F1e165dd7Efcd92ab9aA83CB",
    usdc:       "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
    explorer:   "https://uniscan.xyz",
    nativeUsdEnv: "AIFINPAY_ETH_USD",
    nativeUsdDefault: 1870, // reference only; ~$1870 on 2026-08-03
  },
  botchain: {
    version:    "1.2",
    chainId:    677,
    chain:      botchain,
    defaultRpc: "https://rpc.botchain.ai",
    splitter:   "0x147d8fF8c027E24303b5B99CbC8843e1D3dF94cC",
    // no USDC on BOT Chain — native BOT only
    explorer:   "https://scan.botchain.ai",
    nativeUsdEnv: "AIFINPAY_BOT_USD",
    nativeUsdDefault: 1, // no reliable public feed; set the env var
  },
  xrplevm: {
    version:    "1.2",
    chainId:    1440000,
    chain:      xrplevm,
    defaultRpc: "https://rpc.xrplevm.org",
    splitter:   "0x147d8fF8c027E24303b5B99CbC8843e1D3dF94cC",
    // no verified USDC on XRPL EVM — native XRP only
    explorer:   "https://explorer.xrplevm.org",
    nativeUsdEnv: "AIFINPAY_XRP_USD",
    nativeUsdDefault: 2,
  },
};

// ── EVM chain object lookup — viem chains keyed by our EvmChainName ─────

const EVM_CHAIN_OBJECTS: Record<EvmChainName, Chain> = {
  ethereum: mainnet,
  polygon,
  bsc,
  arbitrum,
  optimism,
  base,
};

/**
 * Union of every EVM chain name the SDK knows an RPC/client for: LiFi
 * bridge chains (EvmChainName) + splitter deployment chains. Used for
 * evmRpcUrls overrides and the internal client cache.
 */
export type AnyEvmChainName = EvmChainName | SplitterChainName;

function evmChainObject(name: AnyEvmChainName): Chain | undefined {
  return (
    (EVM_CHAIN_OBJECTS as Partial<Record<string, Chain>>)[name]
    ?? (SPLITTER_DEPLOYMENTS as Partial<Record<string, SplitterDeployment>>)[name]?.chain
  );
}

// Mainnet USDC SPL mint on Solana (Circle native, not Wormhole-wrapped USDCet)
const USDC_SOLANA_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

// Native Polygon USDC ERC20 (Circle-native, not bridged USDC.e)
const USDC_POLYGON_ERC20 = "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359" as const;

// Minimal ERC20 balanceOf ABI fragment
const ERC20_BALANCE_OF_ABI = [
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ type: "address", name: "owner" }],
    outputs: [{ type: "uint256" }],
  },
] as const;

// B2BSplitter.treasury() view — used to route the ipCreator royalty slot
// when the bridge challenge doesn't name a recipient.
const SPLITTER_TREASURY_ABI = [
  {
    type: "function",
    name: "treasury",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
] as const;

// ── Errors ─────────────────────────────────────────────────────────────────

export class ProviderUnknownError extends AiFinPayError {}
export class WrongChainBalanceError extends AiFinPayError {
  constructor(public has: ChainId[], public needed: ChainId, msg: string) {
    super(msg);
  }
}
export class InsufficientFundsError extends AiFinPayError {
  /**
   * `details` carries the native amounts, which are what the caller acts on —
   * the USD figures depend on a price feed that may be unavailable, and an
   * error about missing funds is the worst possible place to invent a number.
   */
  constructor(
    public needed_usd: number,
    public available_usd: number,
    msg: string,
    public readonly details?: {
      address: string;
      chain: string;
      symbol: string;
      needed_wei: string;
      available_wei: string;
    },
  ) {
    super(msg);
  }
}
export class BudgetCapExceededError extends AiFinPayError {
  constructor(public kind: "daily" | "per_call", msg: string) {
    super(msg);
  }
}
export class SettlementError extends AiFinPayError {
  constructor(public reason: string, public txHash?: string) {
    super(`Settlement failed: ${reason}${txHash ? ` (tx ${txHash})` : ""}`);
  }
}
export class SessionExpiredError extends AiFinPayError {
  constructor(public session_id: string) {
    super(`Session ${session_id} expired or closed`);
  }
}

// ── Spend tracker (24h rolling) ────────────────────────────────────────────

class SpendTracker {
  private readonly ring: Array<{ at: number; usd: number }> = [];
  add(usd: number): void {
    const now = Date.now();
    this.ring.push({ at: now, usd });
    const cutoff = now - 24 * 3600 * 1000;
    while (this.ring.length && this.ring[0]!.at < cutoff) this.ring.shift();
  }
  total24h(): number {
    return this.ring.reduce((s, e) => s + e.usd, 0);
  }
}

// ── Main class ─────────────────────────────────────────────────────────────

// Which path serves the registry depends on the host, and the two disagree:
//
//   aifinpay.io/api/providers      → JSON   (this is the default base; it works)
//   aifinpay.io/providers          → 200 HTML — the SPA catch-all, NOT an error
//   api.aifinpay.io/providers      → JSON   (that host rewrites ^/(.*) → /api/$1)
//   api.aifinpay.io/api/providers  → 404
//
// /api/providers therefore goes first: it is correct for the default base URL,
// and guessing wrong there returns a clean 404 instead of 200-with-HTML.
// Ordering it the other way — as 1.3.2 shipped — makes the default base fetch
// the SPA shell and die inside JSON.parse.
const DEFAULT_REGISTRY_PATHS = ["/api/providers", "/providers"] as const;
const DEFAULT_REGISTRY_PATH = DEFAULT_REGISTRY_PATHS[0];

/**
 * A published entry in the public AiFinPay agent network — what `search()`
 * returns and `register()` produces. Identity is the agent's EVM address.
 */
export interface NetworkAgent {
  address:      string;
  name:         string | null;
  description:  string | null;
  endpoint:     string | null;
  capabilities: string[];
  pricing:      { per_call: number; currency: string } | null;
  rating:       number | null;
  published_at: number | null;
  created_at:   number | null;
}

export class AiFinPayAgent {
  readonly inner:        Agent;            // existing Solana-flavoured agent
  readonly evmAccount:   PrivateKeyAccount;
  readonly registryUrl:  string;
  /** Fallback registry URLs, tried in order when `registryUrl` was defaulted. */
  private  registryCandidates: string[];
  readonly polygonRpc:   string;
  readonly solanaRpc:    string;
  private  cachedRegistry?: ProviderEntry[];
  private  budgetCaps:     BudgetCaps;
  private  spend24h        = new SpendTracker();  // reporting only; the cap uses the ledger
  private  _ledger?:       SpendLedger;
  private  ledgerOverride?: SpendLedger;
  private  telemetry:      boolean;
  private  _polygonPublic?: PublicClient;
  private  _polygonWallet?: WalletClient;
  // Multi-chain client cache for cross-chain orchestration (bridge flows).
  // Keyed by EVM chain name (see crossChain.ts EVM_CHAINS).
  private  _evmClients: Map<AnyEvmChainName, { publicClient: PublicClient; walletClient: WalletClient }> = new Map();
  private  evmRpcUrls: Partial<Record<AnyEvmChainName, string>> = {};

  private constructor(
    inner:      Agent,
    evmAccount: PrivateKeyAccount,
    opts:       AiFinPayAgentOptions = {},
  ) {
    this.inner       = inner;
    this.evmAccount  = evmAccount;
    this.registryUrl = opts.registryUrl
      ?? `${inner.baseUrl}${DEFAULT_REGISTRY_PATH}`;
    this.registryCandidates = opts.registryUrl
      ? [opts.registryUrl]
      : DEFAULT_REGISTRY_PATHS.map((path) => `${inner.baseUrl}${path}`);
    this.budgetCaps  = opts.budgetCaps ?? {};
    // `spendLedger` was declared, documented ("pass your own when the agent
    // runs on more than one host") and read by the `ledger` getter, but never
    // assigned from the options — so the option was a no-op and every agent
    // with a daily cap wrote to ~/.aifinpay regardless. A fleet that supplied
    // a shared ledger silently got a per-host one instead, which is exactly
    // the failure the option exists to prevent.
    if (opts.spendLedger) this.ledgerOverride = opts.spendLedger;
    this.telemetry   = opts.telemetry !== false;
    this.polygonRpc  = opts.polygonRpc ?? "https://polygon.drpc.org";
    this.solanaRpc   = opts.solanaRpc
      ?? process.env.AIFINPAY_SOLANA_RPC
      ?? "https://api.mainnet-beta.solana.com";
    // Optional RPC overrides for non-Polygon EVM chains used in bridge flows.
    // Falls back to viem's chain.rpcUrls.default if not provided.
    if (opts.evmRpcUrls) this.evmRpcUrls = opts.evmRpcUrls;
    if (this.polygonRpc) this.evmRpcUrls.polygon = this.polygonRpc;
  }

  // Lazy viem clients — only spun up when a Polygon flow runs.
  // Kept as-is for the legacy call() Polygon path; cross-chain flows use
  // evmClients() below which is generalised across all supported EVM chains.
  private polygonClients(): { publicClient: PublicClient; walletClient: WalletClient } {
    if (!this._polygonPublic) {
      this._polygonPublic = createPublicClient({
        chain: polygon,
        transport: http(this.polygonRpc),
      });
    }
    if (!this._polygonWallet) {
      this._polygonWallet = createWalletClient({
        chain: polygon,
        transport: http(this.polygonRpc),
        account: this.evmAccount,
      });
    }
    return { publicClient: this._polygonPublic, walletClient: this._polygonWallet };
  }

  // Multi-EVM-chain client cache. Used by bridge orchestration AND splitter
  // settlement on chains other than Polygon. Picks viem's built-in chain
  // definitions (or our defineChain() entries for botchain/xrplevm); an
  // optional RPC override per chain can be supplied via opts.evmRpcUrls,
  // else splitter chains use SPLITTER_DEPLOYMENTS.defaultRpc, else viem's
  // chain default.
  private evmClients(name: AnyEvmChainName): { publicClient: PublicClient; walletClient: WalletClient } {
    const cached = this._evmClients.get(name);
    if (cached) return cached;

    const chain = evmChainObject(name);
    if (!chain) {
      throw new AiFinPayError(`evmClients: unsupported EVM chain "${name}"`);
    }
    const rpcUrl = this.evmRpcUrls[name]
      ?? (SPLITTER_DEPLOYMENTS as Partial<Record<string, SplitterDeployment>>)[name]?.defaultRpc;
    const transport = rpcUrl ? http(rpcUrl) : http();

    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({ chain, transport, account: this.evmAccount });
    const pair = { publicClient, walletClient };
    this._evmClients.set(name, pair);
    return pair;
  }

  // Clients for a splitter-settlement chain. Polygon keeps its dedicated
  // client pair (honours the polygonRpc option byte-for-byte); every other
  // registry chain goes through the generic evmClients cache.
  private splitterClients(name: SplitterChainName): { publicClient: PublicClient; walletClient: WalletClient } {
    if (name === "polygon") return this.polygonClients();
    return this.evmClients(name);
  }

  // ── Constructors ─────────────────────────────────────────────────────────

  /**
   * Generate a fresh agent — new Solana keypair + new EVM keypair.
   * Use `fromSeed()` to derive both from a single backup phrase instead.
   */
  static async new(opts: AiFinPayAgentOptions = {}): Promise<AiFinPayAgent> {
    // Seed-derived, NOT an independent random EVM key.
    //
    // This used to be `generatePrivateKey()`, which made `new()` the only
    // constructor whose EVM key could not be reproduced from anything the user
    // was able to back up: every recovery path (fromSeed, fromSolanaSecret)
    // derives the EVM key from the Solana seed, so restoring returned a
    // DIFFERENT EVM address and any balance funded on the original was
    // unreachable.
    //
    // Deriving from one random seed makes the Solana secret a complete backup —
    // `fromSolanaSecret()` reads the same 32-byte seed and lands on the same
    // EVM address. An explicit `evmPrivateKey` still overrides, for callers
    // importing a pre-existing EVM wallet.
    if (opts.evmPrivateKey) {
      const inner = Agent.new(opts);
      return new AiFinPayAgent(inner, privateKeyToAccount(opts.evmPrivateKey), opts);
    }
    return AiFinPayAgent.fromSeed(bytesToHex(randomBytes(32)), opts);
  }

  /**
   * Derive both keypairs from a single 32-byte hex seed. Same seed →
   * deterministic Solana pubkey AND EVM address. One backup phrase, two
   * chains.
   *
   * Solana key = nacl.sign.keyPair.fromSeed(seed)
   * EVM key    = SHA-256("aifinpay:evm:v1\0" || seed)
   *              (domain-separated; independent path; not BIP-44 — see
   *               design notes in 23 - Unified SDK Design. This is the
   *               canonical derivation both SDKs implement — the Python
   *               SDK mirrors it byte-for-byte.)
   *
   * TODO(phase-1): replace with BIP-39/BIP-44 derivation
   *   m/44'/501'/0'/0' (Solana) + m/44'/60'/0'/0/0 (EVM) once the
   *   wallet-import audit recommendation lands.
   */
  static async fromSeed(
    seedHex: string,
    opts: AiFinPayAgentOptions = {},
  ): Promise<AiFinPayAgent> {
    const seed = hexToBytes(seedHex.replace(/^0x/, ""));
    if (seed.length !== 32) {
      throw new AiFinPayError(`fromSeed: seed must be 32 bytes (64 hex chars)`);
    }
    const kp = nacl.sign.keyPair.fromSeed(seed);
    const inner = (Agent as unknown as { _ofKeyPair(kp: nacl.SignKeyPair, opts?: AgentOptions): Agent })
      ._ofKeyPair?.(kp, opts) ?? Agent.fromSecretB58(bs58.encode(kp.secretKey), opts);

    // Derive EVM key from seed (independent, not BIP-44 — see TODO above)
    const evmHex = ("0x" + bytesToHex(crypto32(seed))) as `0x${string}`;
    const evmAccount = privateKeyToAccount(evmHex);
    return new AiFinPayAgent(inner, evmAccount, opts);
  }

  /**
   * Legacy: load the Solana side from an existing keypair. The EVM key is
   * derived deterministically from the Solana secret's 32-byte seed
   * (domain-separated SHA-256, same path as `fromSeed`) unless an explicit
   * `opts.evmPrivateKey` is provided.
   *
   * Why deterministic: a random key here would change the EVM address on
   * every process restart — anything sent to the previous address becomes
   * unrecoverable because the key was never persisted or printed. With
   * derivation, the same AIFINPAY_AGENT_SECRET always reproduces the same
   * EVM address (this is what the MCP server relies on).
   */
  static async fromSolanaSecret(
    secretB58: string,
    opts: AiFinPayAgentOptions = {},
  ): Promise<AiFinPayAgent> {
    const inner = Agent.fromSecretB58(secretB58, opts);
    const evmKey = opts.evmPrivateKey
      ?? (("0x" + bytesToHex(crypto32(inner.secretKey.subarray(0, 32)))) as `0x${string}`);
    const evmAccount = privateKeyToAccount(evmKey);
    return new AiFinPayAgent(inner, evmAccount, opts);
  }

  // ── Identity ────────────────────────────────────────────────────────────

  get id(): string {
    // Canonical: Solana pubkey for back-compat with the leaderboard / Seat PDA.
    return this.inner.address;
  }
  get solanaAddress(): string { return this.inner.address; }
  get evmAddress():    string { return this.evmAccount.address; }

  /**
   * Casper identity, derived from the same seed as the other two.
   *
   * A getter rather than a stored field, for the same reason the EVM key is
   * derived rather than generated: the agent's identity on every chain has to
   * be reproducible from one secret. Anything else means an address that
   * changes on restart, and funds sent to the old one are unrecoverable.
   *
   * Returns the tagged public key Casper tooling expects (01 = ed25519) and the
   * account hash. Verified against mainnet — see casperIdentityFromSeed.
   */
  get casper(): { publicKey: string; accountHash: string } {
    return casperIdentityFromSeed(this.inner.secretKey.subarray(0, 32));
  }

  /** Convenience: the account hash, which is what a Casper explorer wants. */
  get casperAddress(): string { return this.casper.accountHash; }

  // ── Registry ────────────────────────────────────────────────────────────

  async fetchRegistry(force = false): Promise<ProviderEntry[]> {
    if (this.cachedRegistry && !force) return this.cachedRegistry;
    // Only a 404 moves on to the next candidate — any other status is the
    // registry answering badly, and retrying a different path would just hide
    // it behind a misleading error about the last URL tried.
    const attempts: string[] = [];
    for (const url of this.registryCandidates) {
      let r: Response;
      try {
        r = await fetch(url);
      } catch (err) {
        attempts.push(`${url} → ${(err as Error).message}`);
        continue;
      }
      if (r.status === 404) {
        attempts.push(`${url} → 404`);
        continue;
      }
      if (!r.ok) {
        throw new AiFinPayError(`provider registry ${url} → ${r.status}`);
      }
      // A 200 is not proof this was the registry: a single-page-app catch-all
      // answers 200 with HTML for any unknown path. Treat anything that is not
      // a registry document as a miss and keep looking, instead of dying inside
      // JSON.parse with an error that points nowhere near the real cause.
      let j: { providers?: ProviderEntry[] };
      try {
        j = (await r.json()) as { providers?: ProviderEntry[] };
      } catch {
        attempts.push(`${url} → 200 but not JSON`);
        continue;
      }
      if (!Array.isArray(j?.providers)) {
        attempts.push(`${url} → 200 JSON without a providers array`);
        continue;
      }
      this.cachedRegistry = j.providers;
      return this.cachedRegistry;
    }
    throw new AiFinPayError(
      `provider registry unreachable (tried ${attempts.join(", ")})`,
    );
  }

  async resolveProvider(name: string): Promise<ProviderEntry> {
    const reg = await this.fetchRegistry();
    const hit = reg.find((p) => p.name === name);
    if (!hit) {
      throw new ProviderUnknownError(`Provider "${name}" not in registry ${this.registryUrl}`);
    }
    return hit;
  }

  // ── Network directory ─────────────────────────────────────────────────────

  /**
   * Publish this agent to the public AiFinPay network so other agents can
   * discover and call it. Self-sovereign: proves control of the EVM address by
   * signing a one-time nonce with the agent's own key (EIP-191) — no partner
   * account needed.
   */
  async register(opts: {
    name:          string;
    endpoint:      string;
    description?:  string;
    capabilities?: string[];
    pricing?:      { perCall: number; currency?: string };
  }): Promise<NetworkAgent> {
    const base = this.inner.baseUrl;
    const addr = this.evmAddress.toLowerCase();

    const nonce = await this.networkNonce();
    const message = `AiFinPay-network-publish:polygon:${addr}:${nonce}`;
    const signature = await this.evmAccount.signMessage({ message });

    const r = await fetch(`${base}/api/network/agents/${addr}/publish`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name:         opts.name,
        description:  opts.description ?? null,
        endpoint:     opts.endpoint,
        capabilities: opts.capabilities ?? [],
        pricing:      opts.pricing
          ? { per_call: opts.pricing.perCall, currency: opts.pricing.currency ?? "USDC" }
          : null,
        nonce,
        signature,
      }),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; agent?: NetworkAgent; error?: string };
    if (!r.ok || !j.ok || !j.agent) {
      throw new AiFinPayError(`network publish failed: ${j.error ?? r.status}`);
    }
    return j.agent;
  }

  /** Remove this agent from the public network directory (same signature proof). */
  async unregister(): Promise<void> {
    const base = this.inner.baseUrl;
    const addr = this.evmAddress.toLowerCase();
    const nonce = await this.networkNonce();
    const message = `AiFinPay-network-unpublish:polygon:${addr}:${nonce}`;
    const signature = await this.evmAccount.signMessage({ message });
    const r = await fetch(`${base}/api/network/agents/${addr}/unpublish`, {
      method:  "POST",
      headers: { "content-type": "application/json" },
      body:    JSON.stringify({ nonce, signature }),
    });
    if (!r.ok) {
      const j = (await r.json().catch(() => ({}))) as { error?: string };
      throw new AiFinPayError(`network unpublish failed: ${j.error ?? r.status}`);
    }
  }

  /**
   * Search the public network for agents advertising a capability or matching a
   * free-text query. Pass a bare string to search by capability
   * (`agent.search("weather")`) or an object for finer control. Returns the
   * directory entries; invoking one (pay + call) lands in a later release.
   */
  async search(
    query: string | { capability?: string; q?: string; limit?: number },
  ): Promise<NetworkAgent[]> {
    const base = this.inner.baseUrl;
    const params = new URLSearchParams();
    if (typeof query === "string") {
      params.set("capability", query);
    } else {
      if (query.capability) params.set("capability", query.capability);
      if (query.q)          params.set("q", query.q);
      if (query.limit)      params.set("limit", String(query.limit));
    }
    const r = await fetch(`${base}/api/network/agents?${params.toString()}`);
    if (!r.ok) throw new AiFinPayError(`network search ${base} → ${r.status}`);
    const j = (await r.json()) as { agents?: NetworkAgent[] };
    return j.agents ?? [];
  }

  private async networkNonce(): Promise<string> {
    const r = await fetch(`${this.inner.baseUrl}/api/network/nonce`);
    if (!r.ok) throw new AiFinPayError(`network nonce → ${r.status}`);
    const { nonce } = (await r.json()) as { nonce: string };
    if (!nonce) throw new AiFinPayError("network nonce: empty response");
    return nonce;
  }

  // ── Budget caps ─────────────────────────────────────────────────────────

  setBudget(caps: BudgetCaps): void {
    this.budgetCaps = caps;
  }

  /**
   * Internal pre-call check. Returns `false` only when on_limit_exceeded
   * is "skip" and a cap is hit — `call()` should then resolve to null
   * without submitting an on-chain tx. Throws BudgetCapExceededError
   * in the default "throw" mode.
   */
  /**
   * The ledger that enforces the daily cap.
   *
   * Chosen late, because setBudget() is usually called after construction and
   * the choice depends on whether a daily cap exists at all. Durability is
   * engaged only when one does: a library that writes to a user's disk because
   * it was imported would be rude, and one that promises a daily limit and
   * forgets it on restart is worse.
   */
  private get ledger(): SpendLedger {
    if (this.ledgerOverride) return this.ledgerOverride;
    if (!this._ledger) {
      this._ledger = this.budgetCaps.daily_usd !== undefined
        ? FileSpendLedger.forAgent(this.evmAddress)
        : new MemorySpendLedger();
    }
    return this._ledger;
  }

  /**
   * Claim room in the daily cap before paying.
   *
   * Returns a reservation id, or "skip"/throws per on_limit_exceeded. The cap
   * comparison happens inside the ledger, atomically: a caller that read the
   * total and then reserved would have rebuilt the race this replaces, where
   * two concurrent calls both read the same total, both passed, and both paid.
   */
  private async reserveDaily(costUsd: number): Promise<string | null | "skip"> {
    const cap = this.budgetCaps.daily_usd;
    if (cap === undefined) return null;              // no daily cap to enforce
    const id = await this.ledger.reserve(costUsd, cap, 24 * 3600 * 1000);
    if (id) return id;
    const err = new BudgetCapExceededError(
      "daily",
      `this call would take daily spend past the $${cap} cap`,
    );
    if ((this.budgetCaps.on_limit_exceeded ?? "throw") === "skip") return "skip";
    throw err;
  }

  /**
   * The per-call cap, which needs no ledger.
   *
   * It is a property of one call and cannot be raced: nothing about a
   * concurrent call changes whether THIS one is too expensive. Only the daily
   * cap accumulates, and only it goes through reserve/commit.
   */
  private checkPerCall(costUsd: number): boolean {
    const cap = this.budgetCaps.per_call_usd;
    if (cap === undefined || costUsd <= cap) return true;
    const err = new BudgetCapExceededError(
      "per_call",
      `cost $${costUsd} exceeds per-call cap $${cap}`,
    );
    if ((this.budgetCaps.on_limit_exceeded ?? "throw") === "skip") return false;
    throw err;
  }

  private checkBudget(costUsd: number): boolean {
    const mode = this.budgetCaps.on_limit_exceeded ?? "throw";

    if (this.budgetCaps.per_call_usd !== undefined && costUsd > this.budgetCaps.per_call_usd) {
      const err = new BudgetCapExceededError(
        "per_call",
        `cost $${costUsd} exceeds per-call cap $${this.budgetCaps.per_call_usd}`,
      );
      if (mode === "skip") return false;
      throw err;
    }
    const after = this.spend24h.total24h() + costUsd;
    if (this.budgetCaps.daily_usd !== undefined && after > this.budgetCaps.daily_usd) {
      const err = new BudgetCapExceededError(
        "daily",
        `daily spend ${after.toFixed(4)} would exceed cap $${this.budgetCaps.daily_usd}`,
      );
      if (mode === "skip") return false;
      throw err;
    }
    return true;
  }

  /**
   * Current 24-hour rolling spend across all paid calls made by this
   * agent instance. Useful for budget dashboards on the consumer side.
   */
  getSpend24h(): number {
    return this.spend24h.total24h();
  }

  /**
   * Sanity-check the USD estimate of an on-chain challenge amount against
   * the declared cost and the per-call cap BEFORE signing the tx.
   *
   * The estimate uses env-priced MATIC/SOL (AIFINPAY_MATIC_USD /
   * AIFINPAY_SOL_USD — same stopgap as balance()), so it is approximate.
   * A 2x + $0.05 tolerance absorbs oracle drift while still catching the
   * dangerous case: a bridge that quotes $0.01 in the registry and then
   * demands 100x in the 402 challenge.
   *
   * Returns false (skip) instead of throwing when on_limit_exceeded="skip".
   */
  /**
   * The native-token USD price for the pre-sign guard.
   *
   * Order: an explicit env var, then the protocol's own price feed, then
   * nothing. "Nothing" is deliberate and is the whole point of this method.
   * The guard used to fall back to a constant compiled into the SDK; POL sat
   * at 0.70 while trading near 0.073, so a real $0.01 payment estimated at
   * $0.096, cleared the $0.06 ceiling and threw BudgetCapExceededError. The
   * payment never left, and the error blamed the bridge for demanding too
   * much.
   *
   * A guard that blocks on a number it cannot justify is worse than no guard,
   * so an unknown price returns NaN and guardChallengeAmount declines to
   * block. Overpayment protection is given up only in the case where we have
   * no basis for it, which is the honest trade.
   */
  private priceCache?: { at: number; usd: Record<string, number> };

  private async nativeUsdFor(
    deployment: SplitterDeployment,
  ): Promise<{ usd: number; source: string }> {
    const env = process.env[deployment.nativeUsdEnv];
    if (env !== undefined) {
      const v = parseFloat(env);
      if (Number.isFinite(v) && v > 0) return { usd: v, source: deployment.nativeUsdEnv };
    }

    const symbol = deployment.chain.nativeCurrency.symbol.toUpperCase();
    const fresh = this.priceCache && Date.now() - this.priceCache.at < 60_000;
    if (!fresh) {
      try {
        const r = await this.inner.fetchImpl(`${this.inner.baseUrl}/api/price/native`, {
          signal: AbortSignal.timeout(5_000),
        });
        if (r.ok) {
          const body = (await r.json()) as { usd?: Record<string, number> };
          if (body?.usd) this.priceCache = { at: Date.now(), usd: body.usd };
        }
      } catch {
        // A feed that will not answer is not a payment failure. Fall through
        // to "unknown" rather than to a guess.
      }
    }
    const live = this.priceCache?.usd?.[symbol];
    if (typeof live === "number" && Number.isFinite(live) && live > 0) {
      return { usd: live, source: "aifinpay price feed" };
    }
    return { usd: NaN, source: "unknown" };
  }

  /**
   * Refuse to broadcast a transaction the account cannot pay for, and say so
   * in terms the caller can act on.
   *
   * Without this the SDK handed back viem's ContractFunctionExecutionError —
   * several paragraphs explaining that cost is `gas * gas fee + value` — for
   * the one condition an agent operator can fix in ten seconds. Worse, the SDK
   * has exported an InsufficientFundsError since the first release and never
   * threw it, so anyone who wrote `catch (e instanceof InsufficientFundsError)`
   * had a branch that could not run.
   */
  private async assertCanAffordNative(
    publicClient: PublicClient,
    deployment: SplitterDeployment,
    valueWei: bigint,
  ): Promise<void> {
    const address = this.evmAccount.address;
    let balance: bigint;
    let gasPrice: bigint;
    try {
      [balance, gasPrice] = await Promise.all([
        publicClient.getBalance({ address }),
        publicClient.getGasPrice(),
      ]);
    } catch {
      // An RPC that will not answer must not turn into a funding error; let
      // the actual send produce the actual failure.
      return;
    }

    // A splitter payment lands around 120k gas; the headroom covers a fee
    // spike between this check and inclusion. Being generous here only makes
    // the check quieter, never wrong — a send that fails anyway still fails.
    const gasBudget = gasPrice * 200_000n;
    const needed = valueWei + gasBudget;
    if (balance >= needed) return;

    const symbol = deployment.chain.nativeCurrency.symbol;
    const chainName = deployment.chain.name;
    const short = (wei: bigint) => {
      const s = formatEther(wei);
      return s.includes(".") ? s.replace(/(\.\d{6})\d+$/, "$1").replace(/\.?0+$/, "") || "0" : s;
    };
    const { usd } = await this.nativeUsdFor(deployment);
    const toUsd = (wei: bigint) =>
      Number.isFinite(usd) ? (Number(wei) / 1e18) * usd : Number.NaN;

    throw new InsufficientFundsError(
      toUsd(needed),
      toUsd(balance),
      `Agent ${address} holds ${short(balance)} ${symbol} on ${chainName}, but this call needs ` +
        `about ${short(needed)} ${symbol} — ${short(valueWei)} for the payment and up to ` +
        `${short(gasBudget)} for gas. The gas figure is a ceiling: it assumes 200k gas at the ` +
        `current price, while a splitter payment typically uses closer to 120k. Fund the ` +
        `address with ${symbol} on ${chainName} and retry.`,
      {
        address,
        chain: chainName,
        symbol,
        needed_wei: needed.toString(),
        available_wei: balance.toString(),
      },
    );
  }

  private guardChallengeAmount(estUsd: number, declaredCost: number, providerName: string): boolean {
    if (!Number.isFinite(estUsd) || estUsd <= 0) return true; // can't estimate — don't block
    const limits: number[] = [];
    if (declaredCost > 0) limits.push(Math.max(declaredCost * 2, declaredCost + 0.05));
    if (this.budgetCaps.per_call_usd !== undefined) limits.push(this.budgetCaps.per_call_usd);
    if (!limits.length) return true; // no cap declared anywhere — caller opted out
    const limit = Math.min(...limits);
    if (estUsd <= limit) return true;
    const err = new BudgetCapExceededError(
      "per_call",
      `bridge ${providerName} challenge demands ≈$${estUsd.toFixed(4)} on-chain, ` +
        `above the allowed $${limit.toFixed(4)} (declared cost/per-call cap). ` +
        `Set AIFINPAY_MATIC_USD / AIFINPAY_SOL_USD for a tighter estimate.`,
    );
    if ((this.budgetCaps.on_limit_exceeded ?? "throw") === "skip") return false;
    throw err;
  }

  // ── Routing — chain selection ───────────────────────────────────────────

  /**
   * Chain selection heuristic — see Obsidian/23 - Unified SDK Design §Routing.
   *
   *   1. Explicit override always wins (subject to provider acceptance).
   *   2. Cost ≤ $0.005 + Solana per-call live + Solana accepted → Solana
   *      (low gas wins for tiny calls).
   *   3. Cost > $0.05 + Polygon accepted → Polygon
   *      (better finality for high-value calls).
   *   4. Middle band → provider.preferred_chain.
   *   5. Fallback → first accepted chain.
   *
   * Solana per-call is gated on the deploy of `b2b_pay_with_split` —
   * until then `solana` selection raises in `call()`.
   */
  private pickChain(provider: ProviderEntry, opts: CallOptions): ChainId {
    const accepted = new Set<ChainId>(provider.accepted_chains);

    // 1. Override.
    if (opts.chain) {
      if (!accepted.has(opts.chain)) {
        throw new AiFinPayError(
          `Provider ${provider.name} does not accept ${opts.chain}; accepted: ${provider.accepted_chains.join(", ")}`,
        );
      }
      return opts.chain;
    }

    const cost = opts.cost ?? provider.price_usd;
    const solanaPerCallLive = process.env.AIFINPAY_SOLANA_PER_CALL === "live";

    // 2. Tiny calls → Solana.
    if (cost <= 0.005 && accepted.has("solana") && solanaPerCallLive) {
      return "solana";
    }
    // 3. Big calls → Polygon for finality.
    if (cost > 0.05 && accepted.has("polygon")) {
      return "polygon";
    }
    // 4. Middle band → preferred.
    if (accepted.has(provider.preferred_chain)) {
      return provider.preferred_chain;
    }
    // 5. Fallback.
    if (provider.accepted_chains[0]) return provider.accepted_chains[0];
    throw new AiFinPayError(
      `Provider ${provider.name} declares no accepted_chains`,
    );
  }

  // ── Verify (one-time on-chain registration) ─────────────────────────────

  /**
   * TODO(phase-4): mint AgentPassport on the cheapest chain available
   * with the requested `stake_usd`. For now wires only the Solana side
   * via the existing `reserveSeatInvoice` semantics.
   */
  async verify(_args?: { stake_usd?: number }): Promise<{ verified: boolean }> {
    throw new AiFinPayError("verify() not implemented yet — see migration phase 4");
  }

  // ── Funding (deposit) ───────────────────────────────────────────────────

  /**
   * TODO(phase-1): pick a chain (preferred USDC on Polygon for stability;
   * fallback Solana SOL). Return signed-tx instructions for the wallet.
   */
  async deposit(_usd: number, _opts?: { asset?: "USDC" | "USDT" | "SOL" | "MATIC"; chain?: ChainId }): Promise<unknown> {
    throw new AiFinPayError("deposit() not implemented yet — see migration phase 1.5");
  }

  // ── Cross-chain orchestration (Phase 1.5a: EVM↔EVM via LiFi) ────────────
  //
  // We orchestrate; we do not custody. The agent signs every step.
  // See Obsidian/21 - Unified Agent Economy non-goals.
  //
  // Typical flow for "agent has USDC on Base, merchant wants USDC on Polygon":
  //   const quote   = await agent.bridgeQuote({ fromChain: "base", toChain: "polygon", amount_usdc: 1.0 });
  //   const receipt = await agent.bridgeExecute(quote);                  // sign source tx
  //   const arrival = await agent.bridgeWaitForArrival(receipt.source_tx); // wait for dest
  //   // ...then proceed with agent.call({ provider, chain: "polygon" })

  /**
   * Quote a USDC-denominated cross-chain transfer via LiFi.
   *
   * The convenience overload takes a USD amount and the chain names; the
   * full overload accepts arbitrary token addresses for non-USDC corridors.
   * The agent's EVM address is used as both `fromAddress` and `toAddress`
   * unless overridden — bridging to a different recipient is rare for agents.
   */
  async bridgeQuote(
    opts: {
      fromChain: EvmChainName;
      toChain:   EvmChainName;
      // EITHER: USDC convenience — pass amount_usdc, defaults to native USDC on both chains.
      amount_usdc?: number;
      // OR: arbitrary token corridor — pass tokens + raw amount (base units).
      fromToken?: `0x${string}`;
      toToken?:   `0x${string}`;
      fromAmount?: string;
      // Common
      toAddress?: `0x${string}`;
      slippage?:  number;
    },
  ): Promise<BridgeQuote> {
    const fromToken = opts.fromToken ?? USDC_NATIVE[opts.fromChain];
    const toToken   = opts.toToken   ?? USDC_NATIVE[opts.toChain];
    const fromAmount = opts.fromAmount
      ?? (opts.amount_usdc !== undefined
            ? Math.round(opts.amount_usdc * 1e6).toString() // USDC has 6 decimals
            : undefined);
    if (!fromAmount) {
      throw new AiFinPayError(
        `bridgeQuote: provide either amount_usdc OR fromAmount (in base units)`,
      );
    }
    const quoteOpts: BridgeQuoteOptions = {
      fromChain:   opts.fromChain,
      toChain:     opts.toChain,
      fromToken,
      toToken,
      fromAmount,
      fromAddress: this.evmAccount.address as `0x${string}`,
      toAddress:   opts.toAddress ?? (this.evmAccount.address as `0x${string}`),
      slippage:    opts.slippage,
    };
    return crossChainQuote(quoteOpts);
  }

  /**
   * Execute a previously-fetched bridge quote. Signs and submits the source
   * transaction with the agent's EVM key on the SOURCE chain. Returns once
   * source-side inclusion is confirmed; dest-side arrival is async — call
   * `bridgeWaitForArrival(receipt.source_tx)` if you need to block on it.
   */
  async bridgeExecute(quote: BridgeQuote): Promise<BridgeReceipt> {
    const { publicClient, walletClient } = this.evmClients(quote.from.chain);
    return crossChainExecute(quote, walletClient, publicClient);
  }

  /**
   * Wait for the bridge to deliver on the destination chain. Wraps LiFi's
   * /status polling; timeout default is 30 minutes (Circle CCTP can take
   * 15-25 min on Polygon side). Throws AiFinPayError on timeout.
   */
  async bridgeWaitForArrival(
    sourceTxHash: `0x${string}`,
    opts:         { pollIntervalMs?: number; timeoutMs?: number } = {},
  ): Promise<{ status: "done" | "failed"; dest_tx?: string; raw: unknown }> {
    return bridgeWaitForArrival(sourceTxHash, opts);
  }

  // ── Call ────────────────────────────────────────────────────────────────

  /**
   * High-level paid call. Resolves the provider, picks a chain, builds the
   * payment, sends to the bridge, retries with payment proof.
   *
   * EVM settlement: per-call splitter via on-chain `B2BSplitter.payMatic()`
   * (generic native-token entrypoint) on any SPLITTER_DEPLOYMENTS chain —
   * polygon (default), base, optimism, unichain, botchain, xrplevm. Pass
   * `chain` in CallOptions to override (the provider must accept it).
   * Solana settlement: b2b_pay_with_split (live since 2026-05-18).
   *
   * Returns `null` (instead of a `Response`) iff a budget cap was hit
   * AND budget.on_limit_exceeded is set to "skip" — the call is dropped
   * silently. Default behaviour throws BudgetCapExceededError.
   */
  async call(opts: CallOptions): Promise<Response | null> {
    const provider = await this.resolveProvider(opts.provider);
    const chain    = this.pickChain(provider, opts);
    // Registry may carry price_usd: null — normalise to a finite number so a
    // null/NaN cost can't poison the SpendTracker and silently disable caps.
    const rawCost  = opts.cost ?? provider.price_usd;
    const cost     = typeof rawCost === "number" && Number.isFinite(rawCost) ? rawCost : 0;

    // The per-call cap still refuses outright; the daily one is reserved, so
    // that two calls in flight cannot both be told there is room.
    if (!this.checkPerCall(cost)) return null;
    const reservation = await this.reserveDaily(cost);
    if (reservation === "skip") return null;
    let settled = false;

    try {

      if (provider.mode === "session") {
        throw new AiFinPayError(
          `Provider ${provider.name} requires session mode — use openSession() (phase-3 feature)`,
        );
      }

      const url = opts.bridgeUrl ?? provider.bridge_url;
      if (!url) {
        throw new AiFinPayError(`Provider ${provider.name} has no bridge_url`);
      }

      const path = (() => {
        if (provider.service_type === "search")    return "/search";
        if (provider.service_type === "inference") return "/chat/completions";
        if (provider.service_type === "compute")   return "/run";
        if (provider.service_type === "analytics") return "/query";
        return "/";
      })();

      const buildInit = (extraHeaders: Record<string, string> = {}): RequestInit => ({
        method:  opts.method ?? "POST",
        headers: { "content-type": "application/json", ...extraHeaders },
        body:    opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
        // CallOptions.timeoutMs was previously declared but never applied.
        signal:  opts.signal
          ?? (opts.timeoutMs ? AbortSignal.timeout(opts.timeoutMs) : undefined),
      });

      // 1. Initial unauthenticated POST → expect 402 challenge from the bridge.
      const fullUrl = url.replace(/\/$/, "") + path;
      const initialResp = await this.inner.fetchImpl(fullUrl, buildInit());

      if (initialResp.status !== 402) {
        // Bridge didn't ask for payment — pass response through unchanged.
        // Nothing was paid, so the call does NOT count against budget caps.
        if (this.telemetry) this.reportTelemetry({ kind: "call", provider: provider.name, chain, cost, free: true });
        return initialResp;
      }

      let challenge: PayMaticChallenge;
      try {
        challenge = (await initialResp.json()) as PayMaticChallenge;
      } catch (e) {
        throw new X402Error(`bridge returned 402 with non-JSON body`);
      }

      // ── Solana branch (b2b_pay_with_split atomic split, live 2026-05-18) ──
      if (chain === "solana") {
        if (!challenge.pay_solana) {
          throw new X402Error(
            `Bridge ${provider.name} returned 402 without a pay_solana block. ` +
              `Either pick chain: "polygon" or ask the operator to set ` +
              `BRIDGE_MERCHANT_SOLANA on the bridge service.`,
          );
        }
        const ps = challenge.pay_solana;
        // Guard: the bridge controls the challenge — verify the demanded
        // amount is in the same ballpark as the declared cost / caps before
        // signing anything. Stops a misquoting bridge from draining the agent.
        {
          const lamports = Number(ps.total_lamports ?? ps.merchant_amount_lamports);
          const solUsd   = parseFloat(process.env.AIFINPAY_SOL_USD ?? "200");
          const estUsd   = (Number.isFinite(lamports) ? lamports / 1e9 : 0) * solUsd;
          const guarded  = this.guardChallengeAmount(estUsd, cost, provider.name);
          if (!guarded) return null;
        }
        const solTxSig = await this.submitSolanaB2BPayWithSplit(ps);
        const paidResp = await this.inner.fetchImpl(fullUrl, buildInit({
          "x-solana-tx": solTxSig,
          "x-order-id":  ps.order_id,
        }));
        if (!paidResp.ok) {
          const detail = await paidResp.text().catch(() => "<unreadable>");
          throw new AiFinPayError(
            `Bridge retry failed ${paidResp.status} after Solana payment ${solTxSig}: ${detail.slice(0, 300)}`,
          );
        }
      // Money moved here, and only here. The reservation becomes a
      // settled amount; the finally below then has nothing to release.
      this.spend24h.add(cost);
      if (typeof reservation === "string") {
        await this.ledger.commit(reservation, cost);
      }
      settled = true;
        if (this.telemetry) this.reportTelemetry({ kind: "call", provider: provider.name, chain, cost, tx: solTxSig });
        // @internal — attach settlement metadata for consumers (MCP, telemetry
        // dashboards) that need to surface the tx hash without an extra RPC
        // call. Response headers are read-only after construction so we use
        // an instance property + cast on the read side.
        (paidResp as unknown as { aifinpayTx?: string; aifinpayChain?: ChainId }).aifinpayTx = solTxSig;
        (paidResp as unknown as { aifinpayTx?: string; aifinpayChain?: ChainId }).aifinpayChain = "solana";
        return paidResp;
      }

      // ── EVM branch (B2BSplitter.payMatic — generic native-token atomic split) ──
      // Settles on any chain in SPLITTER_DEPLOYMENTS (polygon default; base,
      // optimism, unichain, botchain, xrplevm). Native token only — the
      // deployed splitter payment path has no ERC-20/USDC entrypoint.
      const pm = nativePayBlock(challenge);
      if (!pm) {
        throw new X402Error(
          `bridge ${provider.name} returned 402 with neither a pay_native nor a pay_matic block — it is speaking a protocol this SDK does not implement (fields: ${Object.keys(challenge).join(", ")})`,
        );
      }
      const deployment = SPLITTER_DEPLOYMENTS[chain];
      if (!deployment) {
        throw new AiFinPayError(
          `No B2BSplitter deployment registered for chain "${chain}" — supported: ${Object.keys(SPLITTER_DEPLOYMENTS).join(", ")}`,
        );
      }
      // Refuse to pay a quote denominated for another chain's native token:
      // total_wei quoted for POL on Polygon would be a massive overpay if
      // blindly re-sent as ETH on Base. Legacy bridges always emit "polygon".
      if (pm.chain && pm.chain !== chain) {
        throw new X402Error(
          `bridge ${provider.name} quoted a native payment for chain "${pm.chain}" but the call was routed to "${chain}" — refusing cross-denomination payment`,
        );
      }

      // Guard: same ballpark check as the Solana branch — never sign for an
      // amount wildly above the declared cost / per-call cap. Native-token
      // USD price per chain via SPLITTER_DEPLOYMENTS.nativeUsdEnv.
      {
        const wei = Number(pm.total_wei);
        const { usd: nativeUsd } = await this.nativeUsdFor(deployment);
        // NaN when no price is known — guardChallengeAmount then declines to
        // block rather than blocking on a guess. See nativeUsdFor().
        const estUsd  = (Number.isFinite(wei) ? wei / 1e18 : 0) * nativeUsd;
        const guarded = this.guardChallengeAmount(estUsd, cost, provider.name);
        if (!guarded) return null;
      }

      // 2. Submit the B2BSplitter payment on the selected chain's mainnet and
      // wait for it to land. Prefer the challenge's splitter address (current
      // bridge behaviour); fall back to the registry address for bridges that
      // omit it.
      const splitterAddress = (pm.splitter as `0x${string}` | undefined)
        ?? deployment.splitter;
      const txHash = await this.settleSplitterNative({
        chain,
        splitter:         splitterAddress,
        splitterVersion:  pm.splitter_version as "1.1" | "1.2" | undefined,
        merchantWallet:   pm.merchant_wallet as `0x${string}`,
        totalWei:         BigInt(pm.total_wei),
        orderId:          pm.order_id,
        ipCreator:        pm.ip_creator as `0x${string}` | undefined,
      });

      // 3. Retry the bridge with payment proof.
      const paidResp = await this.inner.fetchImpl(fullUrl, buildInit({
        "x-tx-hash":  txHash,
        "x-order-id": pm.order_id,
      }));
      if (!paidResp.ok) {
        const detail = await paidResp.text().catch(() => "<unreadable>");
        throw new AiFinPayError(
          `Bridge retry failed ${paidResp.status} after on-chain payment ${txHash}: ${detail.slice(0, 300)}`,
        );
      }

    // Money moved here, and only here. The reservation becomes a
    // settled amount; the finally below then has nothing to release.
    this.spend24h.add(cost);
    if (typeof reservation === "string") {
      await this.ledger.commit(reservation, cost);
    }
    settled = true;
      if (this.telemetry) this.reportTelemetry({ kind: "call", provider: provider.name, chain, cost, tx: txHash });
      // @internal — see Solana branch above for rationale on property-attach.
      (paidResp as unknown as { aifinpayTx?: string; aifinpayChain?: ChainId }).aifinpayTx = txHash;
      (paidResp as unknown as { aifinpayTx?: string; aifinpayChain?: ChainId }).aifinpayChain = chain;
      return paidResp;
    } finally {
      // Every path that did not move money gives the budget back now rather
      // than waiting for the reservation to expire — an early return, a
      // refused challenge, a revert, a thrown error. Missing one of them
      // would leak the cap and eventually stop the agent paying at all,
      // which is why this is a finally and not a branch.
      if (typeof reservation === "string" && !settled) {
        await this.ledger.release(reservation);
      }
    }
  }

  // ── EVM B2BSplitter native settlement — one quote in, one tx hash out ────
  //
  // Extracted from call() when a second caller needed the same settlement.
  // The version handling below is the reason it is one method and not two
  // copies: it was already wrong once, and a duplicate would only be fixed
  // in whichever copy the next revert happened to come from.
  //
  // Returns only after the transaction is included AND succeeded — a hash for
  // a reverted transaction would otherwise be handed to a merchant as proof of
  // a payment that never moved.
  private async settleSplitterNative(p: {
    chain:            SplitterChainName;
    /** Splitter address the SERVER handed us, not one looked up from a table
     *  — see the version note below for why that distinction matters. */
    splitter:         `0x${string}`;
    /** Only when the server states one; undefined means "ask the contract". */
    splitterVersion?: "1.1" | "1.2";
    merchantWallet:   `0x${string}`;
    totalWei:         bigint;
    orderId:          string;
    /** Royalty recipient; omitted → the splitter's own treasury. */
    ipCreator?:       `0x${string}`;
  }): Promise<`0x${string}`> {
    // call() has already checked this for the bridge flow; repeated here
    // because settlement is now reachable without going through call().
    const deployment = SPLITTER_DEPLOYMENTS[p.chain];
    if (!deployment) {
      throw new AiFinPayError(
        `No B2BSplitter deployment registered for chain "${p.chain}" — supported: ${Object.keys(SPLITTER_DEPLOYMENTS).join(", ")}`,
      );
    }

    // ipCreator routing: prefer the caller's explicit ip_creator; else route
    // the royalty slot to the splitter's treasury (mirrors the Solana branch).
    // Passing address(0) would skip the transfer and permanently strand the
    // 1bp inside B2BSplitter — the contract has no sweep function.
    const ipCreator = p.ipCreator
      ?? await this.splitterTreasury(p.splitter, p.chain)
      ?? "0x0000000000000000000000000000000000000000";
    const { publicClient, walletClient } = this.splitterClients(p.chain);
    // The entrypoint follows the deployed contract, not the SDK release: v1.2
    // (Polygon, Optimism, BOT Chain, XRPL EVM as of 2026-07-31) takes a bytes32
    // paymentId and rejects one it has already settled, while Base and Unichain
    // still run v1.1. Sending v1.2 calldata to a v1.1 contract reverts with no
    // useful reason, so this must be decided per chain.
    // An explicit `splitterVersion` wins — a server that states it knows what
    // it deployed. What it must NOT fall back to is this registry's
    // chain -> version entry, because the ADDRESS came from the server and
    // the version would come from a table: two sources that can disagree.
    //
    // In production they did. The Exa bridge still hands out the pre-v1.2
    // splitter 0xE34Fc0E6… and sends no version; the table says "polygon is
    // 1.2"; the SDK called payNative on a contract that only has payMatic, and
    // the payment reverted with nothing in the reason to explain it.
    //
    // So when the server is silent, ask the contract at the address we were
    // actually handed. The registry is used only if the chain cannot be read.
    const splitterVersion = p.splitterVersion
      ?? await this.detectSplitterVersion(p.splitter, p.chain, deployment.version);
    await this.assertCanAffordNative(publicClient, deployment, p.totalWei);

    const txHash = splitterVersion === "1.2"
      ? await walletClient.writeContract({
          address:      p.splitter,
          abi:          SPLITTER_PAY_NATIVE_ABI,
          functionName: "payNative",
          args: [
            paymentIdFor(p.orderId),
            p.merchantWallet,
            ipCreator,
            p.orderId,
          ],
          value: p.totalWei,
          chain: deployment.chain,
          account: this.evmAccount,
        })
      : await walletClient.writeContract({
          address:      p.splitter,
          abi:          SPLITTER_PAY_MATIC_ABI,
          functionName: "payMatic",
          args: [
            p.merchantWallet,
            ipCreator,
            p.orderId,
          ],
          value: p.totalWei,
          chain: deployment.chain,
          account: this.evmAccount,
        });

    // Wait for receipt (inclusion is enough on these fast-block chains).
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new AiFinPayError(`${deployment.chain.name} tx reverted: ${txHash}`);
    }
    return txHash;
  }

  // ── AIFP-1 merchant paywall (gateway.aifinpay.io) ───────────────────────
  //
  // The protocol lives in aifp1.ts; this is the wiring. Two things only the
  // agent can supply: the on-chain settlement above, and the budget caps —
  // aifp1Fetch owns neither, exactly as call() owns them for the bridge flow.

  private readonly _aifp1Cache = new Aifp1ReceiptCache();

  /**
   * The prepaid batches this agent is holding.
   *
   * Exposed because a batch is money the agent has already spent and has not
   * finished using: an operator deciding whether to shut an agent down, or a
   * test asserting that a receipt was reused, both need to see it. The entries
   * contain bearer JWTs — treat them like keys, and do not log them.
   */
  get aifp1Receipts(): Aifp1ReceiptCache { return this._aifp1Cache; }

  /**
   * AIFP-1 v1.3 settlement, wired exactly as specified on 2026-08-27:
   *
   *   protocol route → chain → resolveSettlingSplitterRoute → v1.3 tuple ABI
   *   → signing → splitter
   *
   * with no fallback to SPLITTER_DEPLOYMENTS and nothing taken from a server.
   * The contract address, its runtime hash and its owner all come from the
   * canonical registry; the chain re-confirms each of them immediately before
   * the wallet signs. The route must be enabled for settlement in that
   * registry — today none is, so this throws SplitterRouteNotSettlingError —
   * and enabling it is a registry decision made per chain-and-route after a
   * supervised paid settlement (scripts/supervised-settle.mjs), not something
   * this method can do.
   *
   * AIFP-1 quotes are denominated on Polygon (`quote.pay_to.polygon`), so the
   * chain is fixed here rather than read from the quote: a quote cannot move a
   * settlement to a chain the registry did not enable.
   *
   * Tests replace this method with a chain stub; production signs here.
   */
  private async settleAifp1NativeV13(p: {
    merchantWallet: `0x${string}`;
    grossWei: bigint;
    merchantWei: bigint;
    treasuryWei: bigint;
    creatorWei: bigint;
    validUntil: bigint;
    orderId: string;
  }): Promise<`0x${string}`> {
    const chain = "polygon" as const;
    // Throws unless the registry has enabled polygon:merchant-aifp1.
    const pin: TrustedSettlementRoutePin = trustedPinFromRegistry("AIFP-1", chain);
    const route: SplitterRouteDeployment = resolveSettlingSplitterRoute(chain, "merchant-aifp1");

    // The quote's split must be the registry's split. aifp1.ts has already
    // validated the quote's own arithmetic; this checks it against the
    // contract's immutable economics rather than against itself.
    const expectedTreasury = (p.grossWei * BigInt(route.treasuryBps)) / 10_000n;
    const expectedCreator = (p.grossWei * BigInt(route.ipCreatorBps)) / 10_000n;
    const expectedMerchant = p.grossWei - expectedTreasury - expectedCreator;
    if (p.treasuryWei !== expectedTreasury || p.creatorWei !== expectedCreator || p.merchantWei !== expectedMerchant) {
      throw new AiFinPayError(
        `AIFP-1 quote split ${p.merchantWei}/${p.treasuryWei}/${p.creatorWei} does not match the ` +
          `${route.treasuryBps}/${route.ipCreatorBps} bps profile of ${chain}:${route.route}`,
      );
    }
    if (route.ipCreatorBps === 0 && p.creatorWei !== 0n) {
      throw new AiFinPayError("AIFP-1 route carries no creator leg; a non-zero creator amount is not settleable");
    }

    const { publicClient, walletClient } = this.v13Clients(route);
    // Bytecode hash, bps and owner() read from the chain and compared to the
    // registry pin. Fails closed on any disagreement or unreachable RPC.
    await verifySettlementRouteOnChain(
      {
        route_class: "AIFP-1",
        chain,
        chain_id: route.chainId,
        splitter_version: "1.3",
        splitter: route.splitter,
        runtime_code_hash: route.runtimeCodeHash,
      } as unknown as Parameters<typeof verifySettlementRouteOnChain>[0],
      publicClient,
      pin,
    );

    const balance = await publicClient.getBalance({ address: this.evmAccount.address });
    if (balance < p.grossWei) {
      throw new AiFinPayError(
        `insufficient ${route.viemChain.nativeCurrency.symbol} on ${chain}: need ${p.grossWei} wei, have ${balance}`,
      );
    }

    const txHash = await walletClient.writeContract({
      address: route.splitter,
      abi: V13_ABI,
      functionName: "payNative",
      args: [{
        // The Payment event's paymentId and orderId are what the gateway
        // verifies against the quote id (order_id_mismatch otherwise).
        paymentId: paymentIdFor(p.orderId),
        merchant: p.merchantWallet,
        grossAmount: p.grossWei,
        ipCreator: "0x0000000000000000000000000000000000000000",
        validUntil: p.validUntil,
        orderId: p.orderId,
      }],
      value: p.grossWei,
      chain: route.viemChain,
      account: this.evmAccount,
    });
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new AiFinPayError(`${route.viemChain.name} v1.3 settlement reverted: ${txHash}`);
    }
    return txHash;
  }

  /**
   * Clients for a v1.3 registry route. Transport comes from the route entry
   * (or the caller's evmRpcUrls override) — never from SPLITTER_DEPLOYMENTS,
   * so the v1.3 path has no dependency on the legacy table at all.
   */
  private v13Clients(route: SplitterRouteDeployment): { publicClient: PublicClient; walletClient: WalletClient } {
    const override = (this.evmRpcUrls as Partial<Record<string, string>>)[route.chain]
      ?? (route.chain === "polygon" ? this.polygonRpc : undefined);
    const transport = http(override ?? route.defaultRpc);
    return {
      publicClient: createPublicClient({ chain: route.viemChain, transport }),
      walletClient: createWalletClient({ chain: route.viemChain, transport, account: this.evmAccount }),
    };
  }

  /**
   * Fetch a paywalled URL, paying the AIFP-1 gateway if it asks.
   *
   *   const res = await agent.fetchPaid("https://gateway.aifinpay.io/acme/articles/2026/x");
   *
   * A URL that is not paywalled — or that answers a 402 belonging to some
   * other protocol — comes back untouched and costs nothing. A paywalled one
   * is quoted, settled on-chain, exchanged for a receipt and retried, and the
   * receipt is kept: subsequent calls it covers cost a header rather than a
   * transaction. See aifp1.ts for why that reuse is the entire design.
   *
   * Returns `null` on the same terms as call(): a budget cap was hit and
   * `budgetCaps.on_limit_exceeded` is "skip".
   */
  async fetchPaid(
    url:  string,
    init: RequestInit = {},
    opts: Aifp1FetchOptions = {},
  ): Promise<Response | null> {
    const deps: Aifp1Deps = {
      fetchImpl: this.inner.fetchImpl,
      cache:     this._aifp1Cache,
      // A 0x address, because AIFP agent policies are address-keyed
      // (backend/aifp/agent-policy.js normalizeAddress) — a Solana pubkey here
      // would silently opt the agent out of its owner's own limits.
      agentId:   opts.agentId ?? this.evmAddress,
      settle: (p) => this.settleAifp1NativeV13(p),
      checkPerCall: (usd) => this.checkPerCall(usd),
      reserveDaily: (usd) => this.reserveDaily(usd),
      commit:  (id, usd) => this.ledger.commit(id, usd),
      release: (id)      => this.ledger.release(id),
      onPaid: ({ merchantId, amountUsd, txRef }) => {
        this.spend24h.add(amountUsd);
        if (this.telemetry) {
          this.reportTelemetry({
            kind: "aifp1", merchant: merchantId, chain: "polygon",
            cost: amountUsd, tx: txRef,
          });
        }
      },
    };
    return aifp1Fetch(deps, url, init, opts);
  }

  // ── Solana b2b_pay_with_split — build, sign, send via @solana/web3.js ───
  //
  // Manual instruction encoding (no Anchor dep):
  //   discriminator = sha256("global:b2b_pay_with_split")[:8]
  //   args (Borsh)   = u64 merchant_amount_lamports + string order_id
  //   accounts       = [config_pda, vault_pda, agent (signer), treasury,
  //                     ip_creator, merchant_wallet, system_program]
  // PDAs derived from program_id with seeds ["config"] and ["vault"].
  private async submitSolanaB2BPayWithSplit(ps: NonNullable<PayMaticChallenge["pay_solana"]>): Promise<string> {
    const conn = new Connection(this.solanaRpc, "confirmed");

    const programId = new PublicKey(ps.program_id);
    const merchant  = new PublicKey(ps.merchant_wallet);
    const treasury  = new PublicKey(ps.treasury);
    // ip_creator slot: not surfaced by current bridge 402s; route through
    // treasury so the on-chain 1bp still settles atomically (treasury earns
    // both 100bp + 1bp). When bridges add per-merchant ip_creator support,
    // accept it from `ps` and pass through.
    const ipCreator = treasury;

    // Solana keypair from legacy Agent inner (tweetnacl 64-byte secret).
    const kp = Keypair.fromSecretKey(this.inner.secretKey);
    if (kp.publicKey.toString() !== this.inner.address) {
      throw new AiFinPayError(
        `Internal: Solana keypair pubkey ${kp.publicKey.toString()} does not match agent address ${this.inner.address}`,
      );
    }

    // PDAs
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
    const [vaultPda]  = PublicKey.findProgramAddressSync([Buffer.from("vault")],  programId);

    // Instruction discriminator: Anchor convention sha256("global:<fn_name>")[:8].
    const disc = createHash("sha256").update("global:b2b_pay_with_split").digest().subarray(0, 8);

    // Borsh args: merchant_amount_lamports (u64 LE) + order_id (string = u32 len + utf8)
    const merchantAmount = BigInt(ps.merchant_amount_lamports);
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(merchantAmount);
    const orderBytes = Buffer.from(ps.order_id, "utf8");
    if (orderBytes.length > 64) {
      throw new AiFinPayError(`order_id too long (${orderBytes.length} bytes > 64 limit)`);
    }
    const orderLenBuf = Buffer.alloc(4);
    orderLenBuf.writeUInt32LE(orderBytes.length);
    const data = Buffer.concat([disc, amountBuf, orderLenBuf, orderBytes]);

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: configPda,             isSigner: false, isWritable: false },
        { pubkey: vaultPda,              isSigner: false, isWritable: false },
        { pubkey: kp.publicKey,          isSigner: true,  isWritable: true  },
        { pubkey: treasury,              isSigner: false, isWritable: true  },
        { pubkey: ipCreator,             isSigner: false, isWritable: true  },
        { pubkey: merchant,              isSigner: false, isWritable: true  },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
      ],
      data,
    });

    const tx = new Transaction().add(ix);
    // sendAndConfirmTransaction sets recentBlockhash + feePayer + signs.
    const sig = await sendAndConfirmTransaction(conn, tx, [kp], {
      commitment: "confirmed",
      preflightCommitment: "confirmed",
    });
    return sig;
  }

  // ── Sessions ────────────────────────────────────────────────────────────

  /**
   * TODO(phase-3): open a metered budget session.
   */
  async openSession(_args: {
    provider:    string;
    budget_usd:  number;
    ttl_seconds?: number;
  }): Promise<SessionHandle> {
    throw new AiFinPayError("openSession() not implemented yet — see migration phase 3");
  }

  // ── Balance ─────────────────────────────────────────────────────────────

  /**
   * Snapshot the agent's funds across both chains, USD-normalised.
   *
   * Phase 1.4: native MATIC + native SOL via RPC; ERC-20 / SPL token balances
   * deferred (we don't yet need them for the unified `call()` flow which
   * settles in MATIC). Pyth feeds are TODO; for now uses
   * `AIFINPAY_MATIC_USD` and `AIFINPAY_SOL_USD` env, defaulting to 0.7 and 200.
   */
  async balance(): Promise<BalanceSnapshot> {
    const maticUsd = parseFloat(process.env.AIFINPAY_MATIC_USD ?? "0.70");
    const solUsd   = parseFloat(process.env.AIFINPAY_SOL_USD   ?? "200");

    const polygon     = await this.fetchPolygonNative().catch(() => 0);
    const solana      = await this.fetchSolanaNative().catch(() => 0);
    const solana_usdc = await this.fetchSolanaUsdc().catch(() => 0);
    const polygon_usdc = await this.fetchPolygonUsdc().catch(() => 0);

    const polygonUsd     = polygon * maticUsd;
    const solanaUsd      = solana * solUsd;
    const solanaUsdcUsd  = solana_usdc;   // USDC ≈ $1
    const polygonUsdcUsd = polygon_usdc;  // USDC ≈ $1

    return {
      agent_balance_usd: polygonUsd + solanaUsd + solanaUsdcUsd + polygonUsdcUsd,
      chains: {
        solana:  { sol: solana,   usdc: solana_usdc,  msecco_balance: 0 },
        polygon: { matic: polygon, usdc: polygon_usdc, msecco_balance: 0 },
      },
      spend_24h_usd: this.spend24h.total24h(),
      budget_caps: this.budgetCaps,
      priced_at: Math.floor(Date.now() / 1000),
    };
  }

  private async fetchPolygonNative(): Promise<number> {
    const { publicClient } = this.polygonClients();
    const wei = await publicClient.getBalance({
      address: this.evmAccount.address,
    });
    return Number(wei) / 1e18;
  }

  private async fetchSolanaNative(): Promise<number> {
    // Raw JSON-RPC; honours the constructor's solanaRpc option (previously
    // re-read env here with a different default endpoint).
    const rpc = this.solanaRpc;
    const r = await this.inner.fetchImpl(rpc, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "getBalance",
        params: [this.solanaAddress],
      }),
    });
    if (!r.ok) return 0;
    const j = (await r.json()) as { result?: { value?: number } };
    const lamports = j.result?.value ?? 0;
    return lamports / 1e9;
  }

  /**
   * Sum SPL USDC balances across all token accounts owned by the agent's
   * Solana pubkey. Uses raw JSON-RPC `getTokenAccountsByOwner` so we don't
   * pull `@solana/spl-token` as a dep. Returns 0 (never throws) when the
   * RPC is unreachable or returns nothing — `balance()` must remain a
   * non-blocking introspection call.
   */
  private async fetchSolanaUsdc(): Promise<number> {
    const rpc = this.solanaRpc;
    try {
      const r = await this.inner.fetchImpl(rpc, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "getTokenAccountsByOwner",
          params: [
            this.solanaAddress,
            { mint: USDC_SOLANA_MINT },
            { encoding: "jsonParsed" },
          ],
        }),
      });
      if (!r.ok) return 0;
      const j = (await r.json()) as {
        result?: { value?: Array<{ account?: { data?: { parsed?: { info?: { tokenAmount?: { uiAmount?: number } } } } } }> };
      };
      // Sum all USDC token accounts (usually just one, but be safe)
      const accounts = j.result?.value ?? [];
      let total = 0;
      for (const acc of accounts) {
        const ui = acc.account?.data?.parsed?.info?.tokenAmount?.uiAmount;
        if (typeof ui === "number") total += ui;
      }
      return total;
    } catch {
      return 0; // never block balance() on Solana RPC issues
    }
  }

  // Cache: "chain:splitter address" → treasury address (constant per deployment).
  private splitterTreasuryCache = new Map<string, `0x${string}`>();

  /** Read + cache B2BSplitter.treasury() on the given chain (default
   *  polygon for back-compat). Returns null on RPC failure. */
  /**
   * Which Splitter generation is actually deployed at this address.
   *
   * The version used to come from a chain -> version table while the ADDRESS
   * came from the bridge's 402 challenge. Two different sources, and they can
   * disagree — in production they did. The Exa bridge still hands out the
   * pre-v1.2 splitter 0xE34Fc0E6… and sends no version, the table says
   * "polygon is 1.2", and the SDK called payNative on a contract that only has
   * payMatic. The payment reverted with nothing in the reason to explain it.
   *
   * A table keyed by chain cannot be right when the address is variable input,
   * so this asks the contract instead. payNative's 4-byte selector appears in a
   * v1.2 dispatcher and is absent from v1.1 — the same check used to verify all
   * six registry chains against mainnet.
   *
   * One eth_getCode, cached per (chain, address). Falls back to the registry
   * only when the code cannot be read: guessing beats refusing to pay, and for
   * the addresses we deployed the guess is right.
   */
  private splitterVersionCache = new Map<string, "1.1" | "1.2">();

  private async detectSplitterVersion(
    splitter: `0x${string}`,
    chainName: SplitterChainName,
    fallback: "1.1" | "1.2",
  ): Promise<"1.1" | "1.2"> {
    const key = `${chainName}:${splitter.toLowerCase()}`;
    const cached = this.splitterVersionCache.get(key);
    if (cached) return cached;
    try {
      const { publicClient } = this.splitterClients(chainName);
      const code = await publicClient.getBytecode({ address: splitter });
      if (!code || code === "0x") return fallback;
      const sel = toFunctionSelector(
        "function payNative(bytes32,address,address,string)",
      ).slice(2);
      const version: "1.1" | "1.2" = code.includes(sel) ? "1.2" : "1.1";
      this.splitterVersionCache.set(key, version);
      return version;
    } catch {
      return fallback;
    }
  }

  private async splitterTreasury(
    splitter: `0x${string}`,
    chainName: SplitterChainName = "polygon",
  ): Promise<`0x${string}` | null> {
    const cacheKey = `${chainName}:${splitter.toLowerCase()}`;
    const cached = this.splitterTreasuryCache.get(cacheKey);
    if (cached) return cached;
    try {
      const { publicClient } = this.splitterClients(chainName);
      const treasury = await publicClient.readContract({
        address:      splitter,
        abi:          SPLITTER_TREASURY_ABI,
        functionName: "treasury",
      }) as `0x${string}`;
      if (!treasury || treasury === "0x0000000000000000000000000000000000000000") return null;
      this.splitterTreasuryCache.set(cacheKey, treasury);
      return treasury;
    } catch {
      return null;
    }
  }

  /**
   * Read the native Polygon USDC (Circle-issued, 6 decimals) balance for the
   * agent's EVM address via the existing viem publicClient. Returns 0
   * (never throws) on RPC failure — see fetchSolanaUsdc rationale.
   */
  private async fetchPolygonUsdc(): Promise<number> {
    try {
      const { publicClient } = this.polygonClients();
      const raw = await publicClient.readContract({
        address:      USDC_POLYGON_ERC20,
        abi:          ERC20_BALANCE_OF_ABI,
        functionName: "balanceOf",
        args:         [this.evmAccount.address],
      });
      // USDC has 6 decimals on Polygon
      return Number(raw) / 1e6;
    } catch {
      return 0;
    }
  }

  // ── Reputation ──────────────────────────────────────────────────────────

  /**
   * TODO(phase-4 / phase-5): query operator backend reputation engine.
   */
  async reputation(): Promise<ReputationSnapshot> {
    return {
      trust_score: 0,
      spend_score: 0,
      tenure_days: 0,
      verified:    false,
      flags:       [],
    };
  }

  // ── Telemetry (opt-out) ─────────────────────────────────────────────────

  private reportTelemetry(payload: Record<string, unknown>): void {
    // Fire-and-forget. No body content, only metadata.
    void this.inner.fetchImpl(`${this.inner.baseUrl}/api/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ agent_id: this.id, ...payload, ts: Date.now() }),
    }).catch(() => {});
  }
}

// ── Internal hex helpers (small, no extra deps) ────────────────────────────

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(hex.substr(i * 2, 2), 16);
  }
  return out;
}

function bytesToHex(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i++) s += b[i]!.toString(16).padStart(2, "0");
  return s;
}

/**
 * Derive a 32-byte EVM private key from a 32-byte seed using a domain-separated
 * SHA-256 hash. Independent of the Solana keypair; same seed reproduces the
 * same EVM key.
 *
 * Domain separator: "aifinpay:evm:v1\0"  prevents accidental key collision with
 * any other system that hashes this seed.
 *
 * TODO(phase-1): swap to a real BIP-44 path (`m/44'/60'/0'/0/0`) once we ship
 * BIP-39 mnemonic support. This helper is stop-gap so the unified API can ship
 * before audit-grade derivation lands.
 */

/**
 * Casper identity for the agent, derived from the same seed as everything else.
 *
 * The SDK produced EVM and Solana addresses and nothing for Casper, while the
 * project publicly counts Casper among its live networks — a contract is
 * deployed there and has settled real payments. Anyone integrating had no way
 * to get an address, and deriving one by hand is the dangerous path: Casper
 * tags the key type and hashes with blake2b, so a plausible-looking guess
 * produces a valid-looking address for a keypair that controls nothing.
 *
 * Derivation is verified against Casper mainnet, not against documentation.
 * Public key 01000e6fce75…eeee resolves on chain to account hash
 * e386a6e2d67ab4c7…807a, and this code reproduces that exactly.
 *
 * Domain-separated like the EVM path rather than reusing the Solana key: the
 * two chains stay independent, so a compromise on one does not carry.
 */
function casperSeed(seed: Uint8Array): Uint8Array {
  const h = createHash("sha256");
  h.update("aifinpay:casper:v1\0");
  h.update(seed);
  return new Uint8Array(h.digest());
}

/** Casper account hash: blake2b256(algorithm-name || 0x00 || public key). */
function casperAccountHash(publicKey: Uint8Array): string {
  const name = new TextEncoder().encode("ed25519");
  const buf = new Uint8Array(name.length + 1 + publicKey.length);
  buf.set(name, 0);
  buf[name.length] = 0;
  buf.set(publicKey, name.length + 1);
  return bytesToHex(blake2b(buf, { dkLen: 32 }));
}

/** The pair Casper tooling expects: tagged public key and account hash. */
export function casperIdentityFromSeed(seed: Uint8Array): {
  publicKey: string;
  accountHash: string;
} {
  const kp = nacl.sign.keyPair.fromSeed(casperSeed(seed));
  return {
    // 01 tags ed25519; 02 would be secp256k1. Casper rejects an untagged key.
    publicKey: "01" + bytesToHex(kp.publicKey),
    accountHash: "account-hash-" + casperAccountHash(kp.publicKey),
  };
}

function crypto32(seed: Uint8Array): Uint8Array {
  // Must stay sync (constructors call it). Uses the createHash imported at
  // the top of this file — a bare `require()` is a ReferenceError here
  // because this package ships as ESM ("type": "module").
  const h = createHash("sha256");
  h.update("aifinpay:evm:v1\0");
  h.update(seed);
  return new Uint8Array(h.digest());
}
