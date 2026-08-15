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

/**
 * Product route is chosen by the SDK entry point, never by untrusted 402 input.
 */
export type RouteClass = "agent-x402" | "merchant-aifp1";

export const ROUTE_FEE_PROFILES: Record<
  RouteClass,
  { treasuryBps: number; ipCreatorBps: number }
> = {
  "agent-x402": { treasuryBps: 0, ipCreatorBps: 0 },
  "merchant-aifp1": { treasuryBps: 100, ipCreatorBps: 0 },
};

export interface QuotedNativePayment {
  chain?: string;
  splitter?: string;
  splitter_version?: string;
  merchant_wallet?: string;
  /** Full payer amount. Current v1.3 fees are split FROM this gross value. */
  total_wei?: string;
  merchant_amount_wei?: string;
  treasury_amount_wei?: string;
  ip_creator_amount_wei?: string;
  ip_creator?: string;
  order_id?: string;
  function_signature?: string;
  /** Unix seconds; must be the same value passed to v1.3 validUntil. */
  valid_until?: string;
  ttl_seconds?: number;
}

export interface ValidatedNativePayment {
  splitter: `0x${string}`;
  merchant: `0x${string}`;
  ipCreator: `0x${string}`;
  grossAmountWei: bigint;
  /** Alias retained for callers; under gross-inclusive v1.3 total == gross. */
  totalWei: bigint;
  merchantAmountWei: bigint;
  treasuryAmountWei: bigint;
  ipCreatorAmountWei: bigint;
  validUntil: bigint;
  orderId: string;
  version: "1.3";
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as const;
const BPS_DENOMINATOR = 10_000n;
const V13_NATIVE_SIGNATURE = "payNative(bytes32,address,uint256,address,uint256,string)";

function reject(reason: string): never {
  throw new UntrustedPaymentTargetError(`[PAY_TARGET_UNTRUSTED] ${reason}`);
}

function sameAddress(actual: unknown, expected: string): boolean {
  return (
    typeof actual === "string" &&
    isAddress(actual) &&
    getAddress(actual) === getAddress(expected)
  );
}

function uint(value: unknown, label: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) {
    reject(`${label}_invalid`);
  }
  return BigInt(value);
}

/**
 * A USD cap is not meaningful if the SDK cannot value the native amount.
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
 * Validate a bridge-controlled v1.3 native quote against the operator-owned
 * registry before calldata is constructed.
 *
 * Current v1.3 semantics are gross-inclusive for every route profile:
 *
 *   gross = merchant + treasury + creator
 *
 * AIFP-1 uses 100/0 and AIFP-2/x402 uses 0/0. No fee is added above gross.
 */
export function validateQuotedNativePayment(
  chain: string,
  quote: QuotedNativePayment,
  target: TrustedPaymentTarget,
  registeredMerchant: string,
  routeClass: RouteClass,
  nowMs = Date.now(),
): ValidatedNativePayment {
  if (!target.enabled) reject("route_disabled");
  if (target.version !== "1.3") reject("legacy_splitter_disabled");

  const registryFrom = Date.parse(target.validFrom);
  const registryUntil = Date.parse(target.validUntil);
  if (
    !Number.isFinite(registryFrom) ||
    !Number.isFinite(registryUntil) ||
    registryFrom >= registryUntil
  ) {
    reject("registry_window_invalid");
  }
  if (nowMs < registryFrom || nowMs >= registryUntil) {
    reject("registry_entry_expired");
  }

  requireNativeUsdPrice(target);

  if (quote.chain !== chain) reject("chain_mismatch");
  if (!sameAddress(quote.splitter, target.splitter)) {
    reject("splitter_not_registered");
  }
  if (quote.splitter_version !== "1.3") reject("version_mismatch");
  if (!sameAddress(quote.merchant_wallet, registeredMerchant)) {
    reject("merchant_mismatch");
  }
  if (
    !quote.order_id ||
    typeof quote.order_id !== "string" ||
    quote.order_id.length > 256
  ) {
    reject("order_id_invalid");
  }
  if (
    quote.function_signature !== undefined &&
    quote.function_signature !== V13_NATIVE_SIGNATURE
  ) {
    reject("function_signature_mismatch");
  }

  const approvedProfile = ROUTE_FEE_PROFILES[routeClass];
  if (!approvedProfile) reject("route_class_unknown");
  if (
    target.treasuryBps !== approvedProfile.treasuryBps ||
    target.ipCreatorBps !== approvedProfile.ipCreatorBps
  ) {
    reject(`route_fee_profile_mismatch:${routeClass}`);
  }

  const grossAmountWei = uint(quote.total_wei, "total_wei");
  if (grossAmountWei === 0n) reject("total_wei_zero");

  const treasuryAmountWei =
    (grossAmountWei * BigInt(target.treasuryBps)) / BPS_DENOMINATOR;
  const ipCreatorAmountWei =
    (grossAmountWei * BigInt(target.ipCreatorBps)) / BPS_DENOMINATOR;

  if (target.treasuryBps > 0 && treasuryAmountWei === 0n) {
    reject("gross_amount_below_fee_floor");
  }
  if (target.ipCreatorBps > 0 && ipCreatorAmountWei === 0n) {
    reject("gross_amount_below_fee_floor");
  }

  const merchantAmountWei =
    grossAmountWei - treasuryAmountWei - ipCreatorAmountWei;
  if (merchantAmountWei <= 0n) reject("merchant_amount_wei_zero");

  const components: Array<[unknown, bigint, string]> = [
    [quote.merchant_amount_wei, merchantAmountWei, "merchant_amount_wei"],
    [quote.treasury_amount_wei, treasuryAmountWei, "treasury_amount_wei"],
    [quote.ip_creator_amount_wei, ipCreatorAmountWei, "ip_creator_amount_wei"],
  ];
  for (const [supplied, expected, label] of components) {
    if (supplied !== undefined && uint(supplied, label) !== expected) {
      reject(`${label}_mismatch`);
    }
  }

  const validUntil = uint(quote.valid_until, "valid_until");
  const nowSeconds = BigInt(Math.floor(nowMs / 1000));
  if (validUntil <= nowSeconds) reject("quote_expired");
  const registryUntilSeconds = BigInt(Math.floor(registryUntil / 1000));
  if (validUntil > registryUntilSeconds) reject("quote_beyond_registry_window");

  // Creator is zero for both current route profiles. Use address(0), not the
  // treasury address, so calldata cannot accidentally imply a creator leg.
  if (quote.ip_creator !== undefined && !sameAddress(quote.ip_creator, ZERO_ADDRESS)) {
    reject("ip_creator_not_zero");
  }

  return {
    splitter: target.splitter,
    merchant: getAddress(registeredMerchant) as `0x${string}`,
    ipCreator: ZERO_ADDRESS,
    grossAmountWei,
    totalWei: grossAmountWei,
    merchantAmountWei,
    treasuryAmountWei,
    ipCreatorAmountWei,
    validUntil,
    orderId: quote.order_id,
    version: "1.3",
  };
}

export interface TargetReader {
  getChainId(): Promise<number>;
  getBytecode(args: {
    address: `0x${string}`;
  }): Promise<`0x${string}` | undefined>;
  readContract(args: Record<string, unknown>): Promise<unknown>;
}

const TARGET_ABI = [
  {
    type: "function",
    name: "treasury",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "owner",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "address" }],
  },
  {
    type: "function",
    name: "treasuryBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
  {
    type: "function",
    name: "ipCreatorBps",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256" }],
  },
] as const;

/**
 * Bind the registry record to the actual deployed runtime and fee profile.
 */
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
  if (keccak256(code) !== target.runtimeCodeHash) {
    reject("runtime_codehash_mismatch");
  }

  let treasury: unknown;
  let owner: unknown;
  let treasuryBps: unknown;
  let ipCreatorBps: unknown;
  try {
    [treasury, owner, treasuryBps, ipCreatorBps] = await Promise.all(
      ["treasury", "owner", "treasuryBps", "ipCreatorBps"].map(
        (functionName) =>
          reader.readContract({
            address: target.splitter,
            abi: TARGET_ABI,
            functionName,
          }),
      ),
    );
  } catch {
    reject("contract_introspection_failed");
  }

  if (!sameAddress(treasury, target.treasury)) reject("treasury_mismatch");
  if (!sameAddress(owner, target.treasury)) reject("governance_not_approved");
  if (Number(treasuryBps) !== target.treasuryBps) {
    reject("treasury_fee_mismatch");
  }
  if (Number(ipCreatorBps) !== target.ipCreatorBps) {
    reject("royalty_fee_mismatch");
  }
}

export { V13_NATIVE_SIGNATURE };
