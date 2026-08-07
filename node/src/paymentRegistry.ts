import { getAddress, isAddress, keccak256 } from "viem";
import { UntrustedPaymentTargetError } from "./errors.js";

export interface TrustedPaymentTarget {
  chainId: number;
  version: "1.1" | "1.2" | "1.3";
  splitter: `0x${string}`;
  runtimeCodeHash: `0x${string}`;
  treasury: `0x${string}`;
  treasuryBps: number;
  ipCreatorBps: number;
  enabled: boolean;
  validFrom: string;
  validUntil: string;
  /** Operator-controlled native/USD oracle input used by the pre-sign guard. */
  nativeUsdEnv?: string;
}

export interface QuotedNativePayment {
  chain?: string;
  splitter?: string;
  splitter_version?: string;
  merchant_wallet?: string;
  total_wei?: string;
  merchant_amount_wei?: string;
  treasury_amount_wei?: string;
  ip_creator_amount_wei?: string;
  ip_creator?: string;
  order_id?: string;
  function_signature?: string;
  ttl_seconds?: number;
}

export interface ValidatedNativePayment {
  splitter: `0x${string}`;
  merchant: `0x${string}`;
  ipCreator: `0x${string}`;
  totalWei: bigint;
  merchantAmountWei: bigint;
  treasuryAmountWei: bigint;
  ipCreatorAmountWei: bigint;
  orderId: string;
  version: "1.3";
}

function reject(reason: string): never {
  throw new UntrustedPaymentTargetError(`[PAY_TARGET_UNTRUSTED] ${reason}`);
}

function sameAddress(actual: unknown, expected: string): boolean {
  return typeof actual === "string" && isAddress(actual) && getAddress(actual) === getAddress(expected);
}

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    reject(`${label}_invalid`);
  }
  return BigInt(value);
}

/**
 * C-2 fail-closed gate.
 *
 * A payment cap expressed in USD is not a cap if the SDK cannot determine the
 * USD value of the native-token amount. For every enabled native settlement
 * target we therefore require an explicit positive operator-controlled
 * native/USD value before a quote can reach signing.
 */
export function requireNativeUsdPrice(target: TrustedPaymentTarget): number {
  const envName = target.nativeUsdEnv;
  if (!envName) reject("native_price_policy_missing");
  const raw = process.env[envName];
  const value = raw === undefined ? Number.NaN : Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    reject(`native_price_unavailable:${envName}`);
  }
  return value;
}

/**
 * Validate a bridge-controlled native payment quote against an operator-owned
 * deployment record before any calldata is constructed.
 *
 * v1.1/v1.2 are deliberately rejected. Their native entrypoint interprets the
 * transferred total as fee-inclusive, which underpays a merchant relative to
 * the current fee-on-top product rule. Only v1.3 may reach signing: the quote
 * must state the merchant amount explicitly and the SDK recomputes every fee
 * component and the exact total from canonical BPS values.
 */
export function validateQuotedNativePayment(
  chain: string,
  quote: QuotedNativePayment,
  target: TrustedPaymentTarget,
  registeredMerchant: string,
  nowMs = Date.now(),
): ValidatedNativePayment {
  if (!target.enabled) reject("route_disabled");
  if (target.version !== "1.3") reject("fee_inclusive_splitter_disabled");
  const validFrom = Date.parse(target.validFrom);
  const validUntil = Date.parse(target.validUntil);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil) || validFrom >= validUntil) {
    reject("registry_window_invalid");
  }
  if (nowMs < validFrom || nowMs >= validUntil) reject("registry_entry_expired");

  requireNativeUsdPrice(target);

  if (quote.chain !== chain) reject("chain_mismatch");
  if (!sameAddress(quote.splitter, target.splitter)) reject("splitter_not_registered");
  if (quote.splitter_version !== "1.3") reject("version_mismatch");
  if (!sameAddress(quote.merchant_wallet, registeredMerchant)) reject("merchant_mismatch");
  if (!quote.order_id || typeof quote.order_id !== "string" || quote.order_id.length > 256) {
    reject("order_id_invalid");
  }
  if (
    quote.function_signature !== undefined &&
    quote.function_signature !== "payNative(bytes32,address,uint256,address,string)"
  ) {
    reject("function_signature_mismatch");
  }
  if (quote.ip_creator !== undefined && !sameAddress(quote.ip_creator, target.treasury)) {
    reject("ip_creator_not_registered");
  }

  const merchantAmountWei = uint(quote.merchant_amount_wei, "merchant_amount_wei");
  if (merchantAmountWei === 0n) reject("merchant_amount_wei_zero");
  const treasuryAmountWei =
    (merchantAmountWei * BigInt(target.treasuryBps)) / 10_000n;
  const ipCreatorAmountWei =
    (merchantAmountWei * BigInt(target.ipCreatorBps)) / 10_000n;
  if (treasuryAmountWei === 0n) reject("merchant_amount_below_fee_floor");
  const totalWei = merchantAmountWei + treasuryAmountWei + ipCreatorAmountWei;

  const suppliedTotal = uint(quote.total_wei, "total_wei");
  if (suppliedTotal !== totalWei) reject("total_wei_mismatch");

  const components: Array<[unknown, bigint, string]> = [
    [quote.treasury_amount_wei, treasuryAmountWei, "treasury_amount_wei"],
    [quote.ip_creator_amount_wei, ipCreatorAmountWei, "ip_creator_amount_wei"],
  ];
  for (const [supplied, expected, label] of components) {
    if (supplied === undefined || uint(supplied, label) !== expected) {
      reject(`${label}_mismatch`);
    }
  }

  return {
    splitter: target.splitter,
    merchant: getAddress(registeredMerchant) as `0x${string}`,
    ipCreator: target.treasury,
    totalWei,
    merchantAmountWei,
    treasuryAmountWei,
    ipCreatorAmountWei,
    orderId: quote.order_id,
    version: "1.3",
  };
}

export interface TargetReader {
  getChainId(): Promise<number>;
  getBytecode(args: { address: `0x${string}` }): Promise<`0x${string}` | undefined>;
  readContract(args: Record<string, unknown>): Promise<unknown>;
}

const TARGET_ABI = [
  { type: "function", name: "treasury", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "owner", stateMutability: "view", inputs: [], outputs: [{ type: "address" }] },
  { type: "function", name: "treasuryBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
  { type: "function", name: "ipCreatorBps", stateMutability: "view", inputs: [], outputs: [{ type: "uint256" }] },
] as const;

export async function validateRuntimePaymentTarget(
  reader: TargetReader,
  target: TrustedPaymentTarget,
): Promise<void> {
  let chainId: number;
  let code: `0x${string}` | undefined;
  try {
    chainId = await reader.getChainId();
    code = await reader.getBytecode({ address: target.splitter });
  } catch {
    reject("rpc_unavailable");
  }
  if (chainId !== target.chainId) reject("rpc_chain_mismatch");
  if (!code || code === "0x") reject("splitter_has_no_code");
  if (keccak256(code) !== target.runtimeCodeHash) reject("runtime_codehash_mismatch");

  let treasury: unknown;
  let owner: unknown;
  let treasuryBps: unknown;
  let ipCreatorBps: unknown;
  try {
    [treasury, owner, treasuryBps, ipCreatorBps] = await Promise.all(
      ["treasury", "owner", "treasuryBps", "ipCreatorBps"].map((functionName) =>
        reader.readContract({ address: target.splitter, abi: TARGET_ABI, functionName }),
      ),
    );
  } catch {
    reject("contract_introspection_failed");
  }
  if (!sameAddress(treasury, target.treasury)) reject("treasury_mismatch");
  if (!sameAddress(owner, target.treasury)) reject("governance_not_approved");
  if (Number(treasuryBps) !== target.treasuryBps) reject("treasury_fee_mismatch");
  if (Number(ipCreatorBps) !== target.ipCreatorBps) reject("royalty_fee_mismatch");
}
