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
  formatEther,
} from "viem";
import {
  privateKeyToAccount,
  type PrivateKeyAccount,
} from "viem/accounts";
import { defineChain } from "viem";
import { polygon, base, arbitrum, optimism, bsc, mainnet, unichain, type Chain } from "viem/chains";
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
  UntrustedPaymentTargetError,
  X402Error,
} from "./errors.js";
import generatedTable from "./generated/splitter-table.json" with { type: "json" };
import { Agent, type AgentOptions } from "./agent.js";
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
import {
  validateQuotedNativePayment,
  validateRuntimePaymentTarget,
  type QuotedNativePayment,
  type TrustedPaymentTarget,
} from "./paymentRegistry.js";
import {
  SOLANA_PROGRAM_ID,
  validateSolanaPaymentQuote,
} from "./solanaPayment.js";

// ── Types ──────────────────────────────────────────────────────────────────

/**
 * Chains the unified agent can settle on. "solana" uses the Anchor
 * quarantined v0.6 b2b_pay_with_split candidate; every other value is an EVM chain with a
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
  solanaRpc?:    string;     // default: env AIFINPAY_SOLANA_RPC or mainnet-beta
  /** RPC overrides for non-Polygon EVM chains — both bridge-flow chains
   *  and splitter-settlement chains (base, optimism, unichain, botchain,
   *  xrplevm). Splitter chains fall back to the public RPC listed in
   *  SPLITTER_DEPLOYMENTS when no override is given. */
  evmRpcUrls?:   Partial<Record<AnyEvmChainName, string>>;
}

// ── 402 challenge body shape returned by AiFinPay paid-proxy bridges ─────

interface PayMaticChallenge {
  error:    string;
  protocol: string;
  service:  string;
  facilitator?: string;
  pay_matic?: {
    /** EVM chain the quote is denominated for. Legacy bridges emit
     *  "polygon"; newer bridges may emit any SplitterChainName. */
    chain:                 string;
    splitter:              string;
    /** Which B2BSplitter the address above is. Absent on older bridges, which
     *  is treated as "1.1" — the shape the entrypoint had before 2026-07-31. */
    splitter_version?:     "1.1" | "1.2" | "1.3";
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
  };
  pay_solana?: {
    chain:                       "solana";
    program_id:                  string;
    instruction:                 string;     // required "b2b_pay_with_split" (v0.6 candidate)
    agent_pubkey:                string;
    merchant_wallet:             string;     // base58
    treasury:                    string;     // base58
    ip_creator:                  string;     // treasury when creator fee is disabled
    merchant_amount_lamports:    string;
    treasury_fee_lamports:       string;
    ip_creator_fee_lamports:     string;
    total_lamports:              string;
    payment_id:                  string;     // 0x-prefixed 32-byte SHA-256
    payment_receipt:             string;     // replay-protection PDA
    creator_fee_enabled:         boolean;
    order_id:                    string;
    asset?:                      string;
    ttl_seconds?:                number;
  };
  retry?: unknown;
  instructions?: string[];
}

// v1.3 fee-on-top entrypoint. v1.1/v1.2 remain recognized only so
// the validator can reject them explicitly; they may not reach signing.
export const SPLITTER_PAY_NATIVE_ABI = [
  {
    type: "function",
    name: "payNative",
    stateMutability: "payable",
    inputs: [
      { type: "bytes32", name: "paymentId" },
      { type: "address", name: "merchant" },
      { type: "uint256", name: "merchantAmount" },
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
// BOT Chain (677) and XRPL EVM (1440000) are not shipped with viem/chains,
// so we defineChain() them locally.

const botchain: Chain = defineChain({
  id:   677,
  name: "BOT Chain",
  nativeCurrency: { name: "BOT", symbol: "BOT", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.botchain.ai"] } },
  blockExplorers: {
    default: { name: "BOT Chain Explorer", url: "https://scan.botchain.ai" },
  },
});

const xrplevm: Chain = defineChain({
  id:   1440000,
  name: "XRPL EVM",
  nativeCurrency: { name: "XRP", symbol: "XRP", decimals: 18 },
  rpcUrls: { default: { http: ["https://rpc.xrplevm.org"] } },
  blockExplorers: {
    default: { name: "XRPL EVM Explorer", url: "https://explorer.xrplevm.org" },
  },
});

/** EVM chains with a live, on-chain-verified B2BSplitter deployment. */
export type SplitterChainName =
  | "polygon"
  | "base"
  | "optimism"
  | "unichain"
  | "botchain"
  | "xrplevm";

export interface SplitterDeployment extends TrustedPaymentTarget {
  /** viem chain object used for tx signing on this chain. */
  chain:      Chain;
  /** Public RPC used when no evmRpcUrls override is supplied. */
  defaultRpc: string;
  /**
   * Deployed B2BSplitter version. v1.2 added a bytes32 paymentId replay guard
   * and renamed the native entrypoint, so the ABI differs per chain — Base and
   * Unichain were not part of the 2026-07-31 rollout and still run v1.1.
   */
  /** B2BSplitter contract address (native-token entrypoint). */
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

/**
 * Chain facts the registry cannot verify.
 *
 * Everything that decides where money goes — address, contract version, runtime
 * code hash, treasury, fee split, validity window, whether settlement is on —
 * comes from the generated registry below, which is produced in
 * AiFinPay/evm-contract and verified there against chain state.
 *
 * What stays here is what a chain cannot tell you: the viem chain object, a
 * default public RPC, the explorer, the local USDC address (informational; the
 * SDK has no ERC-20 settlement path), and which env var carries the native
 * price. Getting any of these wrong degrades the experience. Getting a value
 * from the registry wrong sends money to the wrong place, which is why the two
 * are kept apart.
 */
const CHAIN_METADATA: Record<SplitterChainName, {
  chain: Chain;
  defaultRpc: string;
  explorer: string;
  nativeUsdEnv: string;
  nativeUsdDefault: number;
  usdc?: `0x${string}`;
}> = {
  polygon: {
    chain: polygon,
    defaultRpc: "https://polygon.drpc.org",
    explorer: "https://polygonscan.com",
    nativeUsdEnv: "AIFINPAY_MATIC_USD", // legacy name kept for back-compat
    nativeUsdDefault: 0.073, // reference only; ~$0.073 on 2026-08-03
    usdc: "0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359",
  },
  base: {
    chain: base,
    defaultRpc: "https://mainnet.base.org",
    explorer: "https://basescan.org",
    nativeUsdEnv: "AIFINPAY_ETH_USD",
    nativeUsdDefault: 1870,
    usdc: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
  },
  optimism: {
    chain: optimism,
    defaultRpc: "https://mainnet.optimism.io",
    explorer: "https://optimistic.etherscan.io",
    nativeUsdEnv: "AIFINPAY_ETH_USD",
    nativeUsdDefault: 1870,
    usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85",
  },
  unichain: {
    chain: unichain,
    defaultRpc: "https://mainnet.unichain.org",
    explorer: "https://uniscan.xyz",
    nativeUsdEnv: "AIFINPAY_ETH_USD",
    nativeUsdDefault: 1870,
    usdc: "0x078D782b760474a361dDA0AF3839290b0EF57AD6",
  },
  botchain: {
    chain: botchain,
    defaultRpc: "https://rpc.botchain.ai",
    explorer: "https://scan.botchain.ai",
    nativeUsdEnv: "AIFINPAY_BOT_USD",
    nativeUsdDefault: 1, // no reliable public feed; set the env var
  },
  xrplevm: {
    chain: xrplevm,
    defaultRpc: "https://rpc.xrplevm.org",
    explorer: "https://explorer.xrplevm.org",
    nativeUsdEnv: "AIFINPAY_XRP_USD",
    nativeUsdDefault: 2,
  },
};

/**
 * The canonical registry, vendored from AiFinPay/evm-contract.
 *
 * DO NOT EDIT src/generated/splitter-table.json. It is generated from
 * registry/registry.json there, verified against chain state, and
 * `npm run registry:check` fails if this copy has drifted from it.
 */
interface GeneratedNetwork {
  chainId: number;
  version: "1.1" | "1.2" | "1.3";
  splitter: `0x${string}`;
  runtimeCodeHash: `0x${string}`;
  treasury: `0x${string}`;
  treasuryBps: number;
  ipCreatorBps: number;
  validFrom: string;
  validUntil: string;
  settlementEnabled: boolean;
  verifiedAt: string;
}

const GENERATED = generatedTable as unknown as {
  networks: Record<string, GeneratedNetwork>;
};

function buildDeployments(): Record<SplitterChainName, SplitterDeployment> {
  const out = {} as Record<SplitterChainName, SplitterDeployment>;
  for (const [name, meta] of Object.entries(CHAIN_METADATA) as [
    SplitterChainName,
    (typeof CHAIN_METADATA)[SplitterChainName],
  ][]) {
    const entry = GENERATED.networks[name];
    if (!entry) {
      // A network the SDK knows about but the registry does not is not a
      // network we can pay on. Better to fail loudly at import than to fall
      // back to a hardcoded address.
      throw new AiFinPayError(
        `No verified registry entry for "${name}". The SDK will not pay an address ` +
          "it cannot trace to the canonical registry.",
      );
    }
    if (entry.chainId !== meta.chain.id) {
      throw new AiFinPayError(
        `Registry chainId ${entry.chainId} for "${name}" does not match the viem chain ` +
          `(${meta.chain.id}). Refusing to build a payment target from mismatched chains.`,
      );
    }
    out[name] = {
      chainId: entry.chainId,
      version: entry.version,
      splitter: entry.splitter,
      runtimeCodeHash: entry.runtimeCodeHash,
      treasury: entry.treasury,
      treasuryBps: entry.treasuryBps,
      ipCreatorBps: entry.ipCreatorBps,
      validFrom: entry.validFrom,
      validUntil: entry.validUntil,
      enabled: entry.settlementEnabled,
      chain: meta.chain,
      defaultRpc: meta.defaultRpc,
      explorer: meta.explorer,
      nativeUsdEnv: meta.nativeUsdEnv,
      nativeUsdDefault: meta.nativeUsdDefault,
      ...(meta.usdc ? { usdc: meta.usdc } : {}),
    };
  }
  return out;
}

export const SPLITTER_DEPLOYMENTS: Record<SplitterChainName, SplitterDeployment> =
  buildDeployments();


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
  private  spend24h        = new SpendTracker();
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
    if (!Number.isFinite(estUsd) || estUsd <= 0) {
      throw new UntrustedPaymentTargetError(
        `[PAY_VALUE_UNTRUSTED] cannot establish a positive USD value for ${providerName}; ` +
          `autonomous payment is blocked until a trusted live price or explicit positive price is available`,
      );
    }
    const limits: number[] = [];
    if (Number.isFinite(declaredCost) && declaredCost > 0) {
      limits.push(Math.max(declaredCost * 2, declaredCost + 0.05));
    }
    const operatorCap = this.budgetCaps.per_call_usd;
    if (operatorCap !== undefined) {
      if (!Number.isFinite(operatorCap) || operatorCap <= 0) {
        throw new UntrustedPaymentTargetError(
          `[PAY_VALUE_UNTRUSTED] configured per-call cap must be positive and finite`,
        );
      }
      limits.push(operatorCap);
    }
    if (!limits.length) {
      throw new UntrustedPaymentTargetError(
        `[PAY_VALUE_UNTRUSTED] no positive declared cost or operator per-call ceiling for ${providerName}`,
      );
    }
    const limit = Math.min(...limits);
    if (estUsd <= limit) return true;
    const err = new BudgetCapExceededError(
      "per_call",
      `bridge ${providerName} challenge demands ≈$${estUsd.toFixed(4)} on-chain, ` +
        `above the allowed $${limit.toFixed(4)} (declared cost/per-call cap).`,
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
   * Solana per-call is gated on the reviewed `b2b_pay_with_split` v0.6 instruction —
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
   * Solana settlement: quarantined Anchor v0.6 b2b_pay_with_split instruction.
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

    const withinBudget = this.checkBudget(cost);
    if (!withinBudget) return null;

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

    // ── Solana branch (v0.6 candidate; validator remains fail-closed) ────
    if (chain === "solana") {
      if (!challenge.pay_solana) {
        throw new X402Error(
          `Bridge ${provider.name} returned 402 without a pay_solana block. ` +
            `Either pick chain: "polygon" or ask the operator to set ` +
            `BRIDGE_MERCHANT_SOLANA on the bridge service.`,
        );
      }
      const ps = challenge.pay_solana;
      const validatedSolana = validateSolanaPaymentQuote(
        ps,
        provider.merchant_wallet,
        this.inner.address,
      );
      // Guard: the bridge controls the challenge — verify the demanded
      // amount is in the same ballpark as the declared cost / caps before
      // signing anything. Stops a misquoting bridge from draining the agent.
      {
        const lamports = Number(validatedSolana.totalLamports);
        const solUsd   = parseFloat(process.env.AIFINPAY_SOL_USD ?? "");
        const estUsd   = (Number.isFinite(lamports) ? lamports / 1e9 : 0) * solUsd;
        const guarded  = this.guardChallengeAmount(estUsd, cost, provider.name);
        if (!guarded) return null;
      }
      const solTxSig = await this.submitSolanaB2BPay(ps, validatedSolana);
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
      this.spend24h.add(cost);
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
    if (!challenge.pay_matic) {
      throw new X402Error(
        `bridge ${provider.name} returned 402 but no pay_matic block — only legacy AiFinPay/Coinbase facilitators not yet wired into AiFinPayAgent.call()`,
      );
    }
    const pm = challenge.pay_matic;
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
        `bridge ${provider.name} quoted pay_matic for chain "${pm.chain}" but the call was routed to "${chain}" — refusing cross-denomination payment`,
      );
    }

    // The bridge is untrusted input. Resolve every signing-critical field
    // against the canonical target registry before deriving calldata.
    const validatedPayment = validateQuotedNativePayment(
      chain,
      pm,
      deployment,
      provider.merchant_wallet,
    );
    const { publicClient, walletClient } = this.splitterClients(chain);
    await validateRuntimePaymentTarget(publicClient, deployment);

    // Guard: same ballpark check as the Solana branch — never sign for an
    // amount wildly above the declared cost / per-call cap. Native-token
    // USD price per chain via SPLITTER_DEPLOYMENTS.nativeUsdEnv.
    {
      const wei = Number(validatedPayment.totalWei);
      const { usd: nativeUsd } = await this.nativeUsdFor(deployment);
      // NaN when no price is known — guardChallengeAmount fails closed.
      // See nativeUsdFor().
      const estUsd  = (Number.isFinite(wei) ? wei / 1e18 : 0) * nativeUsd;
      const guarded = this.guardChallengeAmount(estUsd, cost, provider.name);
      if (!guarded) return null;
    }

    // 2. Only a canonical v1.3 fee-on-top quote can reach signing.
    // v1.1/v1.2 and dynamic server-selected ABIs are intentionally unavailable.
    await this.assertCanAffordNative(publicClient, deployment, validatedPayment.totalWei);
    const txHash = await walletClient.writeContract({
      address:      validatedPayment.splitter,
      abi:          SPLITTER_PAY_NATIVE_ABI,
      functionName: "payNative",
      args: [
        paymentIdFor(validatedPayment.orderId),
        validatedPayment.merchant,
        validatedPayment.merchantAmountWei,
        validatedPayment.ipCreator,
        validatedPayment.orderId,
      ],
      value: validatedPayment.totalWei,
      chain: deployment.chain,
      account: this.evmAccount,
    });

    // 3. Wait for receipt (inclusion is enough on these fast-block chains).
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new AiFinPayError(`${deployment.chain.name} tx reverted: ${txHash}`);
    }

    // 4. Retry the bridge with payment proof.
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

    this.spend24h.add(cost);
    if (this.telemetry) this.reportTelemetry({ kind: "call", provider: provider.name, chain, cost, tx: txHash });
    // @internal — see Solana branch above for rationale on property-attach.
    (paidResp as unknown as { aifinpayTx?: string; aifinpayChain?: ChainId }).aifinpayTx = txHash;
    (paidResp as unknown as { aifinpayTx?: string; aifinpayChain?: ChainId }).aifinpayChain = chain;
    return paidResp;
  }

  // ── Solana b2b_pay_with_split — exact v0.6 candidate IDL ──────────────
  //
  // Manual instruction encoding (no Anchor dep):
  //   discriminator = sha256("global:b2b_pay_with_split")[:8]
  //   args (Borsh)   = u64 merchant amount + [u8;32] payment ID
  //                    + string order ID + bool creator flag
  //   accounts match idl/aifinpay_contract.json exactly.
  private async submitSolanaB2BPay(
    _ps: NonNullable<PayMaticChallenge["pay_solana"]>,
    payment: ReturnType<typeof validateSolanaPaymentQuote>,
  ): Promise<string> {
    const conn = new Connection(this.solanaRpc, "confirmed");

    const programId = new PublicKey(SOLANA_PROGRAM_ID);
    const merchant  = new PublicKey(payment.merchant_wallet);
    const creator   = new PublicKey(payment.ip_creator);
    const quotedTreasury = new PublicKey(payment.treasury);

    // Solana keypair from legacy Agent inner (tweetnacl 64-byte secret).
    const kp = Keypair.fromSecretKey(this.inner.secretKey);
    if (kp.publicKey.toString() !== this.inner.address) {
      throw new AiFinPayError(
        `Internal: Solana keypair pubkey ${kp.publicKey.toString()} does not match agent address ${this.inner.address}`,
      );
    }

    // PDAs required by the v0.6 B2bPayWithSplit account context.
    const [configPda] = PublicKey.findProgramAddressSync([Buffer.from("config")], programId);
    const [vaultPda]  = PublicKey.findProgramAddressSync([Buffer.from("vault")],  programId);
    const receiptPda = new PublicKey(payment.payment_receipt);

    let infos;
    try {
      infos = await conn.getMultipleAccountsInfo([
        programId, configPda, vaultPda,
      ], "confirmed");
    } catch {
      throw new UntrustedPaymentTargetError("[PAY_TARGET_UNTRUSTED] solana_rpc_unavailable");
    }
    const [programInfo, configInfo, vaultInfo] = infos;
    if (!programInfo?.executable) {
      throw new UntrustedPaymentTargetError("[PAY_TARGET_UNTRUSTED] solana_program_not_executable");
    }
    for (const [label, info] of [
      ["config", configInfo], ["vault", vaultInfo],
    ] as const) {
      if (!info || !info.owner.equals(programId)) {
        throw new UntrustedPaymentTargetError(`[PAY_TARGET_UNTRUSTED] solana_${label}_account_invalid`);
      }
    }
    if (vaultInfo!.data.length < 72) {
      throw new UntrustedPaymentTargetError("[PAY_TARGET_UNTRUSTED] solana_account_data_invalid");
    }
    // Anchor discriminator (8) + owner/admin Pubkey (32) precede these keys.
    const vaultTreasury = new PublicKey(vaultInfo!.data.subarray(40, 72));
    if (!vaultTreasury.equals(quotedTreasury)) {
      throw new UntrustedPaymentTargetError("[PAY_TARGET_UNTRUSTED] solana_treasury_mismatch");
    }

    // Instruction discriminator: Anchor convention sha256("global:<fn_name>")[:8].
    const disc = createHash("sha256").update("global:b2b_pay_with_split").digest().subarray(0, 8);

    // Borsh args: merchant amount + payment ID + order_id + creator flag.
    const amountBuf = Buffer.alloc(8);
    amountBuf.writeBigUInt64LE(payment.merchantAmountLamports);
    const orderBytes = Buffer.from(payment.order_id, "utf8");
    const orderLenBuf = Buffer.alloc(4);
    orderLenBuf.writeUInt32LE(orderBytes.length);
    const data = Buffer.concat([
      disc,
      amountBuf,
      payment.paymentId,
      orderLenBuf,
      orderBytes,
      Buffer.from([payment.creatorFeeEnabled ? 1 : 0]),
    ]);

    const ix = new TransactionInstruction({
      programId,
      keys: [
        { pubkey: configPda,             isSigner: false, isWritable: false },
        { pubkey: vaultPda,              isSigner: false, isWritable: false },
        { pubkey: kp.publicKey,          isSigner: true,  isWritable: true  },
        { pubkey: receiptPda,            isSigner: false, isWritable: true  },
        { pubkey: vaultTreasury,         isSigner: false, isWritable: true  },
        { pubkey: creator,               isSigner: false, isWritable: true  },
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

  // ── AIFP-1 merchant paywall (gateway.aifinpay.io) ───────────────────────
  //
  // The protocol lives in aifp1.ts; this is the wiring. Two things only the
  // agent can supply: the on-chain settlement, and the budget caps — aifp1Fetch
  // owns neither, exactly as call() owns them for the bridge flow.

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
   * Settle a native-token splitter payment, v1.3 fee-on-top only.
   *
   * Shared by call() and the AIFP-1 flow so both reach the chain through the
   * same gate. Everything signing-critical — splitter address, contract
   * version, merchant, and each fee component — is resolved against the
   * trusted registry by validateQuotedNativePayment and the deployed runtime
   * is checked by validateRuntimePaymentTarget before any calldata is built.
   *
   * There is deliberately no version detection and no v1.1/v1.2 branch. The
   * deployed fee-INCLUSIVE splitters pay the merchant less than the quoted
   * merchant amount, so settling against them under a fee-on-top quote
   * short-pays the merchant silently. A quote that does not describe a
   * registered v1.3 route is refused rather than downgraded.
   */
  private async settleSplitterNative(p: {
    chain:    SplitterChainName;
    quote:    QuotedNativePayment;
    merchant: string;
  }): Promise<`0x${string}`> {
    const deployment = SPLITTER_DEPLOYMENTS[p.chain];
    if (!deployment) {
      throw new AiFinPayError(
        `No B2BSplitter deployment registered for chain "${p.chain}" — supported: ${Object.keys(SPLITTER_DEPLOYMENTS).join(", ")}`,
      );
    }
    const validated = validateQuotedNativePayment(p.chain, p.quote, deployment, p.merchant);
    const { publicClient, walletClient } = this.splitterClients(p.chain);
    await validateRuntimePaymentTarget(publicClient, deployment);
    await this.assertCanAffordNative(publicClient, deployment, validated.totalWei);

    const txHash = await walletClient.writeContract({
      address:      validated.splitter,
      abi:          SPLITTER_PAY_NATIVE_ABI,
      functionName: "payNative",
      args: [
        paymentIdFor(validated.orderId),
        validated.merchant,
        validated.merchantAmountWei,
        validated.ipCreator,
        validated.orderId,
      ],
      value: validated.totalWei,
      chain: deployment.chain,
      account: this.evmAccount,
    });

    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new AiFinPayError(`${deployment.chain.name} tx reverted: ${txHash}`);
    }
    return txHash;
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
    opts: Aifp1FetchOptions & { splitter?: `0x${string}` } = {},
  ): Promise<Response | null> {
    const deps: Aifp1Deps = {
      fetchImpl: this.inner.fetchImpl,
      cache:     this._aifp1Cache,
      // A 0x address, because AIFP agent policies are address-keyed
      // (backend/aifp/agent-policy.js normalizeAddress) — a Solana pubkey here
      // would silently opt the agent out of its owner's own limits.
      agentId:   opts.agentId ?? this.evmAddress,
      settle: (p) => this.settleSplitterNative({
        // Polygon-only, and not by preference: /v1/pay verifies the settlement
        // by reading the Splitter's Payment event, and that verifier implements
        // Polygon alone (backend/aifp/verify-settlement.js — Solana returns
        // notImplemented, anything else unsupported_chain). Settling elsewhere
        // would move real money for a receipt that can never be issued.
        chain: "polygon",
        merchant: p.merchantWallet,
        // The gateway states the amounts; the registry states the route. The
        // splitter address and version are NOT taken from the gateway — it
        // does not send them — so they come from this SDK's verified registry,
        // and validateQuotedNativePayment still has to agree that every
        // component matches that registry's fee-on-top model. A gateway still
        // quoting the old fee-inclusive split fails there rather than here.
        quote: {
          chain:                 "polygon",
          splitter:              opts.splitter ?? SPLITTER_DEPLOYMENTS.polygon.splitter,
          splitter_version:      SPLITTER_DEPLOYMENTS.polygon.version,
          merchant_wallet:       p.merchantWallet,
          order_id:              p.orderId,
          total_wei:             p.totalWei.toString(),
          merchant_amount_wei:   p.merchantAmountWei?.toString(),
          treasury_amount_wei:   p.treasuryAmountWei?.toString(),
          ip_creator_amount_wei: p.ipCreatorAmountWei?.toString(),
        },
      }),
      // The remediation branch replaced the file-backed reservation ledger
      // with in-memory caps, so there is no reservation to resolve: checkBudget
      // covers both per-call and daily, and onPaid records the spend once the
      // money has actually moved.
      checkPerCall: (usd) => this.checkBudget(usd),
      reserveDaily: (usd) => Promise.resolve(this.checkBudget(usd) ? null : "skip"),
      commit:  () => Promise.resolve(),
      release: () => Promise.resolve(),
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
