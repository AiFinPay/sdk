import {
  keccak256,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from "viem";

export type SettlementRouteClass = "AIFP-1" | "AIFP-2";
export type SettlementEvmNetwork =
  | "polygon" | "avalanche" | "arbitrum" | "bnb" | "base"
  | "unichain" | "optimism" | "botchain" | "xrplevm";

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
  splitter?: Address;
  splitter_version?: "1.3";
  runtime_code_hash?: Hex;
  disabled_reason?: string;
}

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
    function: "payNative(bytes32,address,uint256,address,uint256,string)";
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
      function: "payStable(bytes32,address,uint256,address,address,uint256,string)";
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

const CHAIN_IDS: Record<SettlementEvmNetwork, number> = {
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

const EXPECTED_BPS: Record<SettlementRouteClass, { treasury: number; creator: number }> = {
  "AIFP-1": { treasury: 100, creator: 0 },
  "AIFP-2": { treasury: 0, creator: 0 },
};

const ZERO = "0x0000000000000000000000000000000000000000" as Address;
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const HASH_RE = /^0x[0-9a-fA-F]{64}$/;
const lc = (v: string) => v.toLowerCase();

const PROFILE_ABI = [
  { type: "function", name: "treasuryBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ipCreatorBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

const V13_ABI = [
  {
    type: "function", name: "payNative", stateMutability: "payable",
    inputs: [
      { type: "bytes32", name: "paymentId" },
      { type: "address", name: "merchant" },
      { type: "uint256", name: "grossAmount" },
      { type: "address", name: "ipCreator" },
      { type: "uint256", name: "validUntil" },
      { type: "string", name: "orderId" },
    ], outputs: [],
  },
  {
    type: "function", name: "payStable", stateMutability: "nonpayable",
    inputs: [
      { type: "bytes32", name: "paymentId" },
      { type: "address", name: "token" },
      { type: "uint256", name: "grossAmount" },
      { type: "address", name: "merchant" },
      { type: "address", name: "ipCreator" },
      { type: "uint256", name: "validUntil" },
      { type: "string", name: "orderId" },
    ], outputs: [],
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

async function responseJson(response: Response): Promise<Record<string, unknown>> {
  let json: unknown;
  try { json = await response.json(); }
  catch { throw new SettlementProtocolError(`settlement API ${response.status}: non-JSON response`); }
  const rec = asJsonRecord(json);
  if (!response.ok) {
    const detail = typeof rec.detail === "string" ? rec.detail
      : typeof rec.reason === "string" ? rec.reason
      : typeof rec.error === "string" ? rec.error
      : `HTTP ${response.status}`;
    throw new SettlementProtocolError(detail, typeof rec.error === "string" ? rec.error : "settlement_http_error");
  }
  return rec;
}

function expectedBreakdown(route: SettlementRouteClass, gross: bigint) {
  const bps = EXPECTED_BPS[route];
  const treasury = gross * BigInt(bps.treasury) / 10_000n;
  const creator = gross * BigInt(bps.creator) / 10_000n;
  if (bps.treasury > 0 && treasury === 0n) {
    throw new SettlementProtocolError("AIFP-1 gross amount is too small for the 1% protocol fee", "amount_too_small");
  }
  const merchant = gross - treasury - creator;
  if (merchant <= 0n) throw new SettlementProtocolError("settlement leaves no merchant amount", "amount_too_small");
  return { gross, merchant, treasury, creator };
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
  if (invoice.fee_on_top !== false || invoice.settlement_semantics !== "gross-inclusive") {
    throw new SettlementProtocolError("fee-on-top or non-gross settlement is not supported");
  }
  if (!Number.isInteger(invoice.valid_until) || invoice.valid_until <= Math.floor(Date.now() / 1000)) {
    throw new SettlementProtocolError("invoice is expired or has invalid valid_until", "invoice_expired");
  }
  if (invoice.valid_until > Math.floor(Date.now() / 1000) + 20 * 60 + 5) {
    throw new SettlementProtocolError("invoice lifetime exceeds the 20-minute safety bound");
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

  if (invoice.transaction.kind === "evm_contract_call") {
    if (invoice.transaction.function !== "payNative(bytes32,address,uint256,address,uint256,string)") {
      throw new SettlementProtocolError("unexpected native v1.3 function signature");
    }
    if (BigInt(invoice.transaction.value) !== gross || BigInt(invoice.transaction.args.grossAmount) !== gross) {
      throw new SettlementProtocolError("native tx value/gross amount mismatch");
    }
  } else {
    if (!ADDRESS_RE.test(invoice.token.address) || lc(invoice.token.address) === ZERO) {
      throw new SettlementProtocolError("invalid stable token address");
    }
    if (lc(invoice.transaction.approve.token) !== lc(invoice.token.address)
      || lc(invoice.transaction.approve.spender) !== lc(invoice.splitter)
      || BigInt(invoice.transaction.approve.amount) !== gross) {
      throw new SettlementProtocolError("stable approval does not match invoice");
    }
    if (invoice.transaction.settle.function !== "payStable(bytes32,address,uint256,address,address,uint256,string)") {
      throw new SettlementProtocolError("unexpected stable v1.3 function signature");
    }
    if (lc(invoice.transaction.settle.args.token) !== lc(invoice.token.address)
      || BigInt(invoice.transaction.settle.args.grossAmount) !== gross) {
      throw new SettlementProtocolError("stable settlement token/gross mismatch");
    }
  }
}

export class SettlementClient {
  readonly baseUrl: string;
  constructor(baseUrl = "https://aifinpay.io") {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  async routes(routeClass?: SettlementRouteClass): Promise<SettlementRoute[]> {
    const q = routeClass ? `?route_class=${encodeURIComponent(routeClass)}` : "";
    const rec = await responseJson(await fetch(`${this.baseUrl}/v1/settlement/routes${q}`));
    if (!Array.isArray(rec.routes)) throw new SettlementProtocolError("routes response has no routes array");
    return rec.routes as unknown as SettlementRoute[];
  }

  async invoice(input: SettlementInvoiceInput): Promise<SettlementInvoice> {
    const rec = await responseJson(await fetch(`${this.baseUrl}/v1/settlement/invoice`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ...input,
        gross_amount: String(input.gross_amount),
      }),
    }));
    const invoice = rec as unknown as SettlementInvoice;
    validateSettlementInvoice(invoice);
    return invoice;
  }
}

/**
 * Verify backend evidence against chain immediately before signing.
 * A compromised/stale backend cannot silently redirect the SDK to arbitrary
 * code or swap AIFP-1 and AIFP-2 economics.
 */
export async function verifySettlementRouteOnChain(
  invoice: SettlementInvoice,
  publicClient: PublicClient,
): Promise<void> {
  validateSettlementInvoice(invoice);
  const actualChainId = await publicClient.getChainId();
  if (actualChainId !== invoice.chain_id) {
    throw new SettlementProtocolError(`connected RPC chainId ${actualChainId} != invoice ${invoice.chain_id}`, "wrong_chain");
  }
  const code = await publicClient.getBytecode({ address: invoice.splitter });
  if (!code || code === "0x") throw new SettlementProtocolError("splitter has no runtime bytecode", "route_not_deployed");
  if (lc(keccak256(code)) !== lc(invoice.runtime_code_hash)) {
    throw new SettlementProtocolError("splitter runtime bytecode hash mismatch", "runtime_hash_mismatch");
  }
  const [treasuryBps, creatorBps] = await Promise.all([
    publicClient.readContract({ address: invoice.splitter, abi: PROFILE_ABI, functionName: "treasuryBps" }),
    publicClient.readContract({ address: invoice.splitter, abi: PROFILE_ABI, functionName: "ipCreatorBps" }),
  ]);
  const expected = EXPECTED_BPS[invoice.route_class];
  if (Number(treasuryBps) !== expected.treasury || Number(creatorBps) !== expected.creator) {
    throw new SettlementProtocolError("on-chain route economics do not match invoice", "profile_mismatch");
  }
}

async function waitSuccess(publicClient: PublicClient, hash: Hex): Promise<bigint> {
  const receipt = await publicClient.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new SettlementProtocolError(`transaction ${hash} reverted`, "transaction_reverted");
  return receipt.blockNumber;
}

/** Execute a pre-validated v1.3 invoice with the caller's wallet. */
export async function executeSettlementInvoice(
  invoice: SettlementInvoice,
  walletClient: WalletClient,
  publicClient: PublicClient,
): Promise<SettlementExecution> {
  await verifySettlementRouteOnChain(invoice, publicClient);
  const account = walletClient.account;
  if (!account) throw new SettlementProtocolError("walletClient has no signing account", "signer_missing");
  const walletChainId = walletClient.chain?.id;
  if (walletChainId != null && walletChainId !== invoice.chain_id) {
    throw new SettlementProtocolError(`wallet chainId ${walletChainId} != invoice ${invoice.chain_id}`, "wrong_chain");
  }

  const approvalTxs: Hex[] = [];
  let settlementTx: Hex;
  if (invoice.transaction.kind === "evm_contract_call") {
    settlementTx = await walletClient.writeContract({
      address: invoice.splitter,
      abi: V13_ABI,
      functionName: "payNative",
      args: [
        invoice.transaction.args.paymentId,
        invoice.transaction.args.merchant,
        BigInt(invoice.transaction.args.grossAmount),
        invoice.transaction.args.ipCreator,
        BigInt(invoice.transaction.args.validUntil),
        invoice.transaction.args.orderId,
      ],
      value: BigInt(invoice.transaction.value),
      account,
      chain: walletClient.chain,
    });
  } else {
    const gross = BigInt(invoice.transaction.approve.amount);
    const allowance = await publicClient.readContract({
      address: invoice.token.address,
      abi: ERC20_ABI,
      functionName: "allowance",
      args: [account.address, invoice.splitter],
    });
    if (allowance < gross) {
      // Reset an existing non-zero allowance first for tokens that implement
      // the historical USDT approve rule. This is conservative and harmless
      // for standard ERC-20 implementations.
      if (allowance > 0n) {
        const reset = await walletClient.writeContract({
          address: invoice.token.address,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [invoice.splitter, 0n],
          account,
          chain: walletClient.chain,
        });
        approvalTxs.push(reset);
        await waitSuccess(publicClient, reset);
      }
      const approve = await walletClient.writeContract({
        address: invoice.token.address,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [invoice.splitter, gross],
        account,
        chain: walletClient.chain,
      });
      approvalTxs.push(approve);
      await waitSuccess(publicClient, approve);
    }
    settlementTx = await walletClient.writeContract({
      address: invoice.splitter,
      abi: V13_ABI,
      functionName: "payStable",
      args: [
        invoice.transaction.settle.args.paymentId,
        invoice.transaction.settle.args.token,
        BigInt(invoice.transaction.settle.args.grossAmount),
        invoice.transaction.settle.args.merchant,
        invoice.transaction.settle.args.ipCreator,
        BigInt(invoice.transaction.settle.args.validUntil),
        invoice.transaction.settle.args.orderId,
      ],
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
