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
import bs58 from "bs58";
import { createHash } from "node:crypto";
import {
  createPublicClient,
  createWalletClient,
  http,
  type PublicClient,
  type WalletClient,
} from "viem";
import {
  privateKeyToAccount,
  generatePrivateKey,
  type PrivateKeyAccount,
} from "viem/accounts";
import { polygon, base, arbitrum, optimism, bsc, mainnet, type Chain } from "viem/chains";
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

export type ChainId = "solana" | "polygon";

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
  registryUrl?:  string;     // default: ${baseUrl}/api/providers
  evmPrivateKey?: `0x${string}`; // optional override; otherwise derived/generated
  budgetCaps?:   BudgetCaps;
  telemetry?:    boolean;    // default true
  polygonRpc?:   string;     // default: https://polygon.drpc.org
  solanaRpc?:    string;     // default: env AIFINPAY_SOLANA_RPC or mainnet-beta
  /** RPC overrides for non-Polygon EVM chains used in bridge flows. */
  evmRpcUrls?:   Partial<Record<EvmChainName, string>>;
  /**
   * Throttle window (ms) for the auto-heartbeat fired opportunistically
   * after a successful call()/pay(). Default 5 minutes. See
   * `maybeHeartbeat()` for the throttle + balance-reuse rationale.
   */
  heartbeatIntervalMs?: number;
}

// ── 402 challenge body shape returned by AiFinPay paid-proxy bridges ─────

interface PayMaticChallenge {
  error:    string;
  protocol: string;
  service:  string;
  facilitator?: string;
  pay_matic?: {
    chain:                 "polygon";
    splitter:              string;
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

// ── B2BSplitter contract (deployed at 0xE34Fc0…8440 on Polygon mainnet) ──

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

// ── EVM chain object lookup — viem chains keyed by our EvmChainName ─────

const EVM_CHAIN_OBJECTS: Record<EvmChainName, Chain> = {
  ethereum: mainnet,
  polygon,
  bsc,
  arbitrum,
  optimism,
  base,
};

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
  constructor(public needed_usd: number, public available_usd: number, msg: string) {
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

const DEFAULT_REGISTRY_PATH = "/api/providers";

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
  readonly polygonRpc:   string;
  readonly solanaRpc:    string;
  private  cachedRegistry?: ProviderEntry[];
  private  budgetCaps:     BudgetCaps;
  private  spend24h        = new SpendTracker();
  private  telemetry:      boolean;
  // Auto-heartbeat throttle (see maybeHeartbeat()). lastHeartbeatTs=0 means
  // "never fired yet this process" so the first opportunistic heartbeat
  // always goes out.
  private  heartbeatIntervalMs: number;
  private  lastHeartbeatTs = 0;
  // Cheap reuse: the last balance() snapshot taken by ANY caller (explicit
  // agent.balance() or a prior heartbeat). maybeHeartbeat() reuses it if
  // fresh enough instead of forcing a new RPC round-trip.
  private  lastBalanceSnapshot?: { at: number; snapshot: BalanceSnapshot };
  private  _polygonPublic?: PublicClient;
  private  _polygonWallet?: WalletClient;
  // Multi-chain client cache for cross-chain orchestration (bridge flows).
  // Keyed by EVM chain name (see crossChain.ts EVM_CHAINS).
  private  _evmClients: Map<EvmChainName, { publicClient: PublicClient; walletClient: WalletClient }> = new Map();
  private  evmRpcUrls: Partial<Record<EvmChainName, string>> = {};
  // Cookie for the operator's user-session (magic-link login), captured by
  // establishUserSession(). Same mechanism the MCP agent_claim_self tool
  // uses inline; here it's held on the instance so subsequent calls
  // (listMyAgents()) can reuse it without re-clicking the magic link.
  private  userSessionCookie?: string;

  private constructor(
    inner:      Agent,
    evmAccount: PrivateKeyAccount,
    opts:       AiFinPayAgentOptions = {},
  ) {
    this.inner       = inner;
    this.evmAccount  = evmAccount;
    this.registryUrl = opts.registryUrl
      ?? `${inner.baseUrl}${DEFAULT_REGISTRY_PATH}`;
    this.budgetCaps  = opts.budgetCaps ?? {};
    this.telemetry   = opts.telemetry !== false;
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? 5 * 60 * 1000;
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

  // Multi-EVM-chain client cache. Used by bridge orchestration to sign source
  // and (optionally) dest transactions on chains other than Polygon. Picks
  // viem's built-in chain definitions; an optional RPC override per chain
  // can be supplied via opts.evmRpcUrls.
  private evmClients(name: EvmChainName): { publicClient: PublicClient; walletClient: WalletClient } {
    const cached = this._evmClients.get(name);
    if (cached) return cached;

    const chain = EVM_CHAIN_OBJECTS[name];
    if (!chain) {
      throw new AiFinPayError(`evmClients: unsupported EVM chain "${name}"`);
    }
    const rpcUrl  = this.evmRpcUrls[name];
    const transport = rpcUrl ? http(rpcUrl) : http();

    const publicClient = createPublicClient({ chain, transport });
    const walletClient = createWalletClient({ chain, transport, account: this.evmAccount });
    const pair = { publicClient, walletClient };
    this._evmClients.set(name, pair);
    return pair;
  }

  // ── Constructors ─────────────────────────────────────────────────────────

  /**
   * Generate a fresh agent — new Solana keypair + new EVM keypair.
   * Use `fromSeed()` to derive both from a single backup phrase instead.
   */
  static async new(opts: AiFinPayAgentOptions = {}): Promise<AiFinPayAgent> {
    const inner = Agent.new(opts);
    const evmKey = opts.evmPrivateKey ?? generatePrivateKey();
    const evmAccount = privateKeyToAccount(evmKey);
    return new AiFinPayAgent(inner, evmAccount, opts);
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

  // ── Registry ────────────────────────────────────────────────────────────

  async fetchRegistry(force = false): Promise<ProviderEntry[]> {
    if (this.cachedRegistry && !force) return this.cachedRegistry;
    const r = await fetch(this.registryUrl);
    if (!r.ok) {
      throw new AiFinPayError(`provider registry ${this.registryUrl} → ${r.status}`);
    }
    const j = (await r.json()) as { providers?: ProviderEntry[] };
    this.cachedRegistry = j.providers ?? [];
    return this.cachedRegistry;
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
   * Phase 1 implementation: Polygon per-call splitter via on-chain
   * `B2BSplitter.payMatic()`. Solana per-call branch lights up after
   * Phase 2 (b2b_pay_with_split deploy via Squads).
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
      this.maybeHeartbeat();
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
      this.spend24h.add(cost);
      if (this.telemetry) this.reportTelemetry({ kind: "call", provider: provider.name, chain, cost, tx: solTxSig });
      this.maybeHeartbeat();
      // @internal — attach settlement metadata for consumers (MCP, telemetry
      // dashboards) that need to surface the tx hash without an extra RPC
      // call. Response headers are read-only after construction so we use
      // an instance property + cast on the read side.
      (paidResp as unknown as { aifinpayTx?: string; aifinpayChain?: ChainId }).aifinpayTx = solTxSig;
      (paidResp as unknown as { aifinpayTx?: string; aifinpayChain?: ChainId }).aifinpayChain = "solana";
      return paidResp;
    }

    // ── Polygon branch (B2BSplitter.payMatic atomic split, legacy default) ──
    if (!challenge.pay_matic) {
      throw new X402Error(
        `bridge ${provider.name} returned 402 but no pay_matic block — only legacy AiFinPay/Coinbase facilitators not yet wired into AiFinPayAgent.call()`,
      );
    }
    const pm = challenge.pay_matic;

    // Guard: same ballpark check as the Solana branch — never sign for an
    // amount wildly above the declared cost / per-call cap.
    {
      const wei      = Number(pm.total_wei);
      const maticUsd = parseFloat(process.env.AIFINPAY_MATIC_USD ?? "0.70");
      const estUsd   = (Number.isFinite(wei) ? wei / 1e18 : 0) * maticUsd;
      const guarded  = this.guardChallengeAmount(estUsd, cost, provider.name);
      if (!guarded) return null;
    }

    // 2. Submit B2BSplitter.payMatic on Polygon mainnet.
    // ipCreator routing: prefer the challenge's explicit ip_creator; else
    // route the royalty slot to the splitter's treasury (mirrors the Solana
    // branch). Passing address(0) would skip the transfer and permanently
    // strand the 1bp inside B2BSplitter — the contract has no sweep function.
    const ipCreator = (pm.ip_creator as `0x${string}` | undefined)
      ?? await this.splitterTreasury(pm.splitter as `0x${string}`)
      ?? "0x0000000000000000000000000000000000000000";
    const { publicClient, walletClient } = this.polygonClients();
    const txHash = await walletClient.writeContract({
      address:      pm.splitter as `0x${string}`,
      abi:          SPLITTER_PAY_MATIC_ABI,
      functionName: "payMatic",
      args: [
        pm.merchant_wallet as `0x${string}`,
        ipCreator,
        pm.order_id,
      ],
      value: BigInt(pm.total_wei),
      chain: polygon,
      account: this.evmAccount,
    });

    // 3. Wait for receipt (we only need inclusion for Polygon's 2s blocks).
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    if (receipt.status !== "success") {
      throw new AiFinPayError(`Polygon tx reverted: ${txHash}`);
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
    this.maybeHeartbeat();
    // @internal — see Solana branch above for rationale on property-attach.
    (paidResp as unknown as { aifinpayTx?: string; aifinpayChain?: ChainId }).aifinpayTx = txHash;
    (paidResp as unknown as { aifinpayTx?: string; aifinpayChain?: ChainId }).aifinpayChain = "polygon";
    return paidResp;
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

    const snapshot: BalanceSnapshot = {
      agent_balance_usd: polygonUsd + solanaUsd + solanaUsdcUsd + polygonUsdcUsd,
      chains: {
        solana:  { sol: solana,   usdc: solana_usdc,  msecco_balance: 0 },
        polygon: { matic: polygon, usdc: polygon_usdc, msecco_balance: 0 },
      },
      spend_24h_usd: this.spend24h.total24h(),
      budget_caps: this.budgetCaps,
      priced_at: Math.floor(Date.now() / 1000),
    };
    // Cache for maybeHeartbeat() reuse — see rationale there.
    this.lastBalanceSnapshot = { at: Date.now(), snapshot };
    return snapshot;
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

  // Cache: splitter address → treasury address (constant per deployment).
  private splitterTreasuryCache = new Map<string, `0x${string}`>();

  /** Read + cache B2BSplitter.treasury(). Returns null on RPC failure. */
  private async splitterTreasury(splitter: `0x${string}`): Promise<`0x${string}` | null> {
    const cached = this.splitterTreasuryCache.get(splitter.toLowerCase());
    if (cached) return cached;
    try {
      const { publicClient } = this.polygonClients();
      const treasury = await publicClient.readContract({
        address:      splitter,
        abi:          SPLITTER_TREASURY_ABI,
        functionName: "treasury",
      }) as `0x${string}`;
      if (!treasury || treasury === "0x0000000000000000000000000000000000000000") return null;
      this.splitterTreasuryCache.set(splitter.toLowerCase(), treasury);
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

  // ── Owner user-session (magic-link) ───────────────────────────────────

  /**
   * Establish the operator's user-session by hitting a magic-link URL —
   * same mechanism `agent_claim_self` (MCP) uses inline: the link is a
   * one-shot, ~15-min-TTL sign-in URL like
   * `https://aifinpay.io/api/auth/verify?token=…` that the user pastes in
   * after signing in at https://aifinpay.io/login. The resulting session
   * cookie (`__aifinpay_user_session`) is cached on this instance and
   * reused by `listMyAgents()` — call this once per process, not per call.
   */
  async establishUserSession(magicLinkUrl: string): Promise<void> {
    const res = await fetch(magicLinkUrl, { redirect: "manual" });
    const setCookie = res.headers.get("set-cookie");
    if (!setCookie) {
      throw new AiFinPayError(
        `Magic link did not return a session cookie (HTTP ${res.status}). Link may be expired or already used.`,
      );
    }
    // Some setups split multiple cookies; keep the header verbatim minus
    // attributes (Path=/, HttpOnly, …) — same trim as agent-claim-self.ts.
    this.userSessionCookie = setCookie
      .split(",")
      .map((c) => c.trim().split(";")[0])
      .join("; ");
  }

  /**
   * Adopt an already-computed session cookie header (e.g. one the MCP
   * `agent_claim_self` tool derived from the same magic link while doing
   * its own claim flow) without re-fetching the magic link. Lets
   * `listMyAgents()` reuse a session established by a sibling flow.
   */
  adoptUserSessionCookie(cookieHeader: string): void {
    this.userSessionCookie = cookieHeader;
  }

  /**
   * List agents owned by the signed-in operator, with balance/spend/health
   * fields for each, over a rolling window. Requires `establishUserSession()`
   * (or the MCP `agent_claim_self` flow, which also captures the cookie on
   * this same agent instance) to have run first — otherwise throws.
   *
   * Calls `GET {baseUrl}/api/me/agents/overview` — owner-gated, same
   * `__aifinpay_user_session` cookie as `/api/me/agents/challenge` and
   * `/api/me/agents/claim`. Returns the parsed `agents` array from
   * `{ window, agents: [...] }`.
   */
  async listMyAgents(): Promise<Array<Record<string, unknown>>> {
    if (!this.userSessionCookie) {
      throw new AiFinPayError(
        "No user session established. Run the claim flow first — " +
          "sign in at https://aifinpay.io/login, then call " +
          "establishUserSession(magicLinkUrl) (Node) with the emailed link, " +
          "or use the MCP agent_claim_self tool, before calling listMyAgents().",
      );
    }
    const r = await this.inner.fetchImpl(`${this.inner.baseUrl}/api/me/agents/overview`, {
      method: "GET",
      headers: { accept: "application/json", cookie: this.userSessionCookie },
    });
    if (r.status === 401) {
      throw new AiFinPayError(
        "User session expired or invalid — re-run establishUserSession() with a fresh magic link.",
      );
    }
    if (!r.ok) {
      throw new AiFinPayError(`GET /api/me/agents/overview → ${r.status}`);
    }
    const j = (await r.json()) as { window?: unknown; agents?: Array<Record<string, unknown>> };
    return j.agents ?? [];
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

  /**
   * Opt-in "advisory" heartbeat — reports the agent's own view of its
   * budget caps, 24h spend, and balances so an operator dashboard can show
   * "reported by your agent" liveness. This is NOT server-enforced: the
   * backend does not verify these numbers on-chain, it just displays what
   * the agent self-reports. Respects the same `telemetry: false` opt-out
   * as `call()`'s per-request reporting. Fire-and-forget — never throws.
   */
  reportHeartbeat(): void {
    if (!this.telemetry) return;
    void this.balance()
      .then((bal) => {
        this.reportTelemetry({
          kind: "heartbeat",
          budget_caps: this.budgetCaps,
          spend_24h_usd: bal.spend_24h_usd,
          balances: bal.chains,
        });
        this.lastHeartbeatTs = Date.now();
      })
      .catch(() => {});
  }

  /**
   * Opportunistic, throttled heartbeat — called internally after a
   * SUCCESSFUL call()/pay() so the dashboard's "agent-reported caps"
   * section stays warm without every caller having to remember to invoke
   * reportHeartbeat() by hand.
   *
   * Throttle: at most once per `heartbeatIntervalMs` (default 5 min),
   * tracked via `lastHeartbeatTs` — never fires more often than that
   * regardless of call volume.
   *
   * Cost control: does NOT force a fresh balance() RPC round-trip on every
   * heartbeat. It reuses `lastBalanceSnapshot` if one exists and is no
   * older than `heartbeatIntervalMs`; otherwise it sends budget_caps +
   * spend_24h only (balances omitted) rather than paying for a live RPC
   * call on this opportunistic path. Call `balance()` or `reportHeartbeat()`
   * explicitly if you want a heartbeat with a guaranteed-fresh balance.
   *
   * Always fire-and-forget: never awaited by call()/pay(), never throws.
   */
  private maybeHeartbeat(): void {
    if (!this.telemetry) return;
    const now = Date.now();
    if (now - this.lastHeartbeatTs < this.heartbeatIntervalMs) return;
    this.lastHeartbeatTs = now; // claim the slot before the async work starts

    const fresh = this.lastBalanceSnapshot
      && (now - this.lastBalanceSnapshot.at) < this.heartbeatIntervalMs
      ? this.lastBalanceSnapshot.snapshot
      : undefined;

    const payload: Record<string, unknown> = {
      kind: "heartbeat",
      budget_caps: this.budgetCaps,
      spend_24h_usd: this.spend24h.total24h(),
    };
    if (fresh) payload.balances = fresh.chains;
    this.reportTelemetry(payload);
  }

  /**
   * Generic x402 payment with telemetry — thin wrapper over
   * `inner.pay(url)` that reports a `kind:"call", via:"pay"` telemetry
   * event on success, mirroring the reporting `call()` already does for
   * registry-resolved payments. Unlike `call()`, the generic x402 flow
   * (native AiFinPay + Coinbase facilitators) does not settle through a
   * bridge that returns a verifiable tx hash here, so `cost` reflects the
   * caller's declared `options.maxAmountUsd` cap (if any) rather than a
   * confirmed on-chain amount — same "advisory" caveat as heartbeat.
   */
  async pay(url: string, init: Parameters<Agent["pay"]>[1] = {}): Promise<Response> {
    const resp = await this.inner.pay(url, init);
    if (this.telemetry) {
      let host: string | null = null;
      try { host = new URL(url).host; } catch { /* leave null */ }
      this.reportTelemetry({
        kind: "call",
        via: "pay",
        provider: host,
        cost: init.options?.maxAmountUsd ?? null,
      });
    }
    this.maybeHeartbeat();
    return resp;
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
function crypto32(seed: Uint8Array): Uint8Array {
  // Must stay sync (constructors call it). Uses the createHash imported at
  // the top of this file — a bare `require()` is a ReferenceError here
  // because this package ships as ESM ("type": "module").
  const h = createHash("sha256");
  h.update("aifinpay:evm:v1\0");
  h.update(seed);
  return new Uint8Array(h.digest());
}
