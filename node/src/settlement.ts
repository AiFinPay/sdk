import {
  keccak256,
  stringToHex,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";
import { settlementHttp } from "./settlementHttp.js";

export type SettlementRouteClass = "AIFP-1" | "AIFP-2";
export type SettlementEvmNetwork =
  | "polygon" | "avalanche" | "arbitrum" | "bnb" | "base"
  | "unichain" | "optimism" | "botchain" | "xrplevm" | "amoy";

export interface SettlementRoute {
  route_class: SettlementRouteClass;
  profile: {
    route_class: SettlementRouteClass;
    settlement_semantics: "gross-inclusive";
    treasury_bps: number;
    creator_bps: number;
    fee_on_top: false;
    required_splitter_version: "1.3";
  };
  network: SettlementEvmNetwork;
  chain_id: number;
  name: string;
  native_asset: string;
  stable_assets: Record<string, { address: Address; decimals: number; issuer: string }>;
  explorer: string;
  live: boolean;
  testnet?: boolean;
  splitter?: Address;
  splitter_version?: "1.3";
  runtime_code_hash?: Hex;
  disabled_reason?: string;
}

/**
 * Independent release trust anchor. This value must come from a reviewed SDK
 * release/config artifact, not from the same backend response as the invoice.
 */
export interface TrustedSettlementRoutePin {
  route_class: SettlementRouteClass;
  chain: SettlementEvmNetwork;
  chain_id: number;
  splitter_version: "1.3";
  splitter: Address;
  runtime_code_hash: Hex;
  /** Must be explicitly true for Amoy signing; omitted means mainnet only. */
  testnet?: boolean;
  /** Independently reviewed asset identities; required for stable settlement. */
  stable_assets?: Readonly<Record<string, { address: Address; decimals: number }>>;
}

export type TrustedSettlementRouteRegistry = Partial<Record<SettlementRouteClass, Partial<Record<SettlementEvmNetwork, TrustedSettlementRoutePin>>>>;

export interface SettlementInvoiceInput {
  route_class: SettlementRouteClass;
  chain: SettlementEvmNetwork;
  asset: string;
  gross_amount: string | bigint;
  merchant_wallet?: Address;
  provider_wallet?: Address;
  order_id: string;
  valid_until?: number;
}

interface SettlementBreakdown {
  gross_amount: string;
  merchant_amount: string;
  protocol_fee_amount: string;
  creator_amount: string;
  protocol_fee_bps: number;
  creator_bps: number;
}

interface SettlementInvoiceBase {
  route_class: SettlementRouteClass;
  chain: SettlementEvmNetwork;
  chain_id: number;
  splitter_version: "1.3";
  splitter: Address;
  runtime_code_hash: Hex;
  settlement_semantics: "gross-inclusive";
  fee_on_top: false;
  asset: string;
  payment_id: Hex;
  order_id: string;
  valid_until: number;
  merchant_wallet: Address;
  breakdown: SettlementBreakdown;
  authorization: string;
}

export interface NativeSettlementInvoice extends SettlementInvoiceBase {
  transaction: {
    kind: "evm_contract_call";
    function: "payNative((bytes32,address,uint256,address,uint256,string))";
    args: {
      paymentId: Hex;
      merchant: Address;
      grossAmount: string;
      ipCreator: Address;
      validUntil: number;
      orderId: string;
    };
    value: string;
  };
  token?: never;
}

export interface StableSettlementInvoice extends SettlementInvoiceBase {
  token: { address: Address; decimals: number; issuer: string };
  transaction: {
    kind: "evm_erc20_then_contract_call";
    approve: {
      token: Address;
      function: "approve(address,uint256)";
      spender: Address;
      amount: string;
    };
    settle: {
      function: "payStable((bytes32,address,uint256,address,address,uint256,string))";
      args: {
        paymentId: Hex;
        token: Address;
        grossAmount: string;
        merchant: Address;
        ipCreator: Address;
        validUntil: number;
        orderId: string;
      };
      value: "0";
    };
  };
}

export type SettlementInvoice = NativeSettlementInvoice | StableSettlementInvoice;

export interface SettlementExecution {
  route_class: SettlementRouteClass;
  chain: SettlementEvmNetwork;
  payment_id: Hex;
  approval_txs: Hex[];
  settlement_tx: Hex;
  block_number: bigint;
}

export class SettlementProtocolError extends Error {
  constructor(message: string, public readonly code = "settlement_protocol_error") {
    super(message);
    this.name = "SettlementProtocolError";
  }
}

/** Broadcast succeeded but confirmation is unknown. Keep this hash and check
 * it before retrying; a timeout is not evidence that no money moved. */
export class SettlementConfirmationPendingError extends SettlementProtocolError {
  constructor(public readonly txHash: Hex, public readonly stage: "approval" | "settlement") {
    super(`transaction ${txHash} was broadcast but confirmation is unavailable; recover this transaction before retrying`, "confirmation_pending");
    this.name = "SettlementConfirmationPendingError";
  }
}

const CHAIN_IDS: Record<SettlementEvmNetwork, number> = {
  amoy: 80002,
  polygon: 137,
  avalanche: 43114,
  arbitrum: 42161,
  bnb: 56,
  base: 8453,
  unichain: 130,
  optimism: 10,
  botchain: 677,
  xrplevm: 1440000,
};

const NATIVE_ASSETS: Record<SettlementEvmNetwork, string> = {
  polygon: "POL", amoy: "POL", avalanche: "AVAX", arbitrum: "ETH", bnb: "BNB",
  base: "ETH", unichain: "ETH", optimism: "ETH", botchain: "BOT", xrplevm: "XRP",
};

const EXPECTED_BPS: Record<SettlementRouteClass, { treasury: number; creator: number }> = {
  "AIFP-1": { treasury: 100, creator: 0 },
  "AIFP-2": { treasury: 0, creator: 0 },
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const lc = (value: string) => value.toLowerCase();

const PROFILE_ABI = [
  { type: "function", name: "treasuryBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ipCreatorBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const V13_ABI = [
  {
    type: "function", name: "payNative", stateMutability: "payable",
    inputs: [{ type: "tuple", name: "p", components: [
      { type: "bytes32", name: "paymentId" },
      { type: "address", name: "merchant" },
      { type: "uint256", name: "grossAmount" },
      { type: "address", name: "ipCreator" },
      { type: "uint256", name: "validUntil" },
      { type: "string", name: "orderId" },
    ] }], outputs: [],
  },
  {
    type: "function", name: "payStable", stateMutability: "nonpayable",
    inputs: [{ type: "tuple", name: "p", components: [
      { type: "bytes32", name: "paymentId" },
      { type: "address", name: "token" },
      { type: "uint256", name: "grossAmount" },
      { type: "address", name: "merchant" },
      { type: "address", name: "ipCreator" },
      { type: "uint256", name: "validUntil" },
      { type: "string", name: "orderId" },
    ] }], outputs: [],
  },
] as const;

const ERC20_ABI = [
  { type: "function", name: "allowance", stateMutability: "view", inputs: [{ type: "address", name: "owner" }, { type: "address", name: "spender" }], outputs: [{ type: "uint256" }] },
  { type: "function", name: "approve", stateMutability: "nonpayable", inputs: [{ type: "address", name: "spender" }, { type: "uint256", name: "amount" }], outputs: [{ type: "bool" }] },
] as const;

function asJsonRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new SettlementProtocolError("settlement API returned a non-object JSON document");
  }
  return value as Record<string, unknown>;
}

function responseJson(response: Response, text: string): Record<string, unknown> {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new SettlementProtocolError(`settlement API ${response.status}: non-JSON response`);
  }
  const rec = asJsonRecord(json);
  if (!response.ok) {
    const detail = typeof rec.detail === "string" ? rec.detail
      : typeof rec.reason === "string" ? rec.reason
      : typeof rec.error === "string" ? rec.error
      : `HTTP ${response.status}`;
    throw new SettlementProtocolError(
      detail,
      typeof rec.error === "string" ? rec.error : "settlement_http_error",
    );
  }
  return rec;
}

function expectedBreakdown(route: SettlementRouteClass, gross: bigint) {
  const bps = EXPECTED_BPS[route];
  const treasury = gross * BigInt(bps.treasury) / 10_000n;
  const creator = gross * BigInt(bps.creator) / 10_000n;
  if (bps.treasury > 0 && treasury === 0n) {
    throw new SettlementProtocolError(
      "AIFP-1 gross amount is too small for the 1% protocol fee",
      "amount_too_small",
    );
  }
  const merchant = gross - treasury - creator;
  if (merchant <= 0n) {
    throw new SettlementProtocolError("settlement leaves no merchant amount", "amount_too_small");
  }
  return { gross, merchant, treasury, creator };
}

function isStableInvoice(invoice: SettlementInvoice): invoice is StableSettlementInvoice {
  return invoice.transaction.kind === "evm_erc20_then_contract_call"
    && "token" in invoice
    && invoice.token !== undefined;
}

function assertCommonCallBinding(
  invoice: SettlementInvoice,
  args: { paymentId: Hex; merchant: Address; ipCreator: Address; validUntil: number; orderId: string },
): void {
  if (lc(args.paymentId) !== lc(invoice.payment_id)) {
    throw new SettlementProtocolError("transaction paymentId does not match invoice", "calldata_mismatch");
  }
  if (lc(args.merchant) !== lc(invoice.merchant_wallet)) {
    throw new SettlementProtocolError("transaction merchant does not match invoice", "calldata_mismatch");
  }
  if (lc(args.ipCreator) !== ZERO) {
    throw new SettlementProtocolError("production creator address must be zero", "calldata_mismatch");
  }
  if (args.validUntil !== invoice.valid_until) {
    throw new SettlementProtocolError("transaction validUntil does not match invoice", "calldata_mismatch");
  }
  if (args.orderId !== invoice.order_id) {
    throw new SettlementProtocolError("transaction orderId does not match invoice", "calldata_mismatch");
  }
}

/** Strictly validate an invoice before any wallet signs. */
export function validateSettlementInvoice(invoice: SettlementInvoice): void {
  if (!(invoice.route_class in EXPECTED_BPS)) throw new SettlementProtocolError("unknown route_class");
  if (!(invoice.chain in CHAIN_IDS)) throw new SettlementProtocolError("unknown EVM settlement chain");
  if (invoice.chain_id !== CHAIN_IDS[invoice.chain]) throw new SettlementProtocolError("chain_id does not match chain");
  if (invoice.splitter_version !== "1.3") throw new SettlementProtocolError("only B2BSplitter v1.3 is signable");
  if (!ADDRESS_RE.test(invoice.splitter) || lc(invoice.splitter) === ZERO) throw new SettlementProtocolError("invalid splitter address");
  if (!HASH_RE.test(invoice.runtime_code_hash)) throw new SettlementProtocolError("invalid runtime_code_hash");
  if (!ADDRESS_RE.test(invoice.merchant_wallet) || lc(invoice.merchant_wallet) === ZERO) throw new SettlementProtocolError("invalid merchant_wallet");
  if (!HASH_RE.test(invoice.payment_id)) throw new SettlementProtocolError("invalid payment_id");
  if (typeof invoice.order_id !== "string" || !invoice.order_id.trim() || new TextEncoder().encode(invoice.order_id).length > 256) {
    throw new SettlementProtocolError("order_id must contain 1..256 UTF-8 bytes");
  }
  if (lc(invoice.payment_id) !== keccak256(stringToHex(invoice.order_id)).toLowerCase()) {
    throw new SettlementProtocolError("payment_id must be keccak256(order_id); refusing a replayable invoice", "payment_id_mismatch");
  }
  if (invoice.fee_on_top !== false || invoice.settlement_semantics !== "gross-inclusive") {
    throw new SettlementProtocolError("fee-on-top or non-gross settlement is not supported");
  }
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isInteger(invoice.valid_until) || invoice.valid_until <= now) {
    throw new SettlementProtocolError("invoice is expired or has invalid valid_until", "invoice_expired");
  }
  if (invoice.valid_until > now + 20 * 60 + 5) {
    throw new SettlementProtocolError("invoice lifetime exceeds the 20-minute safety bound");
  }

  for (const amount of [invoice.breakdown.gross_amount, invoice.breakdown.merchant_amount,
    invoice.breakdown.protocol_fee_amount, invoice.breakdown.creator_amount]) {
    if (typeof amount !== "string" || !/^(0|[1-9][0-9]{0,77})$/.test(amount) || BigInt(amount) >= 2n ** 256n) {
      throw new SettlementProtocolError("invoice amount must be a decimal uint256", "invalid_amount");
    }
  }
  const gross = BigInt(invoice.breakdown.gross_amount);
  const expected = expectedBreakdown(invoice.route_class, gross);
  const bps = EXPECTED_BPS[invoice.route_class];
  if (invoice.breakdown.protocol_fee_bps !== bps.treasury || invoice.breakdown.creator_bps !== bps.creator) {
    throw new SettlementProtocolError("invoice bps do not match the canonical route profile");
  }
  if (
    BigInt(invoice.breakdown.merchant_amount) !== expected.merchant
    || BigInt(invoice.breakdown.protocol_fee_amount) !== expected.treasury
    || BigInt(invoice.breakdown.creator_amount) !== expected.creator
  ) {
    throw new SettlementProtocolError("invoice breakdown does not match canonical gross split");
  }

  if (isStableInvoice(invoice)) {
    if (!["USDC", "USDT"].includes(invoice.asset) || !Number.isInteger(invoice.token.decimals) || invoice.token.decimals < 0 || invoice.token.decimals > 18) {
      throw new SettlementProtocolError("invalid stable asset identity");
    }
    if (!ADDRESS_RE.test(invoice.token.address) || lc(invoice.token.address) === ZERO) {
      throw new SettlementProtocolError("invalid stable token address");
    }
    if (
      lc(invoice.transaction.approve.token) !== lc(invoice.token.address)
      || lc(invoice.transaction.approve.spender) !== lc(invoice.splitter)
      || BigInt(invoice.transaction.approve.amount) !== gross
    ) {
      throw new SettlementProtocolError("stable approval does not match invoice");
    }
    if (invoice.transaction.settle.function !== "payStable((bytes32,address,uint256,address,address,uint256,string))") {
      throw new SettlementProtocolError("unexpected stable v1.3 function signature");
    }
    if (
      lc(invoice.transaction.settle.args.token) !== lc(invoice.token.address)
      || BigInt(invoice.transaction.settle.args.grossAmount) !== gross
      || invoice.transaction.settle.value !== "0"
    ) {
      throw new SettlementProtocolError("stable settlement token/gross/value mismatch");
    }
    assertCommonCallBinding(invoice, invoice.transaction.settle.args);
    return;
  }

  if (invoice.asset !== NATIVE_ASSETS[invoice.chain]) throw new SettlementProtocolError("native asset does not match the requested chain");
  if (invoice.transaction.function !== "payNative((bytes32,address,uint256,address,uint256,string))") {
    throw new SettlementProtocolError("unexpected native v1.3 function signature");
  }
  if (BigInt(invoice.transaction.value) !== gross || BigInt(invoice.transaction.args.grossAmount) !== gross) {
    throw new SettlementProtocolError("native tx value/gross amount mismatch");
  }
  assertCommonCallBinding(invoice, invoice.transaction.args);
}

/** Verify that a backend invoice matches an independently trusted release pin. */
export function validateTrustedSettlementRoutePin(
  invoice: SettlementInvoice,
  pin: TrustedSettlementRoutePin,
): void {
  validateSettlementInvoice(invoice);
  if ((pin.chain === "amoy") !== (pin.testnet === true)) {
    throw new SettlementProtocolError("testnet signing requires an explicit matching testnet pin", "trusted_pin_invalid");
  }
  if (isStableInvoice(invoice)) {
    const asset = pin.stable_assets?.[invoice.asset];
    if (!asset || lc(asset.address) !== lc(invoice.token.address) || asset.decimals !== invoice.token.decimals) {
      throw new SettlementProtocolError("stable asset does not match the independent token pin", "trusted_asset_mismatch");
    }
  }
  if (!(pin.chain in CHAIN_IDS) || pin.chain_id !== CHAIN_IDS[pin.chain]) {
    throw new SettlementProtocolError("trusted route pin has an invalid chain binding", "trusted_pin_invalid");
  }
  if (pin.splitter_version !== "1.3") {
    throw new SettlementProtocolError("trusted route pin is not v1.3", "trusted_pin_invalid");
  }
  if (!ADDRESS_RE.test(pin.splitter) || lc(pin.splitter) === ZERO || !HASH_RE.test(pin.runtime_code_hash)) {
    throw new SettlementProtocolError("trusted route pin has invalid address/hash", "trusted_pin_invalid");
  }
  if (
    pin.route_class !== invoice.route_class
    || pin.chain !== invoice.chain
    || pin.chain_id !== invoice.chain_id
    || pin.splitter_version !== invoice.splitter_version
    || lc(pin.splitter) !== lc(invoice.splitter)
    || lc(pin.runtime_code_hash) !== lc(invoice.runtime_code_hash)
  ) {
    throw new SettlementProtocolError(
      "backend invoice route does not match the independently trusted deployment pin",
      "trusted_pin_mismatch",
    );
  }
}

export interface SettlementClientOptions {
  baseUrl?: string;
  /** Supply the caller's guarded transport, e.g. MCP's safe fetch. */
  fetchImpl?: typeof fetch;
  /** Covers the response body as well as the HTTP request. Default 15 seconds. */
  timeoutMs?: number;
}

export class SettlementClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: string | SettlementClientOptions = {}) {
    const opts = typeof options === "string" ? { baseUrl: options } : options;
    const base = new URL(opts.baseUrl ?? "https://aifinpay.io");
    if (!["http:", "https:"].includes(base.protocol) || base.username || base.password || base.search || base.hash) {
      throw new SettlementProtocolError("invalid settlement API base URL");
    }
    this.baseUrl = base.toString().replace(/\/+$/, "");
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs <= 0 || this.timeoutMs > 2_147_483_647) {
      throw new SettlementProtocolError("timeoutMs must be a positive timer duration");
    }
  }

  private async request(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
    const url = `${this.baseUrl}${path}`;
    const { response, text } = await settlementHttp(this.fetchImpl, url, init, this.timeoutMs);
    return responseJson(response, text);
  }

  async routes(routeClass?: SettlementRouteClass): Promise<SettlementRoute[]> {
    const q = routeClass ? `?route_class=${encodeURIComponent(routeClass)}` : "";
    const rec = await this.request(`/v1/settlement/routes${q}`);
    if (!Array.isArray(rec.routes)) {
      throw new SettlementProtocolError("routes response has no routes array");
    }
    return rec.routes as unknown as SettlementRoute[];
  }

  async invoice(input: SettlementInvoiceInput): Promise<SettlementInvoice> {
    const rec = await this.request("/v1/settlement/invoice", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ...input, gross_amount: String(input.gross_amount) }),
    });
    const invoice = rec as unknown as SettlementInvoice;
    validateSettlementInvoice(invoice);
    const recipient = input.merchant_wallet ?? input.provider_wallet;
    if (invoice.route_class !== input.route_class || invoice.chain !== input.chain || invoice.asset !== input.asset.toUpperCase()
      || BigInt(invoice.breakdown.gross_amount) !== BigInt(input.gross_amount) || invoice.order_id !== input.order_id
      || !recipient || lc(invoice.merchant_wallet) !== lc(recipient)
      || (input.valid_until !== undefined && invoice.valid_until !== input.valid_until)) {
      throw new SettlementProtocolError("invoice differs from the requested payment", "invoice_request_mismatch");
    }
    return invoice;
  }
}

/** Verify trusted deployment evidence against chain immediately before signing. */
export async function verifySettlementRouteOnChain(
  invoice: SettlementInvoice,
  publicClient: PublicClient,
  trustedPin: TrustedSettlementRoutePin,
): Promise<void> {
  validateTrustedSettlementRoutePin(invoice, trustedPin);
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== trustedPin.chain_id) {
    throw new SettlementProtocolError(
      `connected RPC chainId ${actualChainId} != trusted pin ${trustedPin.chain_id}`,
      "wrong_chain",
    );
  }
  const code = await publicClient.getBytecode({ address: trustedPin.splitter });
  if (!code || code === "0x") {
    throw new SettlementProtocolError("trusted splitter has no runtime bytecode", "route_not_deployed");
  }
  if (lc(keccak256(code)) !== lc(trustedPin.runtime_code_hash)) {
    throw new SettlementProtocolError("trusted splitter runtime bytecode hash mismatch", "runtime_hash_mismatch");
  }
  const [treasuryBps, creatorBps] = await Promise.all([
    publicClient.readContract({ address: trustedPin.splitter, abi: PROFILE_ABI, functionName: "treasuryBps" }),
    publicClient.readContract({ address: trustedPin.splitter, abi: PROFILE_ABI, functionName: "ipCreatorBps" }),
  ]);
  const expected = EXPECTED_BPS[trustedPin.route_class];
  if (Number(treasuryBps) !== expected.treasury || Number(creatorBps) !== expected.creator) {
    throw new SettlementProtocolError("on-chain route economics do not match trusted route class", "profile_mismatch");
  }
}

async function waitSuccess(publicClient: PublicClient, hash: Hex, stage: "approval" | "settlement" = "settlement"): Promise<bigint> {
  let receipt;
  try {
    receipt = await publicClient.waitForTransactionReceipt({ hash });
  } catch {
    throw new SettlementConfirmationPendingError(hash, stage);
  }
  if (receipt.status !== "success") {
    throw new SettlementProtocolError(`transaction ${hash} reverted`, "transaction_reverted");
  }
  return receipt.blockNumber;
}

/** Execute a v1.3 invoice only after matching an independent trusted route pin. */
export async function executeSettlementInvoice(
  invoice: SettlementInvoice,
  walletClient: WalletClient,
  publicClient: PublicClient,
  trustedPin: TrustedSettlementRoutePin,
): Promise<SettlementExecution> {
  await verifySettlementRouteOnChain(invoice, publicClient, trustedPin);
  const account = walletClient.account;
  if (!account) {
    throw new SettlementProtocolError("walletClient has no signing account", "signer_missing");
  }
  const walletChainId = await walletClient.getChainId();
  if (walletChainId !== trustedPin.chain_id || walletClient.chain?.id !== trustedPin.chain_id) {
    throw new SettlementProtocolError(
      `wallet chainId ${walletChainId} != trusted pin ${trustedPin.chain_id}`,
      "wrong_chain",
    );
  }

  const approvalTxs: Hex[] = [];
  let settlementTx: Hex;

  if (isStableInvoice(invoice)) {
    const gross = BigInt(invoice.transaction.approve.amount);
    const allowance = await publicClient.readContract({
      address: invoice.token.address,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, trustedPin.splitter],
    });

    if (allowance < gross) {
      if (allowance > 0n) {
        const reset = await walletClient.writeContract({
          address: invoice.token.address,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [trustedPin.splitter, 0n],
          account,
          chain: walletClient.chain,
        });
        approvalTxs.push(reset);
        await waitSuccess(publicClient, reset, "approval");
      }
      const approve = await walletClient.writeContract({
        address: invoice.token.address,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [trustedPin.splitter, gross],
        account,
        chain: walletClient.chain,
      });
      approvalTxs.push(approve);
      await waitSuccess(publicClient, approve, "approval");
    }

    settlementTx = await walletClient.writeContract({
      address: trustedPin.splitter,
      abi: V13_ABI,
      functionName: "payStable",
      args: [{
        paymentId: invoice.transaction.settle.args.paymentId,
        token: invoice.transaction.settle.args.token,
        grossAmount: BigInt(invoice.transaction.settle.args.grossAmount),
        merchant: invoice.transaction.settle.args.merchant,
        ipCreator: invoice.transaction.settle.args.ipCreator,
        validUntil: BigInt(invoice.transaction.settle.args.validUntil),
        orderId: invoice.transaction.settle.args.orderId,
      }],
      account,
      chain: walletClient.chain,
    });
  } else {
    settlementTx = await walletClient.writeContract({
      address: trustedPin.splitter,
      abi: V13_ABI,
      functionName: "payNative",
      args: [{
        paymentId: invoice.transaction.args.paymentId,
        merchant: invoice.transaction.args.merchant,
        grossAmount: BigInt(invoice.transaction.args.grossAmount),
        ipCreator: invoice.transaction.args.ipCreator,
        validUntil: BigInt(invoice.transaction.args.validUntil),
        orderId: invoice.transaction.args.orderId,
      }],
      value: BigInt(invoice.transaction.value),
      account,
      chain: walletClient.chain,
    });
  }

  const blockNumber = await waitSuccess(publicClient, settlementTx);
  return {
    route_class: invoice.route_class,
    chain: invoice.chain,
    payment_id: invoice.payment_id,
    approval_txs: approvalTxs,
    settlement_tx: settlementTx,
    block_number: blockNumber,
  };
}

export const SETTLEMENT_CHAIN_IDS = Object.freeze({ ...CHAIN_IDS });
export const SETTLEMENT_EXPECTED_BPS = Object.freeze({ ...EXPECTED_BPS });
