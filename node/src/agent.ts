import nacl from "tweetnacl";
import bs58 from "bs58";
import { sha256 } from "./crypto.js";
import { AiFinPayError, FundingTimeoutError, X402Error } from "./errors.js";
import { detectFacilitator } from "./facilitators/detect.js";
import type { PayOptions } from "./facilitators/base.js";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";

// Canonical domain is aifinpay.io. The legacy aifinpay.company host is
// fully retired (DNS removed) — do not use it.
const DEFAULT_BASE_URL = "https://aifinpay.io";
const DEFAULT_TIMEOUT_MS = 30_000;
const SDK_UA = "aifinpay-agent-node/0.3.0";

export interface Invoice {
  amountUsd: number;
  treasuryVault: string;
  programId: string;
  nonce: string;
  raw: Record<string, unknown>;
}

export interface AgentOptions {
  baseUrl?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export interface PayInit extends Omit<RequestInit, "method"> {
  method?: string;
  options?: PayOptions;
  maxRetries?: number;
}

export class Agent {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array; // 64 bytes (secret + public)
  readonly baseUrl: string;
  readonly timeoutMs: number;
  /** Internal — facilitators reach for this when they need to refetch from the backend. */
  readonly fetchImpl: typeof fetch;

  private constructor(
    secretKey: Uint8Array,
    publicKey: Uint8Array,
    opts: AgentOptions = {},
  ) {
    this.secretKey = secretKey;
    this.publicKey = publicKey;
    this.baseUrl = (opts.baseUrl || DEFAULT_BASE_URL).replace(/\/$/, "");
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    if (!this.fetchImpl) {
      throw new AiFinPayError(
        "global fetch not available. Pass opts.fetchImpl or upgrade to Node 18+.",
      );
    }
  }

  // ── Constructors ───────────────────────────────────────────────────────

  static new(opts: AgentOptions = {}): Agent {
    const kp = nacl.sign.keyPair();
    return new Agent(kp.secretKey, kp.publicKey, opts);
  }

  /** Load from base58 secret (Solana style: 64 bytes = secret + public). */
  static fromSecretB58(secretB58: string, opts: AgentOptions = {}): Agent {
    const raw = bs58.decode(secretB58);
    let kp;
    if (raw.length === 64) {
      kp = nacl.sign.keyPair.fromSecretKey(raw);
    } else if (raw.length === 32) {
      kp = nacl.sign.keyPair.fromSeed(raw);
    } else {
      throw new AiFinPayError(
        `secret must decode to 32 or 64 bytes, got ${raw.length}`,
      );
    }
    return new Agent(kp.secretKey, kp.publicKey, opts);
  }

  /** Load from a Solana CLI ``solana-keygen`` JSON file path (Node only). */
  static async fromKeypairFile(
    path: string,
    opts: AgentOptions = {},
  ): Promise<Agent> {
    const fs = await import("node:fs/promises");
    const raw = await fs.readFile(path, "utf8");
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr) || arr.length !== 64) {
      throw new AiFinPayError(`${path}: expected 64-byte JSON array`);
    }
    const sk = Uint8Array.from(arr);
    const kp = nacl.sign.keyPair.fromSecretKey(sk);
    return new Agent(kp.secretKey, kp.publicKey, opts);
  }

  // ── Public properties ──────────────────────────────────────────────────

  /** Solana base58 public key. */
  get address(): string {
    return bs58.encode(this.publicKey);
  }

  /** 64-byte base58 secret. Save this safely — server never sees it. */
  get secretB58(): string {
    return bs58.encode(this.secretKey);
  }

  private _evm?: PrivateKeyAccount;
  /**
   * The agent's EVM account (viem), derived from the same 32-byte seed as the
   * Solana key via domain-separated SHA-256 ("aifinpay:evm:v1\0" || seed) —
   * byte-for-byte identical to AiFinPayAgent's EVM address. Used by the
   * standard x402 (EIP-3009) facilitator. Node-only (sync SHA-256).
   */
  async evmAccount(): Promise<PrivateKeyAccount> {
    if (this._evm) return this._evm;
    const { createHash } = await import("node:crypto");
    const h = createHash("sha256");
    h.update("aifinpay:evm:v1\0");
    h.update(this.secretKey.subarray(0, 32));
    this._evm = privateKeyToAccount(`0x${h.digest("hex")}` as `0x${string}`);
    return this._evm;
  }

  /** The agent's EVM (Polygon / Base / …) address. */
  async evmAddress(): Promise<string> {
    return (await this.evmAccount()).address;
  }

  // ── Discovery ──────────────────────────────────────────────────────────

  async manifesto(): Promise<Record<string, unknown>> {
    return (await this.json("GET", "/manifesto.json")) as Record<
      string,
      unknown
    >;
  }

  async wellKnown(): Promise<Record<string, unknown>> {
    return (await this.json("GET", "/.well-known/x402.json")) as Record<
      string,
      unknown
    >;
  }

  // ── x402 auth ────────────────────────────────────────────────────────

  /**
   * @deprecated Generic nonces are intentionally not signable. Use `fetch()` /
   * `request()` so the facilitator can sign the server's request-bound v2
   * challenge (method + resource + expiry + value terms).
   */
  async fetchNonce(): Promise<never> {
    throw new Error(
      "Legacy /nonce flow retired: use the request-bound aifinpay-ed25519-v2 facilitator",
    );
  }

  /** @deprecated Unbound generic nonce signatures are retired. */
  async authHeaders(): Promise<never> {
    throw new Error(
      "Legacy authHeaders() retired: use fetch()/request() with a bound 402 challenge",
    );
  }

  // ── Seat / funding ────────────────────────────────────────────────────

  async hasSeat(): Promise<boolean> {
    const r = (await this.json("GET", `/api/seat/${this.address}`)) as {
      has_seat?: boolean;
    };
    return Boolean(r.has_seat);
  }

  async waitForFunding({
    minUsdCents = 100,
    pollMs = 5_000,
    timeoutMs = 600_000,
  }: {
    minUsdCents?: number;
    pollMs?: number;
    timeoutMs?: number;
  } = {}): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const data = (await this.json("GET", "/api/leaderboard?merge=true")) as {
        leaderboard?: Array<{ pubkey: string; usd: string }>;
      };
      for (const entry of data.leaderboard || []) {
        if (entry.pubkey === this.address) {
          const cents = Math.round(parseFloat(entry.usd) * 100);
          if (cents >= minUsdCents) return;
        }
      }
      await new Promise((res) => setTimeout(res, pollMs));
    }
    throw new FundingTimeoutError(
      `address ${this.address} never reached ${minUsdCents} cents on-chain`,
    );
  }

  // ── Invoices ──────────────────────────────────────────────────────────

  /**
   * @deprecated since 0.3.0 — use `AiFinPayAgent.deposit(usd, { asset })`
   * instead. The unified surface picks the chain and asset for you.
   * Kept for back-compat; will not be removed before 1.0.0.
   */
  async reserveSeatInvoice({
    amountUsd,
    asset = "USDC",
  }: {
    amountUsd: number;
    asset?: "SOL" | "USDC" | "USDT";
  }): Promise<Invoice> {
    const endpoint = asset === "SOL" ? "/api/invoice" : "/api/invoice-spl";
    const payload: Record<string, unknown> = {
      amount_usd: amountUsd,
      agent_pubkey: this.address,
    };
    if (asset !== "SOL") payload.asset = asset;
    const data = (await this.json("POST", endpoint, payload)) as Record<
      string,
      unknown
    >;
    return {
      amountUsd,
      treasuryVault: (data.treasury_vault as string) || "",
      programId: (data.program_id as string) || "",
      nonce: (data.nonce as string) || "",
      raw: data,
    };
  }

  // ── Fee-on-top split (b2b_pay_with_split / AiFinPaySplitter) ─────────

  /**
   * Pure-view fee-on-top breakdown — no payment, no auth.
   *
   * Returns merchant amount, treasury fee, IP creator fee, and total —
   * so the agent can decide whether to pay BEFORE building the tx.
   *
   * @deprecated since 0.3.0 — pricing is exposed through the provider
   * registry consumed by `AiFinPayAgent.call()`. Direct on-chain quote
   * is rarely needed anymore. Kept for back-compat through 1.0.0.
   */
  async quoteSplit(args: {
    chain: "solana" | "polygon";
    merchantAmount: bigint | number | string;
    includeCreator?: boolean;
  }): Promise<Record<string, unknown>> {
    const param =
      args.chain === "solana"
        ? "merchant_amount_lamports"
        : "merchant_amount_wei";
    const url = new URL(`${this.baseUrl}/api/b2b/quote-split`);
    url.searchParams.set(param, String(args.merchantAmount));
    if (args.includeCreator) url.searchParams.set("include_creator", "true");
    const r = await this.fetchImpl(url.toString(), {
      headers: { accept: "application/json", "user-agent": SDK_UA },
    });
    if (!r.ok) {
      throw new AiFinPayError(`GET /api/b2b/quote-split → ${r.status}`);
    }
    return (await r.json()) as Record<string, unknown>;
  }

  /**
   * @deprecated since 0.3.0 — use `AiFinPayAgent.call({ provider })`,
   * which selects the chain, builds the tx, and submits it for you.
   * Kept for back-compat through 1.0.0.
   *
   * Get the on-chain instructions for a fee-on-top split payment.
   *
   * The merchant receives `merchantAmount` units (lamports for Solana,
   * wei for Polygon). The treasury fee and optional IP-creator fee are added ON TOP.
   *
   * The SDK does **not** submit the transaction — it's non-custodial.
   * Caller uses the returned `args` + `accounts` (Solana) or
   * `args` + `msg_value_wei` (Polygon) with a chain SDK of choice
   * (`@solana/web3.js`, `viem`, `ethers`, …).
   *
   * Throws `FacilitatorNotImplementedError` if the corresponding splitter
   * is not yet deployed on the requested chain (backend returns 503 with
   * onboarding message).
   */
  async payWithSplitInvoice(args: {
    chain: "solana" | "polygon";
    merchantWallet: string;
    merchantAmount: bigint | number | string;
    orderId: string;
    feeRecipient?: string;
  }): Promise<Record<string, unknown>> {
    const { FacilitatorNotImplementedError } = await import("./errors.js");
    if (!args.orderId || args.orderId.length > 64) {
      throw new AiFinPayError("orderId required, max 64 chars");
    }
    const r = await this.fetchImpl(`${this.baseUrl}/api/b2b/pay-with-split`, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        "user-agent": SDK_UA,
      },
      body: JSON.stringify({
        chain: args.chain,
        agent_pubkey: this.address,
        merchant_wallet: args.merchantWallet,
        merchant_amount: String(args.merchantAmount),
        order_id: args.orderId,
        ...(args.feeRecipient ? { fee_recipient: args.feeRecipient } : {}),
      }),
    });
    if (r.status === 503) {
      let msg = "splitter not deployed";
      try {
        const body = (await r.json()) as { message?: string };
        if (body.message) msg = body.message;
      } catch {
        /* ignore */
      }
      throw new FacilitatorNotImplementedError(msg);
    }
    if (!r.ok) {
      throw new AiFinPayError(`POST /api/b2b/pay-with-split → ${r.status}`);
    }
    return (await r.json()) as Record<string, unknown>;
  }

  // ── Generic x402 — works against any supported facilitator ────────────

  /**
   * HTTP request that auto-handles x402 across multiple facilitators.
   *
   * First sends the request unauthenticated. On 402, detects which
   * facilitator the server speaks (AiFinPay native, Coinbase x402, …),
   * builds the appropriate auth payload, and retries.
   */
  async pay(url: string, init: PayInit = {}): Promise<Response> {
    const {
      method = "GET",
      maxRetries = 1,
      options = {},
      ...rest
    } = init;
    const baseHeaders = mergeHeaders(rest.headers, options.extraHeaders);
    const send = (
      m: string,
      headers: Record<string, string>,
      body?: BodyInit | null,
    ) =>
      this.fetchImpl(url, {
        ...rest,
        method: m,
        headers,
        body: body ?? rest.body,
      });

    let resp = await send(method, { ...baseHeaders, "user-agent": SDK_UA });
    let attempt = 0;

    while (resp.status === 402 && attempt < maxRetries) {
      attempt += 1;
      const facilitator = await detectFacilitator(
        resp,
        options.facilitator ?? "auto",
      );
      const auth = await facilitator.buildAuth(resp, this, options);
      const merged = mergeHeaders(baseHeaders, auth.headers);
      merged["user-agent"] = SDK_UA;
      resp = await send(auth.method ?? method, merged, auth.body);
    }

    if (resp.status === 402) {
      let challenge: string;
      try {
        challenge = JSON.stringify(await resp.clone().json());
      } catch {
        challenge = (await resp.clone().text()).slice(0, 500);
      }
      throw new X402Error(
        `402 Payment Required after ${attempt} retry/retries. ` +
          `Challenge: ${challenge}`,
      );
    }
    return resp;
  }

  // ── Backwards-compat wrappers ────────────────────────────────────────

  async request(
    method: string,
    url: string,
    init: RequestInit = {},
  ): Promise<Response> {
    return this.pay(url, { ...init, method });
  }

  get(url: string, init: PayInit = {}): Promise<Response> {
    return this.pay(url, { ...init, method: "GET" });
  }

  post(url: string, init: PayInit = {}): Promise<Response> {
    return this.pay(url, { ...init, method: "POST" });
  }

  // ── Internal helpers ──────────────────────────────────────────────────

  private async json(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<unknown> {
    const init: RequestInit = {
      method,
      headers: {
        accept: "application/json",
        "user-agent": SDK_UA,
        ...(body ? { "content-type": "application/json" } : {}),
      },
    };
    if (body) init.body = JSON.stringify(body);
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), this.timeoutMs);
    try {
      const r = await this.fetchImpl(this.baseUrl + path, {
        ...init,
        signal: ctrl.signal,
      });
      if (!r.ok) {
        throw new AiFinPayError(`${method} ${path} → ${r.status}`);
      }
      return await r.json();
    } finally {
      clearTimeout(t);
    }
  }
}

function mergeHeaders(
  ...sources: Array<HeadersInit | Record<string, string> | undefined>
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const src of sources) {
    if (!src) continue;
    if (src instanceof Headers) {
      src.forEach((v, k) => (out[k] = v));
    } else if (Array.isArray(src)) {
      for (const [k, v] of src) out[k] = String(v);
    } else {
      Object.assign(out, src);
    }
  }
  return out;
}
